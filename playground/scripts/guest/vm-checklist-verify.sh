#!/bin/bash
# vm-checklist-verify.sh
# ======================
# Run this inside a VM/LXC guest OS to verify that all guest-side
# prerequisites are met for the playground to work correctly.
#
# Checks performed:
#   1. QEMU guest agent installed and running
#   2. VNC server listening on port 5901 (optional - required for GUI)
#   3. websockify VNC bridge listening on port 8001 (optional - required for GUI)
#   4. Network connectivity (can reach gateway/DNS)
#
# Usage:
#   sudo bash vm-checklist-verify.sh

set -euo pipefail

PASS=0
FAIL=0
WARN=0

pass() { echo "  ✓ $1"; ((PASS++)); }
fail() { echo "  ✗ $1"; ((FAIL++)); }
warn() { echo "  ⚠ $1"; ((WARN++)); }

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

# ---- 2. VNC server (port 5901) ----
echo "--- VNC Server (port 5901) ---"
if ss -tlnp 2>/dev/null | grep -q ":5901 "; then
    pass "VNC server is listening on port 5901"
else
    warn "No VNC server listening on port 5901"
    echo "       This is OK if you don't need GUI access."
    echo "       To enable: install and start x11vnc or tigervnc on port 5901"
fi
echo ""

# ---- 3. websockify bridge (port 8001) ----
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

# ---- 4. Network connectivity ----
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
