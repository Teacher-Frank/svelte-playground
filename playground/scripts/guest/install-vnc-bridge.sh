#!/bin/bash
# install-vnc-bridge.sh
# =====================
# Run this inside a VM/LXC guest OS to install websockify (VNC bridge)
# and optionally set it up as a systemd service for reboot persistence.
#
# Why: The playground uses a websocket bridge to connect the browser to
# the VNC server running on port 5901 inside the guest. websockify
# listens on port 8001 (configurable) and forwards to the VNC server.
#
# Usage:
#   sudo bash install-vnc-bridge.sh                    # install + service (default)
#   sudo bash install-vnc-bridge.sh --port <port>      # custom websockify port
#   sudo bash install-vnc-bridge.sh --no-service       # install package only (no daemon)
#   sudo bash install-vnc-bridge.sh --standalone       # start immediately in foreground (testing)

set -euo pipefail

# ---- Defaults ----
WS_PORT=8001
INSTALL_SERVICE=true
RUN_STANDALONE=false

# ---- Parse args ----
while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)
            WS_PORT="$2"
            shift 2
            ;;
        --no-service)
            INSTALL_SERVICE=false
            shift
            ;;
        --standalone)
            RUN_STANDALONE=true
            INSTALL_SERVICE=false
            shift
            ;;
        *)
            echo "Usage: $0 [--port PORT] [--no-service | --standalone]" >&2
            exit 1
            ;;
    esac
done

# ---- Install websockify ----
echo "==> Installing websockify ..."
apt-get update -qq
apt-get install -y websockify

# ---- Standalone mode (quick test) ----
if [ "$RUN_STANDALONE" = true ]; then
    echo "==> Starting websockify in standalone mode on port ${WS_PORT} ..."
    echo "    (Press Ctrl+C to stop)"
    exec websockify --verbose "${WS_PORT}" 127.0.0.1:5901
fi

# ---- Service mode ----
if [ "$INSTALL_SERVICE" = true ]; then
    echo "==> Creating systemd service for websockify ..."

    cat >/etc/systemd/system/websockify-vnc.service <<EOF
[Unit]
Description=websockify VNC Bridge
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/websockify ${WS_PORT} 127.0.0.1:5901
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

    systemctl daemon-reload
    systemctl enable --now websockify-vnc

    if systemctl is-active --quiet websockify-vnc; then
        echo "==> OK: websockify-vnc service is running on port ${WS_PORT}."
    else
        echo "==> ERROR: websockify-vnc service failed to start." >&2
        exit 1
    fi

    echo "==> Done. The service will restart automatically on reboot."
else
    echo "==> Package installed. No service was created (--no-service mode)."
    echo "    To start manually: websockify ${WS_PORT} 127.0.0.1:5901"
fi
