# Proxmox LXC VNC Admin Guide

This guide is for Proxmox administrators. It covers host-side configuration and automation needed to make LXC containers VNC-ready, including advanced options that cannot be set from inside the container.

## 1. Enable Nesting and Device Access at Container Creation

When creating a new container (via API or CLI), set nesting=1:

**API example:**
```
POST /api2/json/nodes/<node>/lxc
features=nesting=1
```
**CLI example:**
```
pct create <VMID> ... -features nesting=1
```

## 2. Add Device Passthrough and Mount Entries

After creation, append these lines to `/etc/pve/lxc/<VMID>.conf`:
```
lxc.cgroup2.devices.allow: c 226:* rwm
lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
```

## 3. Mandatory: Create the LXC Post-Create Hook Script

You must create the following script on every Proxmox host where LXC containers will be deployed. This is required for all LXC container deployments, not optional.

Create the script at `/root/lxc-post-create-hook.sh`:
```bash
#!/bin/bash
if [ "$2" = "post-create" ]; then
  VMID="$1"
  CONF="/etc/pve/lxc/$VMID.conf"
  echo "lxc.cgroup2.devices.allow: c 226:* rwm" >> "$CONF"
  echo "lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir" >> "$CONF"
fi
```
Make it executable:
```
chmod +x /root/lxc-post-create-hook.sh
```

This script will be automatically invoked for every new LXC container created via the API or UI, as the deployment process always specifies it with the `hookscript` parameter. Do not skip this step.

## 4. Troubleshooting
- If Xorg fails with 'no screens found', ensure the dummy video driver is installed and the config is correct.
- Always restart the container after changing the config file.

---

**Note:** This guide is for Proxmox administrators only. Do not expose these steps to general users.
