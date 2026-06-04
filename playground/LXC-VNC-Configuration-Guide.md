# How to Create an LXC Container Ready for VNC Connection

This guide explains how to set up an LXC container so it is ready for GUI access via the VNC button in the playground. The main flow below is the reboot-safe method: crontab starts a VNC boot script that reliably launches both TigerVNC and XFCE after every container restart.

## Why is this needed?

Proxmox's built-in VNC is for VM consoles, not LXC containers. To get a GUI in an LXC, you must run a desktop and VNC server inside the container, then connect to it via a websocket bridge.

## Step 0: Configure the Playground to Use the LXC Bridge

The VNC button uses Proxmox native VNC by default. For LXC desktop sessions, configure the playground server to route LXC VNC through your websockify bridge.

Set these environment variables for the playground runtime:

```bash
LXC_VNC_BRIDGE_WS_URL=ws://<bridge-host>:<bridge-port>
LXC_VNC_BRIDGE_ALLOWED_HOSTS=<bridge-host>:<bridge-port>
```

- `LXC_VNC_BRIDGE_WS_URL` is used for LXC VNC sessions. It can also use placeholders:
    - `ws://<bridge-host>:80{vmid}`
    - `ws://<bridge-host>/lxc/{node}/{vmid}`
- `LXC_VNC_BRIDGE_ALLOWED_HOSTS` is a comma-separated allowlist of bridge websocket hosts.

Example:

```bash
LXC_VNC_BRIDGE_WS_URL=ws://proxmox.example.local:8001
LXC_VNC_BRIDGE_ALLOWED_HOSTS=proxmox.example.local:8001
```

Bridge websocket port policy for this playground:
- Allowed range: `8000` to `9000`
- Default example port: `8001`

Restart the playground server after updating environment variables.

Also restart the playground server after pulling VNC-related code changes. The VNC route and websocket proxy behavior are server-side and may not refresh correctly in an already running dev process.

## Step 1: Install Desktop and VNC Server (inside container)

**Bash and PowerShell Core**
```bash
apt update
apt install -y xfce4 xfce4-goodies tigervnc-standalone-server dbus-x11 python3-websockify xterm
```

## Create a Non-Root VNC User (Recommended)

When students deploy a container from the playground, they start in a root shell. For safer desktop usage, create a dedicated user and run the VNC desktop session as that user.

**Bash and PowerShell Core**
```bash
adduser student
```

- Set a strong password when prompted.
- Accept the default profile details (press Enter).

Switch to that user before continuing:

**Bash and PowerShell Core**
```bash
su - student
```

From this point onward, run the remaining guide steps as `student` (especially `vncpasswd`, `~/.vnc/xstartup`, and user crontab entries).

## Step 2: Set VNC Password (inside container)

**Bash and PowerShell Core**
```bash
vncpasswd
```

## Step 3: Create VNC Startup Script (inside container)

**Bash**
```bash
mkdir -p ~/.vnc
cat > ~/.vnc/xstartup <<'EOF'
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec dbus-launch --exit-with-session startxfce4
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
exec dbus-launch --exit-with-session startxfce4
'@ | Set-Content -NoNewline ~/.vnc/xstartup
chmod +x ~/.vnc/xstartup
```

## Step 4: Main Flow - Make VNC + Desktop Restart-Safe with crontab

**Note:** We use crontab as the main path because systemd user services are not available on this LXC template by default.

Create a wrapper script that cleans stale locks and starts VNC in a stable way:

**Bash and PowerShell Core**
```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/vnc-boot.sh <<'EOF'
#!/bin/sh
set -eu

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1
rm -f "$HOME"/.vnc/*.pid || true

vncserver -kill :1 >/dev/null 2>&1 || true
pkill -f Xtigervnc >/dev/null 2>&1 || true

exec /usr/bin/vncserver -localhost no -noreset :1 -geometry 1920x1080 -depth 24
EOF
chmod +x ~/.local/bin/vnc-boot.sh
```

Add the reboot job:

**Bash and PowerShell Core**
```bash
crontab -e
```
Add this line:
```
@reboot ~/.local/bin/vnc-boot.sh >> ~/vnc-boot.log 2>&1
```

This is the primary startup path for this guide.

## Step 5: Find the Container IP

**Inside the container:**
```bash
hostname -I
```

**From the Proxmox host:**
```bash
pct exec <VMID> -- hostname -I
```

Use the IP address that is reachable from the host running the websocket bridge.



## Step 6: Start the Websocket Bridge (websockify)

You can run websockify either inside the LXC container or on the Proxmox host. Which you choose depends on your network setup:

- **Run inside the container** if your playground/noVNC client can connect directly to the container's IP and port.
- **Run on the Proxmox host** if the container is not directly reachable from the playground/noVNC client (most common in production or NAT setups). The host acts as a bridge.

### Automatically Start websockify on Container Boot (main flow)

1. Open your crontab for editing inside the container:
    ```bash
    crontab -e
    ```
2. Add this line at the end (adjust the port and VNC target as needed):
    ```
    @reboot /usr/bin/websockify 8001 127.0.0.1:5901 >> ~/websockify.log 2>&1
    ```
3. Save and exit the editor. Now, websockify will start automatically every time the container boots.

Use the same websocket port here that you configure in `LXC_VNC_BRIDGE_WS_URL`.

### Running websockify in the Background (Manual Start)

To keep websockify running after you close the terminal, use `nohup` (recommended) or `&` in Bash, or `Start-Process` in PowerShell Core:

**Bash (recommended, inside container or on host)**
```bash
nohup websockify 8001 <container-ip>:5901 > websockify.log 2>&1 &
```
- This will run websockify in the background and redirect output to `websockify.log`.
- The process will keep running even if you close the terminal.

**Bash (simple, not persistent if terminal closes)**
```bash
websockify 8001 <container-ip>:5901 &
```

**PowerShell Core (on host or in container with PowerShell)**
```powershell
Start-Process websockify -ArgumentList '8001', '<container-ip>:5901'
```

- To stop websockify, find its process ID (`ps aux | grep websockify` or `Get-Process websockify`) and kill it as needed.

- The websocket bridge port is configurable. Use ports in the `8000` to `9000` range. Default example port is `8001`.
- Then connect using the VNC button (with Step 0 configured) or point noVNC at `ws(s)://<host>:<bridge-port>`.

**Note:** If you run websockify inside the container, the playground/noVNC client must be able to reach the container's IP and port directly. If you run it on the Proxmox host, use the host's IP and ensure it can connect to the container's VNC port.

### Starting the Desktop from a VNC Prompt

If you see a shell prompt in your VNC session, restart VNC through the boot wrapper. Do not launch `startxfce4` manually from a shell.

```bash
~/.local/bin/vnc-boot.sh
```

This ensures `DISPLAY` is correct and launches XFCE via `~/.vnc/xstartup`.

## Troubleshooting: VNC Server Only Listening on Localhost

If your VNC server is only listening on 127.0.0.1 (localhost), websockify running on the Proxmox host cannot connect to it. You must start the VNC server so it listens on all interfaces:

**Bash and PowerShell Core (inside container)**
```bash
vncserver -localhost no -noreset :1 -geometry 1920x1080 -depth 24
```
- This makes the VNC server listen on the container’s external IP, so websockify (running on the host) can connect.
- You can check the listening address with:
```bash
ss -tlnp | grep 5901
```
- You should see `0.0.0.0:5901` or `<container-ip>:5901` in the output.

If you want this to be persistent, update your systemd service, crontab, or startup script to include `-localhost no` in the VNC server command.

## Troubleshooting: XFCE Desktop Does Not Start in VNC (But xterm Works)

If you see a working xterm window in your VNC session but not the XFCE desktop, update your `~/.vnc/xstartup` script to the following minimal version:

```sh
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec dbus-launch --exit-with-session startxfce4
```

Then make it executable and restart the VNC server:

```bash
chmod +x ~/.vnc/xstartup
~/.local/bin/vnc-boot.sh
```

This should launch the XFCE desktop automatically in your VNC session. If it still fails, check `~/.vnc/*.log` and `~/vnc-boot.log`.

## Troubleshooting: Xorg Fails with 'no screens found' or 'Fatal server error'

If your VNC log shows errors like:

```
Fatal server error:
(EE) no screens found(EE)
```

This means your LXC container does not have a virtual GPU or framebuffer device, so Xorg cannot start a graphical session. To fix this:

1. **Enable nesting and device passthrough in the container config** (on the Proxmox host):
   - Edit `/etc/pve/lxc/<VMID>.conf` and add:
     ```
     features: nesting=1
     lxc.cgroup2.devices.allow: c 226:* rwm
     lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
     ```
   - Restart the container.

2. **Install the dummy video driver:**
   ```bash
   apt install -y xserver-xorg-video-dummy
   ```

3. **Create or edit `/etc/X11/xorg.conf` with a dummy device section:**
   ```
   Section "Device"
       Identifier  "Configured Video Device"
       Driver      "dummy"
   EndSection

   Section "Monitor"
       Identifier  "Configured Monitor"
       HorizSync   31.5-48.5
       VertRefresh 50-70
   EndSection

   Section "Screen"
       Identifier  "Default Screen"
       Monitor     "Configured Monitor"
       Device      "Configured Video Device"
       DefaultDepth 24
       SubSection "Display"
           Depth 24
           Modes "1920x1080"
       EndSubSection
   EndSection
   ```
   - Restart the VNC server after this.

This should allow Xorg to start in an LXC container without a real GPU, and your desktop environment should appear in the VNC session.

## Optional: systemd user-service flow

If your specific container image does support systemd user services, you can use a `vncserver@:1.service` unit instead of crontab. Keep `-noreset` in `ExecStart` and keep using the same `~/.vnc/xstartup` file from Step 3.

## Troubleshooting: VNC/Xorg Terminates with '-reset' Warning

If your VNC/Xorg log shows messages like:

```
Warning: VNC extension does not support -reset, terminating instead. Use -noreset to prevent termination.
The X session died with signal 15!
```

This means the X server is being told to reset (often by logout or session end), but the VNC extension does not support it and will terminate. Use `-noreset` in your startup commands (already included in the main flow).

## Troubleshooting: Hangs on "Submitting credentials..."

If the VNC page stays on "Submitting credentials...":

1. Restart the playground server so environment and recent VNC code changes are active.
2. Confirm `LXC_VNC_BRIDGE_WS_URL` and `LXC_VNC_BRIDGE_ALLOWED_HOSTS` match exactly (`host:port`).
3. Verify bridge and VNC listeners:
    ```bash
    ss -tlnp | grep -E "8001|5901"
    ```
4. Run websockify in verbose mode and retry once:
    ```bash
    websockify --verbose 8001 127.0.0.1:5901
    ```

If verbose output shows `Target closed connection` immediately, the backend VNC auth handshake is failing. Restart VNC via `~/.local/bin/vnc-boot.sh` and retry.

## Security Tips
- Use a non-root user for the desktop session.
- Keep strong VNC passwords.
- Expose VNC only to trusted networks or localhost + proxy.
- Never allow arbitrary host:port from browser query params; use a server-side allowlist.

---

This is all you need to create an LXC container that is ready for VNC GUI access via the playground VNC button.


