# VNC Configuration Guide

This guide explains how to set up a graphical desktop so you can connect via the **VNC button** in the playground. All commands are run from the **Terminal** button in the playground.

---

## VMs (Virtual Machines)

VMs use Proxmox's native VNC console. No extra configuration is needed on the guest — the VNC button connects directly to the VM's graphical console.

### Requirements

- The template must include a desktop environment (XFCE, GNOME, etc.) and a display manager (LightDM, GDM, etc.).
- After the VM boots and the display manager starts, click **VNC** to see the login screen.

### Troubleshooting

**Blank screen or shell prompt instead of a desktop**

The template may lack a GUI. Install one inside the VM:

```bash
sudo apt update
sudo apt install -y xfce4 lightdm
sudo systemctl enable --now lightdm
```

Reboot the VM and try VNC again.

---

## LXC Containers

LXC containers do not have a native VNC console. You must install a desktop environment, a VNC server, and a websocket bridge inside the container.

### Prerequisites

The playground server must be configured with derived IPv4 bridge mode. Contact your administrator if the VNC button does not appear for your container.

### Step 1: Install Desktop and VNC Server

```bash
sudo apt update
sudo apt install -y xfce4 xfce4-goodies tigervnc-standalone-server dbus-x11 python3-websockify xterm
```

### Step 2: Set VNC Password

```bash
vncpasswd
```

Enter and confirm a strong password.

### Step 3: Create VNC Startup Script

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

### Step 4: Create VNC Boot Script

This script cleans stale locks and starts VNC reliably on every boot.

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

### Step 5: Start VNC and Websockify on Boot

```bash
crontab -e
```

Add these two lines (use the first available editor if prompted):

```
@reboot ~/.local/bin/vnc-boot.sh >> ~/vnc-boot.log 2>&1
@reboot /usr/bin/websockify 8001 127.0.0.1:5901 >> ~/websockify.log 2>&1
```

### Step 6: Start VNC Now (for this session)

```bash
~/.local/bin/vnc-boot.sh
websockify 8001 127.0.0.1:5901 &
```

### Step 7: Connect via VNC

1. Refresh the playground page so the container's IP appears in the workload list.
2. Click the **VNC** button.
3. Enter the password you set in Step 2.

---

## Troubleshooting

### VNC shows a shell instead of the desktop

Restart VNC using the boot wrapper:

```bash
~/.local/bin/vnc-boot.sh
```

### "no screens found" or "Fatal server error"

The container lacks a virtual GPU. Try:

```bash
sudo apt install -y xserver-xorg-video-dummy
```

Then restart VNC. If the issue persists, contact your administrator — nesting and `/dev/dri` passthrough may need to be enabled in the container config.

### VNC shows "Submitting credentials…" and hangs

Check that both services are running:

```bash
ps aux | grep -E 'websockify|Xtigervnc'
```

Check logs for errors:

```bash
cat ~/vnc-boot.log
cat ~/websockify.log
```

### Container reboot breaks VNC

Verify both `@reboot` entries exist in crontab:

```bash
crontab -l
```

### VNC port conflict

If port 8001 is already in use, use a different port (e.g., 8002) and update both the crontab entry and the websockify command.

---

## Security

- Use a strong VNC password — it is the only thing protecting your desktop.
- VNC is exposed only through the playground websocket bridge, not directly on the network.
- Do not share your VNC password.
