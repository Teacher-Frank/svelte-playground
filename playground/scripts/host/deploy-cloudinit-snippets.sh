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

# ── ensure snippets directory exists ────────────────────────────────────────
bold "Step 1: Ensuring \$SNIPPET_DIR exists"
mkdir -p "$SNIPPET_DIR"
green "  $SNIPPET_DIR exists."

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
  # 0. Write a marker log so we can verify this snippet ran.
  - |
    TIMESTAMP=$(date -u +%F\ %T\ UTC)
    echo "install-agent snippet ran at $TIMESTAMP" > /root/snippet.log

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
    if ! systemctl enable --now serial-getty@ttyS0.service; then
      echo "ERROR: Failed to enable serial-getty@ttyS0.service" >&2
      exit 1
    fi

  # 3. Convert DHCP→static IP on first boot.
  #    Tries multiple methods and stops on the first success:
  #      A) Netplan direct  — rewrites Netplan YAML when Netplan owns DHCP.
  #      B) NetworkManager  — uses nmcli when renderer is NetworkManager or
  #                           nmcli is available and managing the interface.
  #      C) ifupdown        — writes /etc/network/interfaces when that file exists
  #                           with a DHCP entry.
  #    Idempotent: skips entirely if the interface is already static.
  - |
    set -e
    INTERFACE="eth0"
    MAX_WAIT=30

    # Wait for any IP.
    for i in $(seq 1 $MAX_WAIT); do
      IP=$(ip -4 addr show "$INTERFACE" 2>/dev/null | awk '/inet /{print $2}' | grep -v '127[.]')
      [ -n "$IP" ] && break
      sleep 1
    done
    if [ -z "$IP" ]; then
      echo "WARN: No IPv4 address found on ${INTERFACE} after ${MAX_WAIT}s; skipping static conversion" >&2
      exit 0
    fi

    IP_ONLY="${IP%%/*}"
    GATEWAY=$(ip route show default 2>/dev/null | awk '/default/{print $3}' | head -1)
    if [ -z "$GATEWAY" ]; then
      echo "WARN: No default gateway found for ${INTERFACE}; skipping static conversion" >&2
      exit 0
    fi
    MAC=$(ip link show "$INTERFACE" 2>/dev/null | awk '/link\/ether/{print $2}')
    DNS1="1.1.1.1"
    DNS2="8.8.8.8"

    # Skip if already static (any method).
    IS_STATIC=false
    if grep -rq '^\s*addresses:' /etc/netplan/ 2>/dev/null && \
       ! grep -rq '^\s*dhcp4: *[Tt]rue' /etc/netplan/ 2>/dev/null; then
      IS_STATIC=true
    fi
    # nmcli has it?
    if command -v nmcli &>/dev/null; then
      _NM_METHOD=$(nmcli -t -f ipv4.method con show 2>/dev/null | head -1 | cut -d: -f2)
      [ "$_NM_METHOD" = "manual" ] && IS_STATIC=true
    fi
    # ifupdown already static?
    if grep -q "static" /etc/network/interfaces 2>/dev/null; then
      IS_STATIC=true
    fi
    if [ "$IS_STATIC" = true ]; then
      echo "INFO: Interface ${INTERFACE} is already static; skipping conversion" >&2
      exit 0
    fi

    CONVERTED=false

     # ---------- A) Netplan (direct, no NetworkManager renderer) ----------
     if ! grep -rq 'renderer:.*NetworkManager' /etc/netplan/ 2>/dev/null && \
       NETPLAN_FILE=$(grep -l "dhcp4: *[Tt]rue" /etc/netplan/*.yaml 2>/dev/null | head -1) && \
       [ -n "$NETPLAN_FILE" ]; then
      printf '%s\n' \
        "# Generated by cloud-init snippet on $(date -u +%F\ %T)" \
        'network:' \
        '  version: 2' \
        '  ethernets:' \
        "    ${INTERFACE}:" \
        '      match:' \
        "        macaddress: \"${MAC}\"" \
        '      dhcp4: false' \
        '      addresses:' \
        "        - \"${IP}\"" \
        '      routes:' \
        '        - to: default' \
        "          via: \"${GATEWAY}\"" \
        '      nameservers:' \
        '        addresses:' \
        "          - ${DNS1}" \
        "          - ${DNS2}" \
        "      set-name: ${INTERFACE}" > "$NETPLAN_FILE"
      if ! netplan apply 2>/dev/null; then
        echo "WARN: netplan apply failed for ${NETPLAN_FILE}; trying next conversion method" >&2
      fi
      sleep 2
      [ -n "$(ip -4 addr show to ${IP_ONLY} 2>/dev/null)" ] && CONVERTED=true
    fi

    # ---------- B) NetworkManager (nmcli) ----------
    if [ "$CONVERTED" = false ] && command -v nmcli &>/dev/null; then
      CON_NAME=$(nmcli -t -f NAME,DEVICE con show 2>/dev/null | \
                 grep ":${INTERFACE}$" | cut -d: -f1 || :)
      if [ -n "$CON_NAME" ]; then
        if ! nmcli con mod "$CON_NAME" \
          ipv4.method manual \
          ipv4.addresses "${IP}" \
          ipv4.gateway "${GATEWAY}" \
          ipv4.dns "${DNS1},${DNS2}" \
          ipv4.dns-search "hrprefix.hro.nl hr.nl hrnet.hro.nl" \
          ipv4.ignore-auto-dns yes \
          ipv4.ignore-auto-routes yes 2>/dev/null; then
          echo "WARN: nmcli con mod failed for ${CON_NAME}; trying next conversion method" >&2
        elif ! nmcli con up "$CON_NAME" 2>/dev/null; then
          echo "WARN: nmcli con up failed for ${CON_NAME}; trying next conversion method" >&2
        fi
        sleep 2
        [ -n "$(ip -4 addr show to ${IP_ONLY} 2>/dev/null)" ] && CONVERTED=true
      else
        echo "WARN: No NetworkManager connection found for ${INTERFACE}" >&2
      fi
    fi

    # ---------- C) ifupdown (/etc/network/interfaces) ----------
    if [ "$CONVERTED" = false ] && [ -f /etc/network/interfaces ]; then
      if grep -qi "dhcp" /etc/network/interfaces 2>/dev/null; then
        ESCAPED=$(sed "s/^address.*/    address ${IP_ONLY}/" \
                   /etc/network/interfaces \
                   | sed "s/method dhcp/method static/" \
                   | sed "/    address ${IP_ONLY}/a\    netmask 255.255.255.0" \
                   | sed "/    netmask/a\    gateway ${GATEWAY}" \
                   | sed "/    gateway/a\    dns-nameservers ${DNS1} ${DNS2}")
        echo "$ESCAPED" > /etc/network/interfaces
        if command -v ifup &>/dev/null; then
          if ! ifup ${INTERFACE} 2>/dev/null; then
            echo "WARN: ifup failed for ${INTERFACE}" >&2
          fi
        fi
        sleep 2
        [ -n "$(ip -4 addr show to ${IP_ONLY} 2>/dev/null)" ] && CONVERTED=true
      fi
    fi

    if [ "$CONVERTED" = false ]; then
      echo "ERROR: Failed to convert ${INTERFACE} from DHCP to static using all methods" >&2
      exit 1
    fi
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

  # Extract the storage block for our storage ID and look for the content line.
  CONTENT_TYPES=$(awk -v target="$SNIPPET_STORAGE" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    /^[[:alnum:]_-]+:[[:space:]]+/ {
      in_block = ($2 == target)
      next
    }
    in_block && ($1 == "content" || $1 == "content:") {
      sub(/^[[:space:]]*content:?[[:space:]]*/, "")
      print
      exit
    }
  ' "$STORAGE_CFG")

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
