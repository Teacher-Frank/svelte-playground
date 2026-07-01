#!/bin/bash
# vm-checklist-verify.sh
# ======================
# Run this inside a VM/LXC guest OS to verify that all guest-side
# prerequisites are met for the playground to work correctly.
#
# Checks performed:
#   1. QEMU guest agent installed and running
#   2. Cloud-init installed with NoCloud datasource
#   3. Serial console getty (required for terminal access)
#   4. Kernel serial console parameter (recommended)
#   5. LXC device passthrough for VNC (LXC only)
#   6. VNC server listening on port 5901 (optional - required for GUI)
#   7. websockify VNC bridge listening on port 8001 (optional - required for GUI)
#   8. Network connectivity (can reach gateway/DNS)
#   9. Static IP configuration check (recommended vs DHCP)
#
# Usage:
#   sudo bash vm-checklist-verify.sh

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
warn() { echo "  ⚠ $1"; WARN=$((WARN + 1)); }

echo "=========================================="
echo " Playground Guest VM Checklist Verification"
echo "=========================================="
echo ""

# ---- 1. QEMU guest agent ----
echo "--- QEMU Guest Agent ---"
if dpkg -l qemu-guest-agent 2>/dev/null | grep -q "^ii"; then
    pass "qemu-guest-agent package is installed"
    if systemctl is-active --quiet qemu-guest-agent; then
        pass "qemu-guest-agent service is running"
    else
        fail "qemu-guest-agent service is NOT running"
        echo "       Fix: sudo systemctl start qemu-guest-agent"
    fi
else
    fail "qemu-guest-agent is NOT installed"
    echo "       Fix: sudo bash install-guest-agent.sh"
fi
echo ""

# ---- 2. cloud-init + NoCloud datasource ----
echo "--- Cloud-init ---"
if dpkg -l cloud-init 2>/dev/null | grep -q "^ii"; then
    pass "cloud-init package is installed"

    # Check NoCloud datasource
    if [ -f /etc/cloud/cloud.cfg ]; then
        if grep -qE '^datasource_list:.*NoCloud' /etc/cloud/cloud.cfg 2>/dev/null; then
            pass "NoCloud datasource is configured"
        else
            fail "NoCloud datasource is NOT configured"
            echo "       Fix: sudo sed -i '/^datasource_list:/c\\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg"
            echo "            sudo cloud-init clean"
        fi
    else
        fail "/etc/cloud/cloud.cfg not found"
        echo "       Fix: install cloud-init, then configure NoCloud datasource (see admin guide Section 1.4)"
    fi
else
    fail "cloud-init is NOT installed"
    echo "       Fix: sudo apt install -y cloud-init"
    echo "            sudo sed -i '/^datasource_list:/c\\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg"
fi
echo ""

# ---- 3. Serial console getty (required for terminal access) ----
echo "--- Serial Console Getty (terminal access) ---"
if systemctl is-enabled serial-getty@ttyS0.service 2>/dev/null | grep -qiE '(enabled|yes)'; then
    pass "serial-getty@ttyS0 is enabled"
    if systemctl is-active --quiet serial-getty@ttyS0 2>/dev/null; then
        pass "serial-getty@ttyS0 is active"
    else
        warn "serial-getty@ttyS0 is enabled but not running"
        echo "       Fix: sudo systemctl start serial-getty@ttyS0"
    fi
else
    fail "serial-getty@ttyS0 is NOT enabled"
    echo "       Fix: sudo systemctl enable --now serial-getty@ttyS0.service"
    echo "       (Required for web terminal access — see admin guide Section 1.4.4)"
fi
echo ""

# ---- 4. Kernel serial console parameter (recommended) ----
echo "--- Kernel Serial Console (recommended) ---"
if [ -f /etc/default/grub ]; then
    if grep -qE 'GRUB_CMDLINE_LINUX=.*console=ttyS0' /etc/default/grub 2>/dev/null; then
        pass "console=ttyS0 is set in GRUB"
    else
        warn "console=ttyS0 is NOT set in GRUB"
        echo "       Fix: sudo sed -i 's/GRUB_CMDLINE_LINUX=\"/GRUB_CMDLINE_LINUX=\"console=ttyS0,115200n8 /' /etc/default/grub"
        echo "            sudo update-grub"
        echo "       (Recommended for full serial output visibility — see admin guide Section 1.4.4)"
    fi
else
    warn "/etc/default/grub not found (LXC containers don't use GRUB — this check applies to VMs)"
fi
echo ""

# ---- 5. LXC device passthrough for VNC (LXC only) ----
echo "--- LXC Device Passthrough (LXC containers) ---"
if [ -d /dev/.lxc-mounts ] || [ -f /.dockerenv ] || grep -qs 'lxc' /proc/1/cgroup 2>/dev/null; then
    # Likely running inside an LXC container
    if [ -d /dev/dri ]; then
        pass "/dev/dri is present"
    else
        fail "/dev/dri is NOT present"
        echo "       Fix: ensure the post-create hook script ran on the host (Section 1.2)"
        echo "            Container may need a restart after hook installation."
    fi
else
    warn "Not running inside an LXC container — skipping VNC device passthrough check"
fi
echo ""

# ---- 6. VNC server (port 5901) ----
echo "--- VNC Server (port 5901) ---"
if ss -tlnp 2>/dev/null | grep -q ":5901 "; then
    pass "VNC server is listening on port 5901"
else
    warn "No VNC server listening on port 5901"
    echo "       This is OK if you don't need GUI access."
    echo "       To enable: install and start x11vnc or tigervnc on port 5901"
fi
echo ""

# ---- 7. websockify bridge (port 8001) ----
echo "--- websockify VNC Bridge (port 8001) ---"
if dpkg -l websockify 2>/dev/null | grep -q "^ii"; then
    pass "websockify package is installed"
    if ss -tlnp 2>/dev/null | grep -q ":8001 "; then
        pass "websockify is listening on port 8001"
    elif systemctl is-active --quiet websockify-vnc; then
        pass "websockify-vnc service is active (port may take a moment to bind)"
    else
        warn "websockify is NOT listening on port 8001"
        echo "       Fix: sudo bash install-vnc-bridge.sh"
    fi
else
    warn "websockify is NOT installed"
    echo "       This is OK if you don't need GUI access."
    echo "       To install: sudo bash install-vnc-bridge.sh"
fi
echo ""

# ---- 8. Network connectivity ----
echo "--- Network Connectivity ---"
if command -v ip &>/dev/null; then
    IPV4=$(ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \K[\d.]+' | head -1)
    if [ -n "$IPV4" ]; then
        pass "Primary IPv4 address: ${IPV4}"
    else
        fail "No global IPv4 address found"
    fi
else
    warn "ip command not available, skipping IP check"
fi

# Check if IP is statically configured or DHCP
echo ""
NETPLAN_FILE=$(ls /etc/netplan/*.yaml 2>/dev/null | head -1)
if [ -n "$NETPLAN_FILE" ]; then
    # If Netplan delegates to NetworkManager, skip Netplan parsing
    if grep -q 'renderer:.*NetworkManager' "$NETPLAN_FILE" 2>/dev/null; then
        NETPLAN_FILE=""  # Fall through to other checks below
    else
        # Netplan manages the network directly
        if grep -qE '^\s+addresses:' "$NETPLAN_FILE" 2>/dev/null && ! grep -qE '^\s+dhcp4:\s*(true|yes)' "$NETPLAN_FILE" 2>/dev/null; then
            pass "IP is statically configured (Netplan)"
        elif grep -qE '^\s+dhcp4:\s*(true|yes)' "$NETPLAN_FILE" 2>/dev/null; then
            warn "IP is assigned via DHCP (Netplan)"
            echo "       A static IP is recommended for servers to prevent address changes."
        else
            warn "Could not determine IP configuration method (Netplan)"
        fi
    fi
fi
if [ -z "$NETPLAN_FILE" ]; then
    if [ -f /etc/network/interfaces ]; then
        # /etc/network/interfaces (Debian/older Ubuntu)
        if grep -qE '^\s+address\s' /etc/network/interfaces 2>/dev/null; then
            pass "IP is statically configured (/etc/network/interfaces)"
        elif grep -qE '^\s+method\s+(dhcp|auto)' /etc/network/interfaces 2>/dev/null; then
            warn "IP is assigned via DHCP (/etc/network/interfaces)"
            echo "       A static IP is recommended for servers to prevent address changes."
        else
            warn "Could not determine IP configuration method (/etc/network/interfaces)"
        fi
    elif command -v nmcli &>/dev/null; then
        # NetworkManager — use nmcli connection show (IP4.CONFIG was removed from device show in newer NM)
        ACTIVE_DEV=$(nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep ':connected' | head -1 | cut -d: -f1)
        if [ -n "$ACTIVE_DEV" ]; then
            # Get the connection name for this device
            CON_NAME=$(nmcli -t -f NAME,DEVICE connection show 2>/dev/null | grep ":${ACTIVE_DEV}$" | cut -d: -f1)
            if [ -n "$CON_NAME" ]; then
                METHOD=$(nmcli -t -f ipv4.method connection show "$CON_NAME" 2>/dev/null | head -1 | cut -d: -f2)
                if [ "$METHOD" = "manual" ] || [ "$METHOD" = "shared" ]; then
                    if [ "$METHOD" = "manual" ]; then
                        pass "IP is statically configured (NetworkManager)"
                    else
                        pass "IP is effectively static (NetworkManager, 'shared' mode)"
                        echo "       The host runs the DHCP server, so the address will not change externally."
                    fi
                elif [ "$METHOD" = "auto" ] || [ "$METHOD" = "dhcp" ]; then
                    warn "IP is assigned via DHCP (NetworkManager)"
                    echo "       A static IP is recommended for servers to prevent address changes."
                else
                    warn "Could not determine IP configuration method (NetworkManager, method: $METHOD)"
                fi
            else
                warn "Could not determine connection name for device $ACTIVE_DEV"
            fi
        else
            warn "No active NetworkManager connection found"
        fi
    else
        warn "Could not find network configuration method (no Netplan, /etc/network/interfaces, or NetworkManager)"
    fi
fi

if command -v ping &>/dev/null; then
    if ping -c 1 -W 3 8.8.8.8 &>/dev/null; then
        pass "Internet connectivity: OK (ping 8.8.8.8)"
    else
        warn "Cannot ping 8.8.8.8 (may be restricted by firewall)"
    fi
else
    warn "ping command not available"
fi
echo ""

# ---- Summary ----
echo "=========================================="
echo " Summary: ${PASS} passed, ${FAIL} failed, ${WARN} warnings"
echo "=========================================="

if [ "$FAIL" -gt 0 ]; then
    echo " Some checks failed. See above for fix commands."
    exit 1
else
    echo " All required checks passed."
    if [ "$WARN" -gt 0 ]; then
        echo " There are warnings (GUI may not work without VNC + websockify)."
    fi
    exit 0
fi
