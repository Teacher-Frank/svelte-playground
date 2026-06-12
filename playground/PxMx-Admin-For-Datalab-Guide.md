# PxMx Admin For Datalab Guide

This guide is for Proxmox administrators running the Datalab playground setup.

## Table of contents

- [1. Proxmox configuration](#1-proxmox-configuration)
- [1.1 Initial setup](#11-initial-setup)
- [1.2 Enable nesting at container creation](#12-enable-nesting-at-container-creation)
- [1.3 Add device passthrough and mount entries](#13-add-device-passthrough-and-mount-entries)
- [1.4 Mandatory post-create hook script](#14-mandatory-post-create-hook-script)
- [1.5 Troubleshooting](#15-troubleshooting)
- [1.6 VM operational checklist (network, cloud-init, VNC)](#16-vm-operational-checklist-network-cloud-init-vnc)
- [2. Webserver configuration](#2-webserver-configuration)
- [2.1 Webserver configuration](#21-webserver-configuration)
- [2.2 Playground server troubleshooting: "Submitting credentials..."](#22-playground-server-troubleshooting-submitting-credentials)
- [2.3 VNC configuration](#23-vnc-configuration)
- [2.4 Other](#24-other)
- [Appendix A. Environment variables](#appendix-a-environment-variables)
- [A.1 Proxmox connection and authentication](#a1-proxmox-connection-and-authentication)
- [A.2 LXC deployment and storage](#a2-lxc-deployment-and-storage)
- [A.3 Terminal and runtime](#a3-terminal-and-runtime)
- [A.4 Diagnostics and benchmarking](#a4-diagnostics-and-benchmarking)
- [A.5 VM template deploy guard](#a5-vm-template-deploy-guard)
- [A.6 LXC VNC bridge variables](#a6-lxc-vnc-bridge-variables)
- [A.7 Current `acctest-env.ps1` profile](#a7-current-acctest-envps1-profile)

## 1. Proxmox configuration

### 1.1 Initial setup

Before using the playground against a Proxmox node:

1. Verify Proxmox API access from the playground host (`https://<host>:8006`).
2. Set all required values in `acctest-env.ps1` (at minimum `PVE_BASE_URL`, `PVE_NODE`, auth settings, and storage settings).
  Set `PVE_ADMIN_CONTACT_EMAIL` so VM deploy failures can show the correct admin contact when a template is missing a cloud-init drive.
3. Ensure the hook script exists at `/var/lib/vz/snippets/lxc-post-create-hook.sh` and is executable.
4. Confirm `PVE_LXC_HOOKSCRIPT_VOLID` points to the correct snippets storage volume ID.
5. Confirm `PVE_LXC_ROOTFS_STORAGE` points to storage that supports container/rootdir content.
6. Run `acctest-env.ps1` to build `pve-client` and start the playground dev server.
7. Download the required VM and LXC templates before any deploy or clone action.
  Ensure each VM template is fully prepared before cloning: cloud-init drive present, guest agent enabled, and template networking activated (`net0` attached to the correct bridge and `ipconfig0` set to DHCP).
8. Validate one test container deployment before regular use.

### 1.2 Enable nesting at container creation

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

### 1.3 Add device passthrough and mount entries

After creation, append these lines to `/etc/pve/lxc/<VMID>.conf`:

```
lxc.cgroup2.devices.allow: c 226:* rwm
lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
```

### 1.4 Mandatory post-create hook script

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

### 1.5 Troubleshooting

- If Xorg fails with `no screens found`, ensure the dummy video driver is installed and configured.
- Restart the container after changing container config files.

### 1.6 VM operational checklist (network, cloud-init, VNC)

Use this checklist for QEMU VMs deployed from templates in the playground.

#### Template readiness before clone

Before cloning any VM template:

1. Confirm the template was downloaded/created and appears in Proxmox template inventory.
2. Confirm template networking is already activated in template config (`net0` + `ipconfig0 ip=dhcp`).
3. Confirm the template includes or can accept the required cloud-init drive.

Do not clone VM templates that are missing networking activation; fix template networking first, then clone.

#### Network activation for cloned VMs

When a cloned VM boots without working networking, validate and enforce these VM config fields:

1. Ensure `net0` exists and is attached to the expected bridge.
2. Ensure `ipconfig0` is set to DHCP for cloud-init-based networking.

Reference commands on the Proxmox host:

```bash
qm config <vmid>
qm set <vmid> --net0 virtio,bridge=vmbr0
qm set <vmid> --ipconfig0 ip=dhcp
```

The playground clone flow already attempts this automatically when missing, using:

- `PVE_VM_NETWORK_BRIDGE` (default `vmbr0`)
- `PVE_VM_NETWORK_MODEL` (default `virtio`)

#### Cloud-init drive requirements

VM deploy depends on a cloud-init drive being attached to the cloned VM.

Expected behavior:

1. If the template clone already has a cloud-init disk, the deploy flow reuses it.
2. If missing, the deploy flow attaches `ide2=<storage>:cloudinit`.

Storage is controlled by:

- `PVE_VM_CLOUDINIT_STORAGE` (default `local-lvm`)

Validation commands on the Proxmox host:

```bash
qm config <vmid> | grep -Ei "cloudinit|ide2|scsi|virtio|sata"
pvesm list <cloudinit-storage> | grep "vm-<vmid>-cloudinit"
```

If deploy fails with a cloud-init LV collision, remove or reconcile the stale cloud-init volume for that VMID before retrying.

#### DHCP to static IP conversion (automatic)

Every VM deployed from a template initially receives a DHCP address (`ipconfig0=ip=dhcp`).
Once the guest agent is running and reports the first discovered IPv4 address (on each
page refresh), the playground automatically converts the VM's `ipconfig0` to a static IP
using the discovered address and subnet prefix (e.g., `ip=145.24.222.128/24`).

This happens without any user interaction. A green toast notification appears at the top
of the admin page confirming the conversion (e.g., "Converted VM my-vm (145.24.222.128/24) to static IP").

Manual override (if the automatic conversion fails):

```bash
qm set <vmid> --ipconfig0 ip=145.24.222.128/24
```

#### QEMU guest agent

The QEMU guest agent enables the playground to discover VM IP addresses, collect guest-side metrics, and perform graceful shutdowns. Without it, VM IPs stay `?` in the UI and the automatic DHCP→static conversion cannot trigger.

The playground supports two methods:

**Option A: Pre-install in template (recommended for shared templates)**

Install `qemu-guest-agent` inside the base template before converting it to a Proxmox template.

```bash
sudo apt-get update
sudo apt-get install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
sudo systemctl is-active qemu-guest-agent
```

Enable guest-agent support on the template (Proxmox GUI or CLI):

```bash
qm set <template-vmid> --agent 1
```

Every VM cloned from this template will inherit the agent configuration.

**Option B: Automatic install via cloud-init (implemented in playground)**

The playground deploy flow uses Proxmox's cloud-init `cicommand` to automatically install
and enable `qemu-guest-agent` on the VM's first boot. No manual intervention or template
preparation is required. The same cloud-init flow is what allows the automatic DHCP→static
conversion to work.

Manual installation (for VMs where the automatic install failed):

```bash
sudo apt-get update
sudo apt-get install -y qemu-guest-agent
sudo systemctl enable --now qemu-guest-agent
sudo systemctl is-active qemu-guest-agent
```

Notes:

- If guest agent is not running, VM IP derivation in the playground will stay `?`.
- Proxmox-side guest-agent support must be enabled for the VM (`agent: 1`). The deploy flow sets this automatically.
- The automatic DHCP→static conversion runs once per VM on the next page load after the guest agent first reports an IP.

Optional guest-side VNC bridge mode (only when intentionally using websockify path):

```bash
sudo apt-get install -y websockify
websockify 8001 127.0.0.1:5901
```

For reboot persistence inside the guest, add a user crontab entry:

```bash
@reboot /usr/bin/websockify 8001 127.0.0.1:5901 >> ~/websockify.log 2>&1
```

## 2. Webserver configuration

### 2.1 Webserver configuration

Configure the playground webserver with derived IPv4 bridge mode for LXC GUI sessions.

Required bridge variables:

```bash
LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true
LXC_VNC_BRIDGE_WS_SCHEME=ws
LXC_VNC_BRIDGE_WS_PORT=8001
LXC_VNC_BRIDGE_WS_PATH=
```

- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true` enables derived mode for LXC VNC websocket targets.
- `LXC_VNC_BRIDGE_WS_SCHEME` sets the websocket scheme (`ws` or `wss`).
- `LXC_VNC_BRIDGE_WS_PORT` sets the websocket bridge port used with discovered container IPv4 addresses.
- `LXC_VNC_BRIDGE_WS_PATH` is optional and can remain empty.

Bridge websocket port policy for this playground:
- Allowed range: `8000` to `9000`
- Default example port: `8001`

Restart the playground server after changing these variables.

Also restart the playground server after pulling VNC-related code changes. The VNC route and websocket proxy behavior are server-side and may not refresh correctly in an already running dev process.

### 2.2 Playground server troubleshooting: "Submitting credentials..."

If the VNC page stays on "Submitting credentials...":

1. Restart the playground server so environment and recent VNC code changes are active.
2. Confirm derived bridge mode is enabled and the bridge port matches websockify:
  - `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`
  - `LXC_VNC_BRIDGE_WS_PORT=8001` (or your chosen bridge port)
3. Verify bridge and VNC listeners:
  ```bash
  ss -tlnp | grep -E "8001|5901"
  ```
4. Run websockify in verbose mode and retry once:
  ```bash
  websockify --verbose 8001 127.0.0.1:5901
  ```

If verbose output shows `Target closed connection` immediately, the backend VNC auth handshake is failing. Restart VNC via `~/.local/bin/vnc-boot.sh` and retry.

### 2.3 VNC configuration

The datalab playground uses derived IPv4 bridge mode for LXC GUI sessions.
Configure bridge environment variables in the **Webserver Configuration** section above.

Operational notes:

- Derived mode builds targets as `ws(s)://<container-ip>:<port><path>`.
- The websocket proxy only allows derived IPv4 targets on the configured bridge port.
- If no container IPv4 is available yet, the GUI action remains disabled until discovery completes.
- Restart the playground server after changing bridge variables.

### 2.4 Other

- This section is intentionally minimal; place Proxmox host/container guidance in section 1 and web runtime guidance in section 2.

## Appendix A. Environment variables

This appendix documents environment variables used by the admin environment profiles (`dev-env.ps1`, `test-env.ps1`, and `acctest-env.ps1`).
This is the canonical environment variable inventory for the playground. When adding a new environment variable in code or scripts, update this guide in the same change.

### A.1 Proxmox connection and authentication

- `PVE_BASE_URL`: Base URL of the Proxmox API endpoint, including protocol and port (example: `https://<host>:8006`).
- `PVE_NODE`: Preferred Proxmox node name used for node-scoped operations.
- `PVE_API_TOKEN`: Proxmox API token for token-based authentication. Use this instead of username/password when available.
- `PVE_USERNAME`: Proxmox username for password authentication.
- `PVE_PASSWORD`: Password for `PVE_USERNAME`.
- `PVE_REALM`: Proxmox authentication realm (for example `pam`, `pve`, or LDAP realms).
- `PVE_INSECURE_TLS`: Set to `true` to allow self-signed or otherwise untrusted TLS certificates.

### A.2 LXC deployment and storage

- `PVE_LXC_HOOKSCRIPT_VOLID`: Hookscript volume ID in Proxmox format `<storage>:snippets/<file>`. Example: `local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE`: Target storage for new LXC root filesystem allocation when deploying from storage templates. This storage must support `rootdir` / container directories (example: `local-lvm`).

### A.3 Terminal and runtime

- `PVE_TERMINAL_TRACE`: Enables verbose terminal proxy/debug logging when set to `true`.
- `NODE_ENV`: Node.js runtime mode (typically `development` for local/admin use).

### A.4 Diagnostics and benchmarking

- `PLAYGROUND_PROFILE_LOAD`: Enables timing/profile logs for Proxmox page load paths when set to `true`.
- `PLAYGROUND_REFRESH_INTERVAL_SECONDS`: Default auto-refresh interval for the PxMxAdmin screen, in seconds (minimum `1`, maximum `3600`, default `5`).
- `PLAYGROUND_DEV_BENCH_RUNS`: Number of benchmark runs for `npm run bench:dev-startup` (default `4`).
- `PLAYGROUND_DEV_BENCH_BASE_PORT`: Base port used by dev-startup benchmarking (default `45173`).

### A.5 VM template deploy guard

- `PVE_ADMIN_CONTACT_EMAIL`: Admin contact email shown to users when VM deploy is blocked because the selected template does not have a cloud-init drive attached. Example: `thifm@hr.nl`.
- `PVE_VM_CLOUDINIT_STORAGE`: Preferred storage name for VM cloud-init disks in automation workflows (example: `local-lvm`).
- `PVE_VM_NETWORK_BRIDGE`: Bridge used when VM deploy must add a missing NIC (`net0`) to a cloned VM (default: `vmbr0`).
- `PVE_VM_NETWORK_MODEL`: Proxmox NIC model used when VM deploy must add a missing NIC (`net0`) to a cloned VM (default: `virtio`).

### A.6 LXC VNC bridge variables

- `LXC_VNC_BRIDGE_WS_URL`: Explicit websocket URL template for VNC bridge targets (supports placeholders like `{ip}` / `{ipv4}`).
- `LXC_VNC_BRIDGE_ALLOWED_HOSTS`: Comma-separated host:port allowlist for bridge targets in explicit URL mode.
- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4`: When `true`, derives bridge targets from discovered container IPv4 addresses.
- `LXC_VNC_BRIDGE_WS_SCHEME`: Websocket scheme for derived mode (`ws` or `wss`).
- `LXC_VNC_BRIDGE_WS_PORT`: Websocket bridge port for derived mode (playground policy range `8000`-`9000`, default example `8001`).
- `LXC_VNC_BRIDGE_WS_PATH`: Optional URL path appended in derived mode.

Bridge runtime configuration details are in section 2.

### A.7 Current `acctest-env.ps1` profile

- Password authentication with `PVE_USERNAME`, `PVE_PASSWORD`, and `PVE_REALM`.
- `PVE_INSECURE_TLS=true`.
- `PVE_ADMIN_CONTACT_EMAIL=thifm@hr.nl`.
- `PVE_VM_CLOUDINIT_STORAGE=local-lvm`.
- `PVE_VM_NETWORK_BRIDGE=vmbr0`.
- `PVE_VM_NETWORK_MODEL=virtio`.
- `PLAYGROUND_REFRESH_INTERVAL_SECONDS=5`.
- `PVE_LXC_HOOKSCRIPT_VOLID=local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE=local-lvm`.
- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`, `LXC_VNC_BRIDGE_WS_SCHEME=ws`, and `LXC_VNC_BRIDGE_WS_PORT=8001`.

Note: this guide is intended for Proxmox administrators only.
