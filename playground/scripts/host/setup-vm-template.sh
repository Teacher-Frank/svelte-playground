#!/bin/bash
# setup-vm-template.sh
# ====================
# Run this ON THE PROXMOX HOST to prepare a downloaded VM template for
# use with the playground. This ensures the template has:
#   - Guest agent enabled (agent: 1)
#   - Network interface attached to the correct bridge (net0)
#   - DHCP on the network interface (ipconfig0)
#   - Cloud-init drive attached (ide2)
#
# Usage:
#   sudo bash setup-vm-template.sh <template-vmid> [bridge] [cloudinit-storage]
#
# Examples:
#   sudo bash setup-vm-template.sh 9001
#   sudo bash setup-vm-template.sh 9001 vmbr1 fast-ssd

set -euo pipefail

# ---- Args ----
if [ $# -lt 1 ]; then
    echo "Usage: $0 <template-vmid> [bridge] [cloudinit-storage]" >&2
    exit 1
fi

VMID="$1"
BRIDGE="${2:-vmbr0}"
CLOUDINIT_STORAGE="${3:-local-lvm}"

echo "=========================================="
echo " Preparing VM template: ${VMID}"
echo "=========================================="
echo "  Bridge:              ${BRIDGE}"
echo "  Cloud-init storage:  ${CLOUDINIT_STORAGE}"
echo ""

# ---- 1. Check template exists ----
echo "--- Checking template exists ---"
if ! qm config "$VMID" &>/dev/null; then
    echo "ERROR: VM ${VMID} not found on this node." >&2
    exit 1
fi
echo "  ✓ VM ${VMID} found"

# ---- 2. Ensure template is a template (not just a running VM) ----
echo ""
echo "--- Checking template status ---"
if qm config "$VMID" 2>/dev/null | grep -q "^template: 1"; then
    echo "  ✓ ${VMID} is already marked as a template"
else
    echo "  ⚠ ${VMID} is NOT marked as a template yet."
    echo "    To convert: qm template ${VMID}"
    echo "    (This script will continue preparing config regardless)"
fi

# ---- 3. Enable guest agent ----
echo ""
echo "--- Enabling guest agent ---"
if qm config "$VMID" 2>/dev/null | grep -qE "^agent:\s*;?1"; then
    echo "  ✓ Guest agent already enabled"
else
    echo "  → Enabling guest agent ..."
    qm set "$VMID" --agent 1
    echo "  ✓ Guest agent enabled"
fi

# ---- 4. Ensure network interface exists ----
echo ""
echo "--- Checking network interface ---"
if qm config "$VMID" 2>/dev/null | grep -qE "^net0:"; then
    NET0_CURRENT=$(qm config "$VMID" 2>/dev/null | grep "^net0:" | sed 's/net0: //')
    echo "  Current net0: ${NET0_CURRENT}"

    # Check if bridge is correct
    if echo "$NET0_CURRENT" | grep -q "bridge=${BRIDGE}"; then
        echo "  ✓ Network bridge is already set to ${BRIDGE}"
    else
        echo "  → Updating bridge to ${BRIDGE} ..."
        qm set "$VMID" --net0 virtio,bridge="${BRIDGE}"
        echo "  ✓ Bridge updated to ${BRIDGE}"
    fi
else
    echo "  → Adding network interface net0 with bridge ${BRIDGE} ..."
    qm set "$VMID" --net0 virtio,bridge="${BRIDGE}"
    echo "  ✓ Network interface added"
fi

# ---- 5. Ensure DHCP on ipconfig0 ----
echo ""
echo "--- Checking DHCP (ipconfig0) ---"
if qm config "$VMID" 2>/dev/null | grep -qE "^ipconfig0:"; then
    echo "  ✓ ipconfig0 already set"
else
    echo "  → Setting ipconfig0 to DHCP ..."
    qm set "$VMID" --ipconfig0 ip=dhcp
    echo "  ✓ ipconfig0 set to DHCP"
fi

# ---- 6. Ensure cloud-init drive ----
echo ""
echo "--- Checking cloud-init drive ---"
if qm config "$VMID" 2>/dev/null | grep -qi "cloudinit"; then
    echo "  ✓ Cloud-init drive already attached"
elif qm config "$VMID" 2>/dev/null | grep -qE "^ide2:"; then
    echo "  ⚠ ide2 is present but may not be cloud-init"
    echo "     Current: $(qm config "$VMID" 2>/dev/null | grep "^ide2: ")"
    echo "     If this isn't a cloud-init disk, run:"
    echo "     qm set ${VMID} --ide2 ${CLOUDINIT_STORAGE}:cloudinit"
else
    echo "  → Attaching cloud-init drive on ide2 ..."
    qm set "$VMID" --ide2 "${CLOUDINIT_STORAGE}:cloudinit"
    echo "  ✓ Cloud-init drive attached"
fi

# ---- Summary ----
echo ""
echo "=========================================="
echo " Template ${VMID} preparation summary"
echo "=========================================="
echo ""
qm config "$VMID" 2>/dev/null | grep -E "^(agent|net0|ipconfig0|ide2|template):" || true
echo ""
echo "→ The template is now ready for the playground to clone from."
