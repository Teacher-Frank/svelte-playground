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
# Cloud-init user-data snippet for Proxmox cicustom.
# Installed by playground scripts/host/deploy-cloudinit-snippets.sh
#
# On first boot this installs and enables qemu-guest-agent so that
# Proxmox can discover the guest IP and issue graceful shutdowns.
#
# Usage in VM config (or deploy code):
#   cicustom: user=${SNIPPET_STORAGE}:snippets/install-agent.yaml

runcmd:
  # Install qemu-guest-agent if not already present, then enable it.
  - >-
    test -f /usr/sbin/qemu-ga ||
    (apt-get update -qq && apt-get install -y qemu-guest-agent) &&
    systemctl enable --now qemu-guest-agent
CLOUD-INIT

chmod 644 "$SNIPPET_DIR/install-agent.yaml"
green "  $SNIPPET_DIR/install-agent.yaml deployed."

# ── verify the snippets storage is available in Proxmox ─────────────────────
bold "Step 3: Checking Proxmox snippets storage"

if command -v pvesh &>/dev/null; then
  STORAGE_STATUS=$(pvesm status 2>/dev/null | grep "$SNIPPET_STORAGE" | head -1 || true)
  if echo "$STORAGE_STATUS" | grep -qi content; then
    CONTENTS=$(echo "$STORAGE_STATUS" | awk '{print $NF}')
    if echo "$CONTENTS" | grep -qi "snippets"; then
      green "  '$SNIPPET_STORAGE' storage has snippets content-type enabled. cicustom will work."
    else
      yellow "  '$SNIPPET_STORAGE' storage content: $CONTENTS"
      yellow "  Snippets may need to be enabled. See note below if cicustom fails."
    fi
  else
    yellow "  '$SNIPPET_STORAGE' storage not found — check pvesm status."
  fi
else
  yellow "  pvesh not found — skipping snippets storage check."
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
bold "     configBody.cicustom = 'user=${SNIPPET_STORAGE}:snippets/install-agent.yaml';"
bold ""
bold "  3. Via qm CLI:"
bold "     qm set <vmid> --cicustom 'user=${SNIPPET_STORAGE}:snippets/install-agent.yaml'"
bold ""
yellow "Note: Set PVE_SNIPPET_STORAGE env var to change the target storage."
