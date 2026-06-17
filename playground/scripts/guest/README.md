# Guest Scripts

These scripts run **inside the guest VM or LXC container OS** (Ubuntu/Debian), **not** on the Proxmox host.

| Script | Purpose |
|---|---|
| `install-guest-agent.sh` | Installs and enables the QEMU guest agent (required for IP discovery) |
| `install-vnc-bridge.sh` | Installs websockify for VNC websocket bridging (required for GUI access) |
| `vm-checklist-verify.sh` | Runs all guest-side checks and reports pass/fail/warning status |

## Quick Start

After deploying a new guest, run the verification script first to see what's missing:

```bash
sudo bash vm-checklist-verify.sh
```

Then install what's needed:

```bash
# Required: guest agent (for IP discovery and static IP conversion)
sudo bash install-guest-agent.sh

# Optional: VNC bridge (for GUI access via the playground)
sudo bash install-vnc-bridge.sh

# Re-run verification
sudo bash vm-checklist-verify.sh
```

## VNC Bridge Options

```bash
# Default: install package + create systemd service on port 8001
sudo bash install-vnc-bridge.sh

# Custom port
sudo bash install-vnc-bridge.sh --port 8080

# Just install the package (no service, start manually)
sudo bash install-vnc-bridge.sh --no-service

# Test in foreground with verbose output
sudo bash install-vnc-bridge.sh --standalone
```
