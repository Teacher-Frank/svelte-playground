#!/bin/bash
# install-guest-agent.sh
# =======================
# Run this inside a VM guest OS (Ubuntu/Debian) to install and enable
# the QEMU guest agent.
#
# Why: Without the guest agent, the playground cannot discover the VM IP
# address, and automatic DHCP-to-static-IP conversion will not work.
#
# Usage:
#   sudo bash install-guest-agent.sh

set -euo pipefail

echo "==> Installing qemu-guest-agent ..."
apt-get update -qq
apt-get install -y qemu-guest-agent

echo "==> Enabling and starting qemu-guest-agent service ..."
systemctl enable --now qemu-guest-agent

echo "==> Verifying service status ..."
if systemctl is-active --quiet qemu-guest-agent; then
    echo "==> OK: qemu-guest-agent is running."
else
    echo "==> ERROR: qemu-guest-agent failed to start." >&2
    exit 1
fi

echo "==> Done. The guest agent is installed and running."
echo "    Once the VM is started in Proxmox with 'agent: 1', the playground"
echo "    will discover the IP address on the next page refresh."
