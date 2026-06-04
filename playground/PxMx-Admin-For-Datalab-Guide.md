# PxMx Admin For Datalab Guide

This guide is for Proxmox administrators running the Datalab playground setup.

## Initial setup

Before using the playground against a Proxmox node:

1. Verify Proxmox API access from the playground host (`https://<host>:8006`).
2. Set all required values in `acctest-env.ps1` (at minimum `PVE_BASE_URL`, `PVE_NODE`, auth settings, and storage settings).
3. Ensure the hook script exists at `/var/lib/vz/snippets/lxc-post-create-hook.sh` and is executable.
4. Confirm `PVE_LXC_HOOKSCRIPT_VOLID` points to the correct snippets storage volume ID.
5. Confirm `PVE_LXC_ROOTFS_STORAGE` points to storage that supports container/rootdir content.
6. Run `acctest-env.ps1` to build `pve-client` and start the playground dev server.
7. Download the default templates for virtual machines and LXC containers.
8. Validate one test container deployment before regular use.

## Environment Variables

This section documents all environment variables currently used in `acctest-env.ps1`.

### Proxmox connection and authentication

- `PVE_BASE_URL`: Base URL of the Proxmox API endpoint, including protocol and port (example: `https://<host>:8006`).
- `PVE_NODE`: Preferred Proxmox node name used for node-scoped operations.
- `PVE_USERNAME`: Proxmox username for password authentication.
- `PVE_PASSWORD`: Password for `PVE_USERNAME`.
- `PVE_REALM`: Proxmox authentication realm (for example `pam`, `pve`, or LDAP realms).
- `PVE_INSECURE_TLS`: Set to `true` to allow self-signed or otherwise untrusted TLS certificates.

### LXC deployment and storage

- `PVE_LXC_HOOKSCRIPT_VOLID`: Hookscript volume ID in Proxmox format `<storage>:snippets/<file>`. Example: `local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE`: Target storage for new LXC root filesystem allocation when deploying from storage templates. This storage must support `rootdir` / container directories (example: `local-lvm`).

### Terminal and runtime

- `PVE_TERMINAL_TRACE`: Enables verbose terminal proxy/debug logging when set to `true`.
- `NODE_ENV`: Node.js runtime mode (typically `development` for local/admin use).

### LXC VNC bridge variables

- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4`: When `true`, derive bridge websocket targets from container IPv4 addresses.
- `LXC_VNC_BRIDGE_WS_SCHEME`: Websocket scheme for derived mode (`ws` or `wss`).
- `LXC_VNC_BRIDGE_WS_PORT`: Websocket port used in derived mode.
- `LXC_VNC_BRIDGE_WS_PATH`: Optional path suffix used in derived mode.
- `LXC_VNC_BRIDGE_WS_URL`: Optional explicit websocket URL template for template mode. Keep empty to use derived mode.
- `LXC_VNC_BRIDGE_ALLOWED_HOSTS`: Optional host allowlist for explicit bridge targets. Can remain empty in pure derived mode.

### Current `acctest-env.ps1` profile

- Password authentication with `PVE_USERNAME`, `PVE_PASSWORD`, and `PVE_REALM`.
- `PVE_INSECURE_TLS=true`.
- `PVE_LXC_HOOKSCRIPT_VOLID=local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE=local-lvm`.
- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`, `LXC_VNC_BRIDGE_WS_SCHEME=ws`, and `LXC_VNC_BRIDGE_WS_PORT=8001`.

## VNC Configuration

The playground supports two bridge configuration modes for LXC GUI sessions.

### Template mode

- Set `LXC_VNC_BRIDGE_WS_URL` to a websocket URL template.
- Placeholders such as `{node}`, `{vmid}`, `{ip}`, or `{ipv4}` may be used.

### Derived IPv4 mode

- Set `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`.
- Configure `LXC_VNC_BRIDGE_WS_SCHEME`, `LXC_VNC_BRIDGE_WS_PORT`, and optional `LXC_VNC_BRIDGE_WS_PATH`.

Recommended derived mode values:

```bash
LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true
LXC_VNC_BRIDGE_WS_SCHEME=ws
LXC_VNC_BRIDGE_WS_PORT=8001
LXC_VNC_BRIDGE_WS_PATH=
```

Operational notes:

- Derived mode builds targets as `ws(s)://<container-ip>:<port><path>`.
- The websocket proxy only allows derived IPv4 targets on the configured bridge port.
- If no container IPv4 is available yet, the GUI action remains disabled until discovery completes.
- Restart the playground server after changing bridge variables.

## Other

### Enable nesting at container creation

When creating a new container (API or CLI), set `nesting=1`.

API example:

```
POST /api2/json/nodes/<node>/lxc
features=nesting=1
```

CLI example:

```
pct create <VMID> ... -features nesting=1
```

### Add device passthrough and mount entries

After creation, append these lines to `/etc/pve/lxc/<VMID>.conf`:

```
lxc.cgroup2.devices.allow: c 226:* rwm
lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
```

### Mandatory post-create hook script

Create this script on every Proxmox host where LXC containers will be deployed.

Path:

`/var/lib/vz/snippets/lxc-post-create-hook.sh`

Script content:

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
chmod +x /var/lib/vz/snippets/lxc-post-create-hook.sh
```

Deployment uses a Proxmox hookscript volume ID, not a host path. Default value:

```
local:snippets/lxc-post-create-hook.sh
```

If your snippets storage is not `local`, set `PVE_LXC_HOOKSCRIPT_VOLID` accordingly (example: `fast-ssd:snippets/lxc-post-create-hook.sh`).

### Troubleshooting

- If Xorg fails with `no screens found`, ensure the dummy video driver is installed and configured.
- Restart the container after changing container config files.

Note: this guide is intended for Proxmox administrators only.
