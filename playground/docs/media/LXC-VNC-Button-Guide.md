# LXC GUI Over VNC via the VNC Button

## Goal

Make the existing `VNC` button open a usable GUI for LXC containers. Follow the steps below exactly when you test the flow.

## Why It Does Not Work Out-of-the-Box

Proxmox `vncwebsocket` is designed for QEMU VM framebuffer consoles. LXC containers do not expose a VM-style virtual GPU/framebuffer by default, so pointing noVNC at Proxmox's VM VNC path for an LXC often results in a black screen.

The fix is to run a GUI + VNC server inside the container, then have the button connect to that VNC service (preferably through a websocket proxy).

## Recommended Architecture

Use this flow:

1. Run a desktop session inside the LXC container.
2. Run a VNC server inside the same container on a port in the 8000–9000 range.
3. Put a websocket bridge in front of that VNC server.
4. Point the playground `VNC` button at the bridge for the container row.

Do not reuse Proxmox's VM framebuffer VNC path for an LXC container. That is the wrong backend and it usually produces a black screen.

## Container Setup Example (Ubuntu LXC)

Run these steps inside the container as the desktop user you want to log in with.

These steps are shown in Bash and PowerShell Core. Use the PowerShell Core blocks if that is the shell you run inside the container. When the command is the same in both shells, it appears only once.

1. Install the desktop and VNC packages.

**Bash and PowerShell Core**
```bash
apt update
apt install -y xfce4 xfce4-goodies tigervnc-standalone-server dbus-x11
```

2. Create the VNC password as that same user.

**Bash and PowerShell Core**
```bash
vncpasswd
```

3. Create the VNC startup script so the desktop starts inside the VNC session.

**Bash**
```bash
mkdir -p ~/.vnc
cat > ~/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
EOF
chmod +x ~/.vnc/xstartup
```

**PowerShell Core**
```powershell
New-Item -ItemType Directory -Force ~/.vnc | Out-Null
@'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec startxfce4
'@ | Set-Content -NoNewline ~/.vnc/xstartup
chmod +x ~/.vnc/xstartup
```

4. Start a persistent VNC server that creates its own display.

**Bash and PowerShell Core**
```bash
vncserver :1 -geometry 1920x1080 -depth 24
```

5. Leave that command running. It creates display `:1` and listens on TCP `5901` inside the container.

If the VNC command exits, stop and fix that before testing the browser flow. The session must stay alive.

**Important:**
- The websocket bridge port **must** be in the range 8000–9000 for the playground VNC button to work.
- Use a non-root runtime user for desktop sessions when possible.
- Do not attach `x11vnc` to `:0` unless you already have a real X session running in the container.

If you need to stop the desktop later, run:

**Bash and PowerShell Core**
```bash
vncserver -kill :1
```

## Websocket Bridge

Use host-side `websockify` first. That is the simplest path to test and the one you should verify before trying anything more complex.

Run on the playground host (or a secured gateway):

**Bash and PowerShell Core**
```bash
websockify 8001 <container-ip>:5901
```

Then noVNC connects to `ws(s)://<host>:8001`.

### Finding the Container IP

To find `<container-ip>`, run one of these commands on the Proxmox host:

**PowerShell Core (Windows and Linux)**
```powershell
# List all IPv4 addresses on the host (cross-platform)
[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | 
  Where-Object { $_.OperationalStatus -eq 'Up' } | 
  ForEach-Object { $_.GetIPProperties().UnicastAddresses } | 
  Where-Object { $_.Address.AddressFamily -eq 'InterNetwork' } | 
  Select-Object -ExpandProperty Address

# Or query the container from Proxmox API using curl (replace placeholders)
# Requires: curl and a valid Proxmox API token
curl -s -k -H "Authorization: PVEAPIToken=user@pam!token_name:token_secret" `
  https://proxmox-host:8006/api2/json/nodes/node-name/lxc/VMID/status/current | ConvertFrom-Json | Select-Object -ExpandProperty data | Select-Object -ExpandProperty ips
```

**Bash on Linux**
```bash
# List all IP addresses
hostname -I

# Or query the container from Proxmox API
curl -s -H "Authorization: PVEAPIToken=user@pam!token_name:token_secret" \
  https://proxmox-host:8006/api2/json/nodes/node-name/lxc/VMID/status/current | jq '.data.ips'
```

If you run the bridge from PowerShell Core, use the same arguments. On Windows PowerShell Core, prefix the command with `&` if `websockify` is not already resolved as a direct command.

If you later replace `websockify` with the Node server bridge, keep the container VNC port the same and change only the websocket hop. Do not move the container port while you are still troubleshooting.

## Security Hardening Requirements

1. Never allow arbitrary `host:port` from browser query params.
- Use a server-side allowlist keyed by container ID.

2. Prefer private networking.
- Expose VNC only to trusted networks or localhost + proxy.

3. Require authentication.
- Keep strong VNC passwords.
- Prefer TLS (`wss`) in transit.

4. Audit and timebox access.
- Log who opened GUI sessions and for which container.

## App Changes Needed for the VNC Button

Current app logic is VM-only by design. To support LXC, do this in order:

1. In workload controls
- Re-enable VNC button for containers when container GUI metadata is available.
- Keep VM behavior unchanged.

2. In VNC page/server load
- Branch by workload type:
  - `vm`: current Proxmox ticket flow
  - `container`: resolve container VNC target (IP/port or bridge endpoint)

3. In websocket proxy
- Keep strict route validation.
- Add container route with allowlisted targets only.
- Do not mix VM ticket logic with container direct VNC logic.

Reason: VM and LXC GUI backends are different protocols and should not share the same connection path.

## Data Model Suggestion

Add optional GUI metadata per container row:

```ts
type ContainerGuiConfig = {
  enabled: boolean;
  wsPath: string;      // e.g. /proxmox/lxc-vnc/ws?id=123
  authMode: 'vnc' | 'none';
};
```

Populate this server-side from trusted config (not from client input).

## Minimal Rollout Plan

1. Pilot one Ubuntu container with GUI and VNC installed.
2. Start the VNC server on port `8001` and leave it running.
3. Add one allowlisted websocket bridge for that container.
4. Enable the VNC button for that one container row.
5. Verify connect, disconnect, reconnect, and auth failure behavior.
6. Expand to more containers only after the first one works.

## Troubleshooting Checklist

1. Black screen after connect:
- Desktop session is not running in the container.
- VNC started on the wrong display (`:1` vs `:2`).
- The websocket bridge is not bound to a port in the 8000–9000 range.

2. Immediate disconnect:
- Wrong VNC password.
- Bridge cannot reach the container IP and port.
- Firewall rules are blocking the container VNC port or websocket port.

3. Button opens but no session:
- Route is still forced to VM-only.
- Container target is not present in the server allowlist.

4. VNC command exits right away:
- The server was started without `-forever`.
- The command was launched in a shell that closed as soon as it returned.
- The command tried to attach to `:0` before any X display existed.

## Summary

To make the VNC button work for LXC, treat container GUI as "desktop-in-container + VNC service + websocket bridge", not as Proxmox VM framebuffer VNC. This separation is the key to both reliability and security.
