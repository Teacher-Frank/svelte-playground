#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# deploy-cloudinit-snippets.sh
#
# One-time setup script for Proxmox host. Deploys a cloud-init user-data
# snippet to the Proxmox snippets storage so that VMs cloned from templates
# can use cicustom to install qemu-guest-agent on first boot.
#
# Environment:
#   PVE_SNIPPET_STORAGE  Proxmox storage ID for snippets (default: local)
#
# Usage:
#   sudo bash deploy-cloudinit-snippets.sh
#   PVE_SNIPPET_STORAGE=fast-ssd sudo bash deploy-cloudinit-snippets.sh
###############################################################################

SNIPPET_DIR="/var/lib/vz/snippets"
SNIPPET_STORAGE="${PVE_SNIPPET_STORAGE:-local}"

# ── colour helpers ──────────────────────────────────────────────────────────
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
yellow(){ printf '\033[1;33m%s\033[0m\n' "$*"; }
red()   { printf '\033[1;31m%s\033[0m\n' "$*"; }

# ── prerequisites ───────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
  red "This script must be run as root (use sudo)."
  exit 1
fi

command -v pvesh &>/dev/null || ! command -v pvenode &>/dev/null || true

# ── ensure snippets directory exists ────────────────────────────────────────
bold "Step 1: Ensuring \$SNIPPET_DIR exists"
mkdir -p "$SNIPPET_DIR"
green "  \$SNIPPET_DIR ready."

# ── create the install-agent.yaml snippet ───────────────────────────────────
bold "Step 2: Deploying install-agent.yaml cloud-init snippet"

cat > "$SNIPPET_DIR/install-agent.yaml" <<'CLOUD-INIT'
#cloud-config
# Cloud-init vendor-data snippet for Proxmox cicustom (vendor=).
# Installed by playground scripts/host/deploy-cloudinit-snippets.sh
#
# On first boot this:
#   1. Installs & enables qemu-guest-agent
#   2. Enables serial console getty (required for terminal access)
#   3. Converts the DHCP-assigned IP to static so it survives restarts.
#
# Usage in VM config (or deploy code):
#   cicustom: vendor=${SNIPPET_STORAGE}:snippets/install-agent.yaml

runcmd:
  # 1. Install qemu-guest-agent if not already present, then enable it.
  - |
    set -e && \
    if [ ! -f /usr/sbin/qemu-ga ]; then \
      apt-get update -qq && \
      apt-get install -y qemu-guest-agent; \
    fi && \
    systemctl enable --now qemu-guest-agent

  # 2. Enable serial console getty — required for terminal access via termproxy.
  #    Without this, the serial port connects but shows no login prompt.
  #    Idempotent: systemctl enable is safe to re-run.
  - |
    systemctl enable --now serial-getty@ttyS0.service 2>/dev/null || true

  # 3. Convert DHCP→static IP on first boot.
  # - Waits for eth0 to have an IP, reads gateway from route table.
  # - Rewrites the netplan YAML (dhcp4: false + addresses + routes + nameservers).
  # - Idempotent: skips if the interface is already static.
  - |
    set -e
    INTERFACE="eth0"
    MAX_WAIT=30
    for i in $(seq 1 $MAX_WAIT); do
      IP=$(ip -4 addr show "$INTERFACE" 2>/dev/null | awk '/inet /{print $2}' | grep -v '127\.')
      if [ -n "$IP" ]; then break; fi
      sleep 1
    done

    # Abort if no usable IP yet.
    if [ -z "$IP" ]; then exit 0; fi

    # Abort if already static.
    for f in /etc/netplan/*.yaml; do
      grep -q "dhcp4: false" "$f" && exit 0
    done

    # Abort if no DHCP config to replace.
    NETPLAN_FILE=$(grep -l "dhcp4: true" /etc/netplan/*.yaml 2>/dev/null | head -1)
    if [ -z "$NETPLAN_FILE" ]; then exit 0; fi

    GATEWAY=$(ip route show default 2>/dev/null | awk '/default/{print $3}' | head -1)
    if [ -z "$GATEWAY" ]; then exit 0; fi

    MAC=$(ip link show "$INTERFACE" 2>/dev/null | awk '/link\/ether/{print $2}')

    cat > "$NETPLAN_FILE" <<EOF
#cloud-config
network:
  version: 2
  ethernets:
    eth0:
      match:
        macaddress: "${MAC}"
      dhcp4: false
      addresses:
        - "${IP}/24"
      routes:
        - to: default
          via: "${GATEWAY}"
      nameservers:
        addresses:
          - 1.1.1.1
          - 8.8.8.8
      set-name: eth0
EOF

    netplan apply 2>/dev/null || true
CLOUD-INIT

chmod 644 "$SNIPPET_DIR/install-agent.yaml"
green "  $SNIPPET_DIR/install-agent.yaml deployed."

# ── verify the snippets storage is available in Proxmox ─────────────────────
bold "Step 3: Checking Proxmox snippets storage"

if ! command -v pvesh &>/dev/null && ! command -v pvesm &>/dev/null; then
  yellow "  pvesh/pvesm not found — skipping snippets storage check."
  yellow "  This is expected if running outside the Proxmox shell."
  exit 0
fi

bold "  Storage overview:"
pvesm status 2>/dev/null | while IFS= read -r line; do
  bold "    $line"
done

# ── check content types in storage config ──────────────────────────────────
if [ -f /etc/pve/storage.cfg ]; then
  STORAGE_CFG="/etc/pve/storage.cfg"
  bold "  Checking content types in $STORAGE_CFG for '$SNIPPET_STORAGE':"

  # Extract the storage block for our storage ID and look for content line
  IN_BLOCK=0
  CONTENT_TYPES=""
  while IFS= read -r line; do
    # Match start of storage block
    if echo "$line" | grep -q "^nwfs \|^\s*nfs \|^\s*dir \|^\s*lvmthin \|^\s*pbs \|^\s*zfs \|^\s*lvm \|^\s*fc \|^\s*iscsi \|^\s*cifs \|^\s*btrfs \|^\s*glusterfs \|^\s*pveges \|^"; then
      # Check if this line contains our storage ID
      STORAGE_LINE=$(echo "$line" | sed -E 's/^\s*//')
      STORAGE_ID=$(echo "$STORAGE_LINE" | awk '{print $NF}')
      if [ "$STORAGE_ID" = "$SNIPPET_STORAGE:" ]; then
        IN_BLOCK=1
        continue
      else
        if [ "$IN_BLOCK" -eq 1 ]; then
          break
        fi
      fi
    fi

    if [ "$IN_BLOCK" -eq 1 ]; then
      if echo "$line" | grep -qi "content"; then
        CONTENT_TYPES=$(echo "$line" | sed -E 's/^\s*content\s*:\s*//')
        break
      fi
      if echo "$line" | grep -q "^[a-z]"; then
        break
      fi
    fi
  done < "$STORAGE_CFG"

  if [ -n "$CONTENT_TYPES" ]; then
    bold "    Content types: $CONTENT_TYPES"
    if echo "$CONTENT_TYPES" | grep -qi "snippets"; then
      green "  ✓ '$SNIPPET_STORAGE' storage has 'snippets' content-type enabled."
    else
      red "  ✗ '$SNIPPET_STORAGE' storage is missing 'snippets' content-type."
      yellow "  To fix: Datacenter → Storage → '$SNIPPET_STORAGE' → Content → check 'Snippets'"
      yellow "  Or add to $STORAGE_CFG:"
      yellow "    content: snippets"
    fi
  else
    yellow "  Could not parse content types for '$SNIPPET_STORAGE' from $STORAGE_CFG."
    bold "  First 15 lines of $STORAGE_CFG:"
    head -15 "$STORAGE_CFG" | while IFS= read -r line; do
      bold "    $line"
    done
  fi
else
  yellow "  $STORAGE_CFG not found — cannot verify content types."
fi

# ── summary ─────────────────────────────────────────────────────────────────
bold ""
bold "=== Deployment complete ==="
bold ""
bold "To use this snippet when deploying a VM:"
bold ""
bold "  1. In Proxmox GUI (VM → Options → Cloud-init):"
bold "     Custom user-data volume: ${SNIPPET_STORAGE}:snippets/install-agent.yaml"
bold ""
bold "  2. Via API / deploy code:"
bold "     configBody.cicustom = 'vendor=${SNIPPET_STORAGE}:snippets/install-agent.yaml';"
bold ""
bold "  3. Via qm CLI:"
bold "     qm set <vmid> --cicustom 'vendor=${SNIPPET_STORAGE}:snippets/install-agent.yaml'"
bold ""
bold "  The snippet performs three tasks on first boot:"
bold "    1. Installs qemu-guest-agent (for IP discovery & graceful shutdown)"
bold "    2. Enables serial-getty on ttyS0 (required for terminal access)"
bold "    3. Converts the DHCP-assigned IP to static (persists across reboots)"
bold ""
yellow "Note: Set PVE_SNIPPET_STORAGE env var to change the target storage."
