#!/bin/bash
# setup-hookscript.sh
# ===================
# Run this ON THE PROXMOX HOST (not inside a guest VM/container) to
# create and install the LXC post-create hook script.
#
# Why: The playground needs this script so that every new LXC container
# automatically gets the correct device passthrough and mount entries
# for VNC device passthrough.
#
# Usage:
#   sudo bash setup-hookscript.sh

set -euo pipefail

HOOK_DIR="/var/lib/vz/snippets"
HOOK_FILE="${HOOK_DIR}/lxc-post-create-hook.sh"

echo "==> Installing LXC post-create hook script ..."

# Create snippets directory if needed
if [ ! -d "$HOOK_DIR" ]; then
    echo "==> Creating directory: $HOOK_DIR"
    mkdir -p "$HOOK_DIR"
fi

# Write the hook script
echo "==> Writing hook script to: $HOOK_FILE"
cat >"$HOOK_FILE" <<'EOF'
#!/bin/bash
# Proxmox LXC post-create hook script for VNC device passthrough
#
# Automatically adds /dev/dri device passthrough to newly created containers.
# This is required for the playground dummy VNC bridge to work.
#
# Called by Proxmox with: $0 <vmid> "post-create"
echo "[lxc-post-create-hook] Invoked with args: $@" >&2
if [ "$2" = "post-create" ]; then
  VMID="$1"
  CONF="/etc/pve/lxc/$VMID.conf"
  echo "lxc.cgroup2.devices.allow: c 226:* rwm" >> "$CONF"
  echo "lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir" >> "$CONF"
  echo "[lxc-post-create-hook] Updated $CONF for VNC device passthrough." >&2
fi
EOF

# Make executable
chmod +x "$HOOK_FILE"

echo "==> Done. Hook script installed at: $HOOK_FILE"
echo ""
echo "==> Next steps:"
echo "   1. In acctest-env.ps1, set:"
echo "      \$env:PVE_LXC_HOOKSCRIPT_VOLID = \"local:snippets/lxc-post-create-hook.sh\""
echo "   2. If your snippets storage is different from 'local', update the"
echo "      PVE_LXC_HOOKSCRIPT_VOLID value accordingly (e.g., fast-ssd:snippets/...)."
