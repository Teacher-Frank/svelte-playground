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

# ---- Distro detection ----
DISTRO_ID="unknown"
if [ -f /etc/os-release ]; then
    DISTRO_ID=$(. /etc/os-release && echo "${ID}") || DISTRO_ID="unknown"
fi
echo " Distro: ${DISTRO_ID}"
echo ""

# ---- Distro-agnostic helpers ----
dpkg_is_installed() {
    dpkg -l "$1" 2>/dev/null | grep -q "^ii"
}
rpm_is_installed() {
    rpm -q "$1" &>/dev/null
}

is_debian_based() {
    [ "$DISTRO_ID" = "ubuntu" ] || [ "$DISTRO_ID" = "debian" ] || [ "$DISTRO_ID" = "pop" ]
}

is_rhel_based() {
    [ "$DISTRO_ID" = "rhel" ] || [ "$DISTRO_ID" = "centos" ] || [ "$DISTRO_ID" = "fedora" ] || [ "$DISTRO_ID" = "rocky" ] || [ "$DISTRO_ID" = "almalinux" ]
}

pkg_installed() {
    if is_debian_based; then
        dpkg_is_installed "$1"
    elif is_rhel_based; then
        rpm_is_installed "$1"
    else
        # Fallback: check if binary is on PATH
        command -v "$1" &>/dev/null
    fi
}

pkg_install_cmd() {
    if is_debian_based; then
        echo "sudo apt install -y $1"
    elif is_rhel_based; then
        echo "sudo dnf install -y $1"
    else
        echo "sudo [package-manager] install $1  (distro ${DISTRO_ID} not recognized)"
    fi
}

has_systemd() {
    [ -d /run/systemd/system ]
}

svc_is_active() {
    has_systemd && systemctl is-active --quiet "$1" 2>/dev/null
}

svc_is_enabled() {
    has_systemd && systemctl is-enabled --quiet "$1" 2>/dev/null
}

# ---- 1. QEMU guest agent ---
echo "--- QEMU Guest Agent ---"
if pkg_installed "qemu-guest-agent"; then
    pass "qemu-guest-agent package is installed"
    if svc_is_active "qemu-guest-agent"; then
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
if pkg_installed cloud-init; then
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
    echo "       Fix: $(pkg_install_cmd cloud-init)"
    echo "            sudo sed -i '/^datasource_list:/c\\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg"
fi
echo ""

# ---- 3. Serial console getty (required for terminal access)---
echo "--- Serial Console Getty (terminal access) ---"
if svc_is_enabled serial-getty@ttyS0; then
    pass "serial-getty@ttyS0 is enabled"
    if svc_is_active serial-getty@ttyS0; then
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
if pkg_installed websockify; then

    pass "websockify package is installed"
    if ss -tlnp 2>/dev/null | grep -q ":8001 "; then
        pass "websockify is listening on port 8001"
    elif svc_is_active websockify-vnc; then

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
# Check all Netplan files — renderer or addresses can be in ANY file
NETPLAN_DIR="/etc/netplan"
if [ -d "$NETPLAN_DIR" ] && ls "$NETPLAN_DIR"/*.yaml 1>/dev/null 2>&1; then
    # Check if ANY Netplan file delegates to NetworkManager
    if grep -rq 'renderer:.*NetworkManager' "$NETPLAN_DIR" 2>/dev/null; then
        : # Fall through to other checks below
    else
        # Netplan manages networking directly
        if grep -rqE '^\s+addresses:' "$NETPLAN_DIR" 2>/dev/null; then
            pass "IP is statically configured (Netplan)"
        elif grep -rqE '^\s+dhcp4:\s*(true|yes)' "$NETPLAN_DIR" 2>/dev/null; then
            warn "IP is assigned via DHCP (Netplan)"
            echo "       A static IP is recommended for servers to prevent address changes."
        else
            warn "Could not determine IP configuration method (Netplan)"
        fi
    fi
else
    # No Netplan files found — check other network managers
    if [ -f /etc/network/interfaces ]; then
        # Debian-style /etc/network/interfaces
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
