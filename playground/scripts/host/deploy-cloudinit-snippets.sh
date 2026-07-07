#!/usr/bin/env bash
set -euo pipefail

SNIPPET_DIR="/var/lib/vz/snippets"
SNIPPET_STORAGE="${PVE_SNIPPET_STORAGE:-local}"

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[1;32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[1;33m%s\033[0m\n" "$*"; }
red()   { printf "\033[1;31m%s\033[0m\n" "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  red "This script must be run as root (use sudo)."; exit 1
fi

bold "Step 1: Ensuring snippet dir exists"
mkdir -p "$SNIPPET_DIR"
green "  $SNIPPET_DIR exists."

bold "Step 2: Deploying install-agent.yaml"
cat > "$SNIPPET_DIR/install-agent.yaml" << 'CLOUD-INIT'
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

  # 2. Enable serial console getty - required for terminal access via termproxy.
  #    Without this, the serial port connects but shows no login prompt.
  #    Idempotent: systemctl enable is safe to re-run.
  - |
    if ! systemctl enable --now serial-getty@ttyS0.service; then
      echo "ERROR: Failed to enable serial-getty@ttyS0.service" >&2
      exit 1
    fi

  # 3. Convert DHCP to static IP on first boot.
  #    Tries multiple methods and stops on the first success:
  #      A) Netplan direct - rewrites Netplan YAML when Netplan owns DHCP.
  #      B) NetworkManager + Netplan - rewrites netplan when renderer is NM.
  #      C) NetworkManager (nmcli) - pure nmcli when no Netplan involved.
  #      D) ifupdown - writes /etc/network/interfaces when that file exists.
  #    Idempotent: skips entirely if the interface is already static.
  - |
    set -e

    # Auto-detect the active Ethernet interface (avoids eth0 vs ens18 naming issue).
    detect_interface() {
      local iface=$(ip route show default 2>/dev/null | awk '/default/{print $5; exit}')
      [ -n "$iface" ] && echo "$iface" && return 0
      for dev in $(ip -o -4 addr show 2>/dev/null | awk '{print $2}' | sort -u); do
        [ "$dev" = "lo" ] && continue
        ip -4 addr show "$dev" 2>/dev/null | awk '/inet /{print $2}' | grep -q -v '127[.]' \
          && echo "$dev" && return 0
      done
      for dev in $(ip -o link show 2>/dev/null | awk -F': ' '{print $2}' | grep -v '^lo$'); do
        ip link show "$dev" 2>/dev/null | grep -q 'state UP' \
          && echo "$dev" && return 0
      done
      return 1
    }

    INTERFACE=$(detect_interface) || {
      echo "ERROR: Cannot detect active network interface; skipping static conversion" >&2
      exit 0
    }
    echo "INFO: Detected interface: ${INTERFACE}" >&2
    MAX_WAIT=30

    for i in $(seq 1 $MAX_WAIT); do
      IP=$(ip -4 addr show "$INTERFACE" 2>/dev/null | awk '/inet /{print $2}' | grep -v '127[.]')
      [ -n "$IP" ] && break
      sleep 1
    done
    if [ -z "$IP" ]; then
      echo "WARN: No IPv4 address found on ${INTERFACE} after ${MAX_WAIT}s; skipping" >&2
      exit 0
    fi

    IP_ONLY="${IP%%/*}"
    GATEWAY=$(ip route show default 2>/dev/null | awk '/default/{print $3}' | head -1)
    if [ -z "$GATEWAY" ]; then
      echo "WARN: No default gateway found for ${INTERFACE}; skipping" >&2
      exit 0
    fi
    MAC=$(ip link show "$INTERFACE" 2>/dev/null | awk '/link\/ether/{print $2}')
    DNS1="1.1.1.1"
    DNS2="8.8.8.8"

    # Skip if already static.
    IS_STATIC=false
    if grep -rq '^\s*addresses:' /etc/netplan/ 2>/dev/null && \
       ! grep -rq '^\s*dhcp4: *[Tt]rue' /etc/netplan/ 2>/dev/null; then
      IS_STATIC=true
    fi
    if command -v nmcli &>/dev/null; then
      _NM_METHOD=$(nmcli -t -f ipv4.method con show 2>/dev/null | head -1 | cut -d: -f2)
      [ "$_NM_METHOD" = "manual" ] && IS_STATIC=true
    fi
    if grep -q "static" /etc/network/interfaces 2>/dev/null; then
      IS_STATIC=true
    fi
    if [ "$IS_STATIC" = true ]; then
      echo "INFO: Interface ${INTERFACE} is already static; skipping conversion" >&2
      exit 0
    fi

    CONVERTED=false

    # A) Netplan direct (no NetworkManager renderer)
    if ! grep -rq 'renderer:.*NetworkManager' /etc/netplan/ 2>/dev/null && \
      NETPLAN_FILE=$(grep -rl "dhcp4: *[Tt]rue" /etc/netplan/*.yaml 2>/dev/null | head -1) && \
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
        echo "WARN: netplan apply failed for ${NETPLAN_FILE}; trying next method" >&2
      fi
      sleep 2
      [ -n "$(ip -4 addr show to ${IP_ONLY} 2>/dev/null)" ] && CONVERTED=true
    fi

    # B) NetworkManager + Netplan (renderer: NetworkManager)
    #    Rewriting netplan YAML is required - nmcli con mod alone gets overwritten
    #    by subsequent netplan generate which re-creates the 90-NM-*.yaml passthrough.
    if [ "$CONVERTED" = false ] && grep -rq 'renderer:.*NetworkManager' /etc/netplan/ 2>/dev/null; then
      NETPLAN_FILE=$(grep -rl "dhcp4: *[Tt]rue" /etc/netplan/*.yaml 2>/dev/null | head -1)
      if [ -n "$NETPLAN_FILE" ]; then
        printf '%s\n' \
          "# Generated by cloud-init snippet on $(date -u +%F\ %T)" \
          'network:' \
          '  version: 2' \
          '  renderer: NetworkManager' \
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
          "          - ${DNS2}" > "$NETPLAN_FILE"
        rm -f /etc/netplan/90-NM-*.yaml 2>/dev/null
        if ! netplan apply 2>/dev/null; then
          echo "WARN: netplan apply failed for ${NETPLAN_FILE}; trying next method" >&2
        else
          sleep 2
          _NM_METHOD=$(nmcli -t -f ipv4.method con show 2>/dev/null | head -1 | cut -d: -f2)
          [ "$_NM_METHOD" = "manual" ] && CONVERTED=true
        fi
      fi
    fi

    # C) NetworkManager (nmcli only, no Netplan renderer)
    if [ "$CONVERTED" = false ] && command -v nmcli &>/dev/null; then
      CON_NAME=$(nmcli -t -f NAME,DEVICE con show --active 2>/dev/null | \
                 grep ":${INTERFACE}$" | head -1 | cut -d: -f1 || :)
      [ -z "$CON_NAME" ] && \
        CON_NAME=$(nmcli -t -f NAME,DEVICE con show 2>/dev/null | \
                   grep ":${INTERFACE}$" | head -1 | cut -d: -f1 || :)
      if [ -n "$CON_NAME" ]; then
        if ! nmcli con mod "$CON_NAME" \
          ipv4.method manual \
          ipv4.addresses "${IP}" \
          ipv4.gateway "${GATEWAY}" \
          ipv4.dns "${DNS1},${DNS2}" \
          ipv4.dns-search "hrprefix.hro.nl hr.nl hrnet.hro.nl" \
          ipv4.ignore-auto-dns yes \
          ipv4.ignore-auto-routes yes 2>/dev/null; then
          echo "WARN: nmcli con mod failed for ${CON_NAME}; trying next method" >&2
        elif ! nmcli con up "$CON_NAME" 2>/dev/null; then
          echo "WARN: nmcli con up failed for ${CON_NAME}; trying next method" >&2
        fi
        sleep 2
        [ -n "$(ip -4 addr show to ${IP_ONLY} 2>/dev/null)" ] && CONVERTED=true
      else
        echo "WARN: No NetworkManager connection found for ${INTERFACE}" >&2
      fi
    fi

    # D) ifupdown (/etc/network/interfaces)
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

bold "Step 3: Checking snippets storage"
if ! command -v pvesh &>/dev/null && ! command -v pvesm &>/dev/null; then
  yellow "  pvesh/pvesm not found - skipping storage check."; exit 0
fi
pvesm status 2>/dev/null | while IFS= read -r line; do bold "    $line"; done

bold "=== Deployment complete ==="
bold "qm set <vmid> --cicustom vendor=${SNIPPET_STORAGE}:snippets/install-agent.yaml"
