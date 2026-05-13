# LXC GUI Over VNC via the VNC Button

## Goal

Make the existing `VNC` button open a usable GUI for LXC containers.

## Why It Does Not Work Out-of-the-Box

Proxmox `vncwebsocket` is designed for QEMU VM framebuffer consoles. LXC containers do not expose a VM-style virtual GPU/framebuffer by default, so pointing noVNC at Proxmox's VM VNC path for an LXC often results in a black screen.

The fix is to run a GUI + VNC server inside the container, then have the button connect to that VNC service (preferably through a websocket proxy).

## Recommended Architecture

1. LXC container runs:
- a desktop session (for example XFCE)
- a VNC server (for example TigerVNC, x11vnc, or TightVNC)

2. A websocket bridge is available:
- `websockify` can bridge browser websocket traffic to container TCP VNC (`5901`)

3. The playground VNC button for container rows targets that websocket bridge instead of Proxmox `.../qemu/.../vncwebsocket`.

This keeps a single UX (`VNC` button) while using the correct backend protocol for containers.

## Container Setup Example (Ubuntu LXC)

Run inside the container:

```bash
apt update
apt install -y xfce4 xfce4-goodies tigervnc-standalone-server dbus-x11
```

Create VNC password and startup script as the runtime user:

```bash
vncpasswd
cat > ~/.vnc/xstartup <<'EOF'
#!/bin/sh
xrdb "$HOME/.Xresources"
startxfce4 &
EOF
chmod +x ~/.vnc/xstartup
```

Start VNC server on display `:1` (`5901`):

```bash
vncserver :1 -geometry 1920x1080 -localhost no
```

Notes:
- Use a non-root runtime user for desktop sessions when possible.
- If you set `-localhost yes`, you must tunnel/bridge from the host.

## Websocket Bridge Options

## Option A (Recommended): Host-side websockify

Run on the playground host (or a secured gateway):

```bash
websockify 6081 <container-ip>:5901
```

Then noVNC connects to `ws(s)://<host>:6081`.

## Option B: Container-side websockify

Run `websockify` inside the container and expose only websocket port.

## Option C: Bridge in the existing Node server

Add a dedicated route (for example `/proxmox/lxc-vnc/ws`) that:
- resolves allowed container targets from server-side config
- opens a TCP socket to `<container-ip>:5901`
- proxies frames between browser websocket and container VNC

Reason: this preserves one origin and centralizes access control.

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

Current app logic is VM-only by design. To support LXC:

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

Reason: VM and LXC GUI backends are different protocols/assumptions; explicit branching keeps behavior predictable and secure.

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

1. Pilot one container with GUI + VNC service.
2. Add allowlisted websocket bridge for that container only.
3. Enable VNC button for that container row.
4. Verify connect/disconnect/reconnect + auth failure paths.
5. Expand allowlist gradually.

## Troubleshooting Checklist

1. Black screen after connect:
- Desktop session not running in container
- VNC started but wrong display (`:1` vs `:2`)
- xstartup script missing/incorrect

2. Immediate disconnect:
- Wrong VNC password
- Bridge cannot reach container IP/port
- Firewall rules blocking 5901 or websocket port

3. Button opens but no session:
- Route still forced to VM-only
- Container target not present in server allowlist

## Summary

To make the VNC button work for LXC, treat container GUI as "desktop-in-container + VNC service + websocket bridge", not as Proxmox VM framebuffer VNC. This separation is the key to both reliability and security.
