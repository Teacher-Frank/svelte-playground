# How to Create an LXC Container Ready for VNC Connection

This guide explains how to set up an LXC container so it is ready for GUI access via the VNC button in the playground. It covers installing a desktop, configuring a persistent VNC server, and connecting through a websocket bridge.

## Why is this needed?

Proxmox's built-in VNC is for VM consoles, not LXC containers. To get a GUI in an LXC, you must run a desktop and VNC server inside the container, then connect to it via a websocket bridge.

## Step 1: Install Desktop and VNC Server (inside container)

**Bash and PowerShell Core**
```bash
apt update
apt install -y xfce4 xfce4-goodies tigervnc-standalone-server dbus-x11 python3-websockify xterm
```

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

## Step 4: Make VNC Server Persistent (Survive Restarts)

Create a systemd user service so the VNC server starts on boot:

**Bash and PowerShell Core**
```bash
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/vncserver@:1.service <<'EOF'
[Unit]
Description=Start TigerVNC server at display :1
After=network.target

[Service]
Type=forking
ExecStart=/usr/bin/vncserver :1 -geometry 1920x1080 -depth 24
ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure

[Install]
WantedBy=default.target
EOF
```

**PowerShell Core**
```powershell
New-Item -ItemType Directory -Force ~/.config/systemd/user | Out-Null
@'
[Unit]
Description=Start TigerVNC server at display :1
After=network.target

[Service]
Type=forking
ExecStart=/usr/bin/vncserver :1 -geometry 1920x1080 -depth 24
ExecStop=/usr/bin/vncserver -kill :1
Restart=on-failure

[Install]
WantedBy=default.target
'@ | Set-Content -NoNewline ~/.config/systemd/user/vncserver@:1.service
```

Enable and start the service:

**Bash and PowerShell Core**
```bash
systemctl --user daemon-reload
systemctl --user enable vncserver@:1.service
systemctl --user start vncserver@:1.service
```

(Optional, as root):
```bash
loginctl enable-linger <your-username>
```

## Alternative: Start VNC Server on Boot Without systemd

If `systemctl --user` fails with “Failed to connect to bus: No medium found”, your container does not support systemd user services. Use a crontab entry to start the VNC server at boot:

**Bash and PowerShell Core**
```bash
crontab -e
```
Add this line at the end (replace `<user>` with your username if needed):
```
@reboot vncserver :1 -geometry 1920x1080 -depth 24
```
- Save and exit the editor. The VNC server will now start automatically on container boot.

If you want to ensure the desktop session is always running, you can also add a check to your crontab or use a wrapper script.

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

## Step 6: Start the Websocket Bridge (on host)

### Running websockify in the Background (Recommended)

To keep websockify running after you close the terminal, use `nohup` (recommended) or `&` in Bash, or `Start-Process` in PowerShell Core:

**Bash (recommended)**
```bash
nohup websockify 8001 <container-ip>:5901 > websockify.log 2>&1 &
```
- This will run websockify in the background and redirect output to `websockify.log`.
- The process will keep running even if you close the terminal.

**Bash (simple, not persistent if terminal closes)**
```bash
websockify 8001 <container-ip>:5901 &
```

**PowerShell Core**
```powershell
Start-Process websockify -ArgumentList '8001', '<container-ip>:5901'
```

- To stop websockify, find its process ID (`ps aux | grep websockify` or `Get-Process websockify`) and kill it as needed.

- The websocket bridge port (8001 above) must be in the range 8000–9000 for the playground VNC button to work.
- Then connect using the VNC button or point noVNC at `ws(s)://<host>:8001`.

### Starting the Desktop from a VNC Prompt

If you see a shell prompt in your VNC session, you can start the desktop manually:

**Recommended:**
```bash
nohup startxfce4 > xfce4.log 2>&1 &
```
- This runs XFCE in the background and saves all output to xfce4.log for troubleshooting.
- Your shell prompt remains usable for other commands.

**Simple:**
```bash
startxfce4 &
```
- This also runs XFCE in the background, but you won’t have a log file.

If you run `startxfce4` without `&` or `nohup`, your shell will be blocked by the desktop process.

## Troubleshooting: VNC Server Only Listening on Localhost

If your VNC server is only listening on 127.0.0.1 (localhost), websockify running on the Proxmox host cannot connect to it. You must start the VNC server so it listens on all interfaces:

**Bash and PowerShell Core (inside container)**
```bash
vncserver -localhost no :1 -geometry 1920x1080 -depth 24
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
xrdb $HOME/.Xresources
startxfce4 &
```

Then make it executable and restart the VNC server:

```bash
chmod +x ~/.vnc/xstartup
vncserver -kill :1
vncserver -localhost no :1 -geometry 1920x1080 -depth 24
```

This should launch the XFCE desktop automatically in your VNC session. If you still only see a prompt, try running `DISPLAY=:1 startxfce4 &` manually inside the container to check for errors.

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

## Security Tips
- Use a non-root user for the desktop session.
- Keep strong VNC passwords.
- Expose VNC only to trusted networks or localhost + proxy.
- Never allow arbitrary host:port from browser query params; use a server-side allowlist.

---

This is all you need to create an LXC container that is ready for VNC GUI access via the playground VNC button.


