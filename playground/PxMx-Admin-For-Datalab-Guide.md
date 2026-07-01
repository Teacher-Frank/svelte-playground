# PxMx Admin For Datalab Guide

This guide is for Proxmox administrators who have been given access to a newly deployed
Svelte Playground instance and need to configure it for production or lab use.

**What is the Svelte Playground?**
It is a web application that connects to your Proxmox cluster to manage VMs and LXC
containers from a browser — including terminal access, GUI (VNC) sessions, and lifecycle
actions like deploy, clone, start, stop, and reboot.

**Before you start:** you need SSH access to the Proxmox host and to the machine running
the playground server (usually the same machine or a Windows admin workstation).

**Scripts location:** All bash scripts referenced in this guide live in the playground
Git repository under `playground/scripts/`. Transfer them to the target machine with
`scp`, paste the contents, or download directly from the repo.

| Script | Target machine | Repo path |
|---|---|---|
| `setup-hookscript.sh` | Proxmox host | `playground/scripts/host/` |
| `setup-vm-template.sh` | Proxmox host | `playground/scripts/host/` |
| `deploy-cloudinit-snippets.sh` | Proxmox host | `playground/scripts/host/` |
| `install-guest-agent.sh` | Guest VM / container | `playground/scripts/guest/` |
| `install-vnc-bridge.sh` | Guest VM / container | `playground/scripts/guest/` |
| `vm-checklist-verify.sh` | Guest VM / container | `playground/scripts/guest/` |

## Table of contents

- [PxMx Admin For Datalab Guide](#pxmx-admin-for-datalab-guide)
  - [Table of contents](#table-of-contents)
  - [Quick start: get up and running](#quick-start-get-up-and-running)
  - [1. Proxmox host configuration](#1-proxmox-host-configuration)
    - [1.1 What is the Proxmox host?](#11-what-is-the-proxmox-host)
    - [1.2 Install the LXC post-create hook script](#12-install-the-lxc-post-create-hook-script)
    - [1.3 Prepare a VM template for cloning](#13-prepare-a-vm-template-for-cloning)
    - [1.4 Prepare a cloud-init ready VM template](#14-prepare-a-cloud-init-ready-vm-template)
      - [1.4.1 Why cloud-init is required for the deploy flow](#141-why-cloud-init-is-required-for-the-deploy-flow)
      - [1.4.2 Installing cloud-init in the template](#142-installing-cloud-init-in-the-template)
      - [1.4.4 Serial console getty (required for terminal access)](#144-serial-console-getty-required-for-terminal-access)
      - [1.4.3 NoCloud datasource (required for Proxmox)](#143-nocloud-datasource-required-for-proxmox)
    - [1.5 Enable nesting at LXC container creation](#15-enable-nesting-at-lxc-container-creation)
      - [1.5.1 Why nesting is required for Ubuntu 24.04](#151-why-nesting-is-required-for-ubuntu-2404)
    - [1.6 LXC device passthrough (done automatically by the hook script)](#16-lxc-device-passthrough-done-automatically-by-the-hook-script)
    - [1.7 QEMU guest agent — how it gets installed](#17-qemu-guest-agent--how-it-gets-installed)
      - [1.7.1 How the deploy flow installs the agent (default path)](#171-how-the-deploy-flow-installs-the-agent-default-path)
      - [1.7.2 Option A: auto-install via cloud-init snippet (cicustom)](#172-option-a-auto-install-via-cloud-init-snippet-cicustom)
      - [1.7.3 Option B: pre-install in the base template](#173-option-b-pre-install-in-the-base-template)
      - [1.7.4 Option C: install manually on an existing guest](#174-option-c-install-manually-on-an-existing-guest)
    - [1.8 Troubleshooting host-side issues](#18-troubleshooting-host-side-issues)
  - [2. Guest VM / container setup](#2-guest-vm--container-setup)
    - [2.1 What is a guest and why does it need configuration?](#21-what-is-a-guest-and-why-does-it-need-configuration)
    - [2.2 Guest-side bash scripts](#22-guest-side-bash-scripts)
    - [2.3 VNC and websockify (required for GUI access)](#23-vnc-and-websockify-required-for-gui-access)
    - [2.4 Run the verification checklist](#24-run-the-verification-checklist)
  - [3. Webserver configuration](#3-webserver-configuration)
    - [3.1 First-run setup](#31-first-run-setup)
    - [3.2 Environment profiles (Windows admin workstation)](#32-environment-profiles-windows-admin-workstation)
    - [3.3 LXC VNC bridge configuration](#33-lxc-vnc-bridge-configuration)
    - [3.4 Troubleshooting: VNC page stuck on "Submitting credentials..."](#34-troubleshooting-vnc-page-stuck-on-submitting-credentials)
  - [4. How the playground automates VM deployment](#4-how-the-playground-automates-vm-deployment)
    - [4.1 VM clone flow](#41-vm-clone-flow)
    - [4.1.1 Why the two-phase architecture?](#411-why-the-two-phase-architecture)
    - [4.1.2 Serial port for terminal access](#412-serial-port-for-terminal-access)
    - [4.2 Deploy outcomes and failure detection](#42-deploy-outcomes-and-failure-detection)
      - [4.2.1 What happens when a deploy fails?](#421-what-happens-when-a-deploy-fails)
      - [4.2.2 Deploy visibility timing](#422-deploy-visibility-timing)
    - [4.3 DHCP to static IP conversion](#43-dhcp-to-static-ip-conversion)
    - [4.4 LXC container deploy flow](#44-lxc-container-deploy-flow)
  - [Appendix A. Environment variables](#appendix-a-environment-variables)
    - [A.1 Proxmox connection and authentication](#a1-proxmox-connection-and-authentication)
    - [A.2 VM deployment and storage](#a2-vm-deployment-and-storage)
    - [A.3 LXC deployment and storage](#a3-lxc-deployment-and-storage)
    - [A.4 Terminal and runtime](#a4-terminal-and-runtime)
    - [A.5 Diagnostics and benchmarking](#a5-diagnostics-and-benchmarking)
    - [A.6 LXC VNC bridge variables](#a6-lxc-vnc-bridge-variables)
    - [A.7 Current `acctest-env.ps1` profile](#a7-current-acctest-envps1-profile)
  - [Appendix B. Troubleshooting index](#appendix-b-troubleshooting-index)

## Quick start: get up and running

Follow these steps in order. Each step is explained in detail in the sections that follow.

1. **SSH into the Proxmox host** and copy `playground/scripts/host/setup-hookscript.sh`
   to the host, then run:
   ```bash
   sudo bash setup-hookscript.sh
   ```
2. **Prepare a VM template** (optional — only if you plan to deploy/clone VMs).
   Copy `playground/scripts/host/setup-vm-template.sh` to the Proxmox host, then run:
   ```bash
   sudo bash setup-vm-template.sh <template-vmid>
   ```
3. **Set up guest agent auto-install on the host** (optional — recommended for VM clones).
   Copy `playground/scripts/host/deploy-cloudinit-snippets.sh` to the Proxmox host, then run:
   ```bash
   sudo bash deploy-cloudinit-snippets.sh
   ```
   Alternatively, pre-install the agent in the template directly (see [Section 1.7](#17-qemu-guest-agent--how-it-gets-installed)).
4. **On your Windows admin workstation**, edit the environment profile (`acctest-env.ps1`)
   and update the credentials and URLs for your Proxmox cluster (see [Section 3.2](#32-environment-profiles-windows-admin-workstation)).
5. **Run the environment profile** to start the playground dev server:
   ```powershell
   .\acctest-env.ps1
   ```
6. **Open the browser** at `https://localhost:8000/proxmox`.
7. **After deploying your first guest**, copy the scripts from `playground/scripts/guest/`
   to the guest, SSH into it, and run:
   ```bash
   sudo bash vm-checklist-verify.sh
   ```
   Then run whichever install scripts the verify script says are missing.

---

## 1. Proxmox host configuration

### 1.1 What is the Proxmox host?

The Proxmox host is the physical (or virtual) server running Proxmox VE — the hypervisor
that manages your VMs and LXC containers. The playground connects to it via the Proxmox API.

You will need SSH access to this machine to run the setup scripts in this section.

### 1.2 Install the LXC post-create hook script

**What this does:** Every time the playground creates an LXC container, Proxmox needs to
injected two configuration lines into the container config so the dummy VNC GPU hardware
works. This hook script does that automatically.

**How to install:**

1. Copy `playground/scripts/host/setup-hookscript.sh` to the Proxmox host (e.g., via `scp`,
   `rsync`, or paste the contents into a file on the host).
2. Run it:

```bash
sudo bash setup-hookscript.sh
```

This creates `/var/lib/vz/snippets/lxc-post-create-hook.sh` with the correct content
and permissions.

3. In the playground environment profile (`acctest-env.ps1`), set:

```powershell
$env:PVE_LXC_HOOKSCRIPT_VOLID = "local:snippets/lxc-post-create-hook.sh"
```

If your snippets storage is different from `local`, change the prefix accordingly
(e.g., `fast-ssd:snippets/lxc-post-create-hook.sh`).

**Verifying the hook works:** After deploying a test container, check its config:
```bash
cat /etc/pve/lxc/<VMID>.conf | grep -E "cgroup2|mount.entry"
```
You should see the `c 226:* rwm` and `/dev/dri` lines.

### 1.3 Prepare a VM template for cloning

**What this does:** The playground needs a VM template (a "golden image") to clone new VMs
from. This script ensures the template has the guest agent enabled, network interface
attached to the correct bridge, DHCP configured, and a cloud-init drive attached.

**How to prepare:**

1. Download a VM template to Proxmox first. Go to Datacenter → Content → Cookbook (or use
   `pveam` from the CLI) and download an Ubuntu/Debian template.
2. Create a base VM from the template (Proxmox GUI: Content → Templates → right-click →
   Restore, or use `pveam` / `qm` commands). Note the VMID of the VM.
3. Copy `playground/scripts/host/setup-vm-template.sh` to the Proxmox host.
4. Run the preparation script:

```bash
sudo bash setup-vm-template.sh <vmid>
```

Optional — custom bridge and storage:
```bash
sudo bash setup-vm-template.sh <vmid> vmbr1 fast-ssd
```

4. Convert the VM to a template in Proxmox GUI (right-click → Convert to template) or:
   ```bash
   qm template <vmid>
   ```

**What the script checks and fixes:**

| Check | Action if missing |
|---|---|
| Guest agent (`agent: 1`) | Enables it via `qm set` |
| Network interface `net0` on bridge | Adds `net0 virtio,bridge=vmbr0` |
| DHCP on `ipconfig0` | Sets `ipconfig0 ip=dhcp` |
| Cloud-init drive (`ide2`) | Attaches `ide2=<storage>:cloudinit` |

### 1.4 Prepare a cloud-init ready VM template

**What this does:** Prepares a VM template so that deployed clones receive cloud-init
configuration (username/password, network) on first boot, and so the deploy flow's
custom cloud-init snippet can install `qemu-guest-agent` automatically.

**Why is this needed?** Cloud images from Proxmox Cookbook (Debian, Ubuntu Server, etc.)
include `cloud-init` by default. Desktop images (Ubuntu Desktop, Windows, custom images)
typically do not. Without cloud-init, the playground cannot inject credentials or execute
the `runcmd` snippet that installs the guest agent.

The deploy flow installs `qemu-guest-agent` automatically on first boot via a `cicustom`
cloud-init snippet (see [Section 1.7.2](#172-option-a-auto-install-via-cloud-init-snippet-cicustom)).
The template only needs `cloud-init` — **not** the guest agent itself.

#### 1.4.1 Why cloud-init is required for the deploy flow

The playground uses Proxmox's cloud-init integration (`cicustom`, `ciuser`, `cipassword`,
`ipconfig0`) to configure new VMs at deploy time. This works as follows:

1. The playground sets `ipconfig0=ip=dhcp` and attaches a cloud-init disk (`ide2`)
2. The playground sets `cicustom` to point to a cloud-init snippet that installs
   `qemu-guest-agent` via `runcmd`
3. On first boot, the guest's `cloud-init` service reads both the auto-generated config
   (credentials, network) and the custom snippet
4. Cloud-init executes the snippet, installing and enabling the guest agent
5. Once the guest agent reports an IP, the playground converts DHCP to static

Without cloud-init in the guest OS:
- Credentials cannot be injected
- `cicustom` snippets are ignored — the guest agent never installs
- IP discovery fails → deploy will fail after the grace period

#### 1.4.2 Installing cloud-init in the template

**For Ubuntu/Debian:** Boot the template VM and SSH in (or use the Proxmox console).

```bash
# Install cloud-init
sudo apt update && sudo apt install -y cloud-init

# Configure NoCloud datasource — required for Proxmox cloud-init to work
sudo sed -i '/^datasource_list:/c\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg

# Disable cloud-init persistence so it runs fresh on each clone
sudo cloud-init clean

# Enable serial console getty — required for web terminal access (Section 4.1.2)
# Without this, termproxy connects to the serial port but no login prompt appears.
sudo systemctl enable --now serial-getty@ttyS0.service
```

**For RHEL/CentOS/Fedora:**
```bash
sudo dnf install -y cloud-init

# Configure NoCloud datasource
sudo sed -i '/^datasource_list:/c\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg

# Disable cloud-init persistence
sudo cloud-init clean

# Enable serial console getty — required for web terminal access
sudo systemctl enable --now serial-getty@ttyS0.service
```

After installing cloud-init, shut down the VM and convert it to a template:
```bash
qm template <vmid>
```

#### 1.4.4 Serial console getty (required for terminal access)

The playground's terminal feature connects via Proxmox's `termproxy` endpoint, which
attaches to the VM's serial port. However, the serial port is just a pipe — the guest OS
must have a getty/login process listening on it.

**Symptom of missing serial-getty:** Terminal page shows `"starting serial terminal on
interface serial0"` then hangs forever. No shell prompt appears, typing does nothing.
This also affects the native Proxmox web console.

**Automatic path (default):** The deploy flow's cloud-init vendor snippet enables
`serial-getty@ttyS0` on every cloned VM during first boot (Section 1.7.2). This is
idempotent, so if you also enable it in the template there's no conflict.

**Fix in template (recommended for non-cloud images):** If your template uses a distro or
init system not supported by the cloud-init snippet, enable `serial-getty@ttyS0` in the
golden template before converting it (see commands above). This ensures all cloned VMs
inherit the setting.

**Fix on existing VM:** Access via VNC/spice console and run:
```bash
sudo systemctl enable --now serial-getty@ttyS0.service
```

No reboot required — the getty starts immediately and the next terminal connection will
show a login prompt.

**Kernel console parameter (optional but recommended):** For full serial output visibility
(boot messages, kernel panics), ensure the kernel passes console to ttyS0:
```bash
# Check current GRUB config
grep GRUB_CMDLINE_LINUX /etc/default/grub

# Add console=ttyS0,115200n8 if not present
sudo sed -i 's/GRUB_CMDLINE_LINUX="/GRUB_CMDLINE_LINUX="console=ttyS0,115200n8 /' /etc/default/grub
sudo update-grub
```

> **Note:** The deploy flow both adds `serial0=socket` if the clone lacks a serial port
> (Section 4.1.2) **and** enables `serial-getty@ttyS0` during first boot via the cloud-init
> vendor snippet. So for cloud-init-capable templates, terminal access should work out of
> the box after deployment.

#### 1.4.3 NoCloud datasource (required for Proxmox)

Proxmox cloud-init injects configuration via an ISO disk (the NoCloud datasource). If
`datasource_list` in `/etc/cloud/cloud.cfg` does not include `NoCloud`, cloud-init will
ignore the injected config even if the package is installed.

The `sed` command above replaces whatever `datasource_list` was set to with
`[NoCloud, None]`. If your template image has no `datasource_list` line at all, add one:
```bash
# Append if the line doesn't exist
sudo grep -q '^datasource_list:' /etc/cloud/cloud.cfg || \
  echo 'datasource_list: [NoCloud, None]' | sudo tee -a /etc/cloud/cloud.cfg
```

For non-cloud images (Ubuntu Desktop, custom images, etc.) that lack cloud-init, you
must install it in the template before converting to template:

```bash
# Inside the template VM — install cloud-init only; the deploy flow installs the agent
sudo apt update && sudo apt install -y cloud-init

# Configure NoCloud datasource — required for Proxmox cloud-init to work
sudo sed -i '/^datasource_list:/c\datasource_list: [NoCloud, None]' /etc/cloud/cloud.cfg

# Disable cloud-init persistence so it runs fresh on each clone
sudo cloud-init clean
```

Then in Proxmox GUI: shut down the VM and convert it to template (`qm template <vmid>`).

> **The deploy flow will install `qemu-guest-agent` on first boot** via the `cicustom`
> cloud-init snippet (Section 1.7.2). You only need `cloud-init` in the template.

### 1.5 Enable nesting at LXC container creation

When creating a new LXC container (via API or CLI), set `nesting=1`.

API example:
```
POST /api2/json/nodes/<node>/lxc
features=nesting=1
```

CLI example:
```bash
pct create <VMID> ... -features nesting=1
```

#### 1.5.1 Why nesting is required for Ubuntu 24.04

Newer Ubuntu 24.04 templates use a `systemd` version that requires CPU virtualization
features inside the container. Without nesting, Ubuntu 24.04 containers may start
without a working console or network — even if the rest of the config is correct.

**Security note:** Always deploy Ubuntu 24.04 containers as **unprivileged + nesting**.
Avoid `privileged + nesting` as this significantly weakens container isolation. The
playground enforces this for Ubuntu 24.04 deployments automatically.

### 1.6 LXC device passthrough (done automatically by the hook script)

The hook script installed in [Section 1.2](#12-install-the-lxc-post-create-hook-script)
automatically appends these lines to every new container's config:

```
lxc.cgroup2.devices.allow: c 226:* rwm
lxc.mount.entry: /dev/dri dev/dri none bind,optional,create=dir
```

You do not need to add these manually. Restart the container after the hook has run if
the container was created before the hook was installed.

### 1.7 QEMU guest agent — how it gets installed

The QEMU guest agent enables the playground to discover VM IP addresses, collect
guest-side metrics, and perform graceful shutdowns. **The deploy flow installs it
automatically** on first boot via a `cicustom` cloud-init snippet.

Without it, a deployed VM will show:
- VM IP as `?` in the playground UI
- Automatic DHCP → static IP conversion cannot trigger
- Graceful shutdown from the UI won't work

#### 1.7.1 How the deploy flow installs the agent (default path)

The playground's deploy flow automatically sets `cicustom=vendor=local:snippets/install-agent.yaml`
on each cloned VM. This points to a cloud-init vendor-data snippet that was deployed by
`deploy-cloudinit-snippets.sh` (Step 3 of the [Quick start](#quick-start-get-up-and-running)).

On first boot, cloud-init reads the snippet and executes:
```bash
apt-get update && apt-get install -y qemu-guest-agent
systemctl enable --now qemu-guest-agent
```

**Prerequisites for this path:**
1. The template must have `cloud-init` installed (Section 1.4)
2. The `install-agent.yaml` snippet must exist on the Proxmox host
   (deployed by `deploy-cloudinit-snippets.sh`)
3. The `PVE_SNIPPET_STORAGE` environment variable must point to valid storage
   (default: `local`)

#### 1.7.2 Option A: auto-install via cloud-init snippet (cicustom)

This is the **default and recommended** approach. The deploy flow handles everything.

One-time host setup:
```bash
sudo bash deploy-cloudinit-snippets.sh
```

This creates `/var/lib/vz/snippets/install-agent.yaml` — a cloud-init user-data file
that installs and enables `qemu-guest-agent` on first boot via `runcmd`.

> **Note:** If your storage with `snippets` support differs from `local`, set
> `PVE_SNIPPET_STORAGE` before running:
> ```bash
> PVE_SNIPPET_STORAGE=fast-ssd sudo bash deploy-cloudinit-snippets.sh
> ```

#### 1.7.3 Option B: pre-install in the base template

If cloud-init is unavailable in your template (e.g., Windows guests without WSL),
you can pre-install the agent in the VM template image before deploying from it:

1. Boot the template VM and SSH in (or use the Proxmox console).
2. On Debian/Ubuntu:
   ```bash
   sudo apt-get update && sudo apt-get install -y qemu-guest-agent
   sudo systemctl enable --now qemu-guest-agent
   ```
3. On RHEL/CentOS:
   ```bash
   sudo yum install -y qemu-guest-agent
   sudo systemctl enable --now qemu-guest-agent
   ```
4. In Proxmox GUI, enable guest-agent support on the template
   (Hardware → Agent → check "Enable").
5. Shut down the VM and convert it to a template.

> **Note:** The deploy flow sets `agent=enabled=1` on cloned VMs, which enables the
> virtio serial channel on the Proxmox side. However, this alone does not install the
> agent inside the guest — the binary must be present.

#### 1.7.4 Option C: install manually on an existing guest

If you're adding the agent to an already-deployed VM, or the other methods failed:

1. SSH into the guest (or use the playground terminal).
2. Run:
   ```bash
   sudo bash install-guest-agent.sh
   ```

After installation, the playground will detect the guest agent on the next data refresh
and display the VM's IP.

### 1.8 Troubleshooting host-side issues

| Symptom | Fix |
|---|---|
| Xorg fails with "no screens found" in an LXC guest | Ensure the hook script has run (Section 1.2) and the container has been restarted |
| Container created but no `/dev/dri` | Run the hook script manually or re-install via `setup-hookscript.sh`, then restart the container |
| VM clone fails with cloud-init LV collision | A stale cloud-init volume exists for that VMID. Remove it (`qm set <vmid> --delete ide2`) and retry deploy |
| Hook script not found error on deploy | Confirm `PVE_LXC_HOOKSCRIPT_VOLID` in `acctest-env.ps1` points to the correct storage path |
| VM IP shows as `?` in UI | Guest agent not installed or not running — check that the template has cloud-init (Section 1.4) and that the snippet was deployed (Section 1.7.2) |

---

## 2. Guest VM / container setup

### 2.1 What is a guest and why does it need configuration?

A "guest" is the VM or LXC container that runs inside Proxmox. Think of it as a virtual
computer. After the playground deploys or clones a guest, it needs certain packages
installed so the playground can:

- Discover the guest IP address (requires **QEMU guest agent** — see Section 1.7)
- Provide GUI/VNC access (requires **VNC server + websockify bridge**)
- Convert DHCP to static IP (requires **guest agent**)

The QEMU guest agent is configured on the Proxmox host side (Chapter 1). The guest
side needs the following to work properly:

1. **VNC + websockify bridge** for GUI access (Section 2.3)
2. **Verification checklist** to confirm all components are working (Section 2.4)

### 2.2 Guest-side bash scripts

The following scripts live in `playground/scripts/guest/` in the Git repository. Copy them
to the target guest and run with `sudo bash`:

| Script | What it does | Required? |
|---|---|---|
| `install-vnc-bridge.sh` | Installs websockify as a systemd service for GUI access | Only if you need GUI/VNC |
| `vm-checklist-verify.sh` | Checks all prerequisites and reports status | Use first to see what's needed |

**Quick start inside a guest** (after copying the scripts from `playground/scripts/guest/`):
```bash
# First, check what's missing
sudo bash vm-checklist-verify.sh

# Optional: install VNC bridge
sudo bash install-vnc-bridge.sh
```

See `playground/scripts/guest/README.md` for detailed usage.

### 2.3 VNC and websockify (required for GUI access)

To access the guest desktop from the playground browser, two components must run inside
the guest:

1. **A VNC server** listening on port `5901` (you need to install this yourself — e.g.,
   `x11vnc` or `tigervnc`).
2. **websockify** listening on port `8001` — this bridges websockets from the browser to
   the VNC server.

**Install websockify with one command:**
```bash
sudo bash install-vnc-bridge.sh
```

This installs the websockify package and creates a systemd service that starts on boot.

**Options:**
```bash
# Custom bridge port
sudo bash install-vnc-bridge.sh --port 8080

# Just install the package (start manually later)
sudo bash install-vnc-bridge.sh --no-service

# Test in foreground with verbose output
sudo bash install-vnc-bridge.sh --standalone
```

**How the VNC bridge works:** The playground server connects to `ws://<guest-ip>:8001`.
websockify forwards this connection to `127.0.0.1:5901` (the VNC server). You can see
this flow in the diagram below:

```
Browser → Playground server → websockify (:8001) → VNC server (:5901) → Guest desktop
```

### 2.4 Run the verification checklist

After installing the guest-side components, run:

```bash
sudo bash vm-checklist-verify.sh
```

This checks:
- QEMU guest agent installed and running
- Cloud-init installed with NoCloud datasource
- Serial console getty (required for terminal access)
- Kernel serial console parameter (recommended)
- LXC device passthrough for VNC (LXC only)
- VNC server listening on port 5901 (optional)
- websockify bridge listening on port 8001 (optional)
- Network connectivity (IPv4 address and internet reachability)
- Static IP configuration (warning if DHCP is detected; see [4.3 DHCP to static IP conversion](#43-dhcp-to-static-ip-conversion))

A summary shows passed, failed, and warning counts. If any check fails, the output
includes the fix command.

---

## 3. Webserver configuration

### 3.1 First-run setup

The playground runs as a web server (Node.js + SvelteKit) on the machine that connects
to Proxmox. For the Datalab admin deployment, this is a Windows workstation.

To start the server:

1. Set environment variables in an environment profile (see [Section 3.2](#32-environment-profiles-windows-admin-workstation)).
2. Run the profile script:
   ```powershell
   .\acctest-env.ps1
   ```
3. Open a browser to `https://localhost:8000/proxmox`.

### 3.2 Environment profiles (Windows admin workstation)

Environment profiles are PowerShell scripts that set the required environment variables
and start the playground dev server. Three profiles are available:

| Profile | When to use |
|---|---|
| `acctest-env.ps1` | Active testing against a real Proxmox cluster (default for admin use) |
| `dev-env.ps1` | Local development without Proxmox connection |
| `test-env.ps1` | Automated testing environment |

**Editing `acctest-env.ps1`:**

At minimum, update these values:

```powershell
$env:PVE_BASE_URL = "https://<your-proxmox-host>:8006"
$env:PVE_NODE = "<your-node-name>"
$env:PVE_USERNAME = "root"
$env:PVE_PASSWORD = "<your-password>"
$env:PVE_REALM = "pam"
```

Full list of configurable variables is in [Appendix A](#appendix-a-environment-variables).

### 3.3 LXC VNC bridge configuration

The playground uses "derived mode" for LXC VNC websocket targets. It builds websocket
URLs as `ws://<container-ip>:<port>` using the container's discovered IPv4 address.

Set these variables in your environment profile:

```powershell
$env:LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 = "true"
$env:LXC_VNC_BRIDGE_WS_SCHEME = "ws"
$env:LXC_VNC_BRIDGE_WS_PORT = "8001"
$env:LXC_VNC_BRIDGE_WS_PATH = ""
```

| Variable | Purpose |
|---|---|
| `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4` | When `true`, derives bridge targets from container IPv4 addresses |
| `LXC_VNC_BRIDGE_WS_SCHEME` | Websocket scheme (`ws` or `wss`) |
| `LXC_VNC_BRIDGE_WS_PORT` | Bridge port (allowed range `8000`–`9000`, default `8001`) |
| `LXC_VNC_BRIDGE_WS_PATH` | Optional URL path appended to the websocket target |

**Important:** Restart the playground server after changing these variables. Server-side
websocket proxy behavior won't update in an already running process.

### 3.4 Troubleshooting: VNC page stuck on "Submitting credentials..."

If the VNC page shows "Submitting credentials..." and never connects:

1. **Restart the playground server.** Run `.\acctest-env.ps1` again (kill existing Node
   processes first if needed). This loads the latest environment and VNC code changes.

2. **Confirm bridge variables are set correctly:**
   - `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`
   - `LXC_VNC_BRIDGE_WS_PORT=8001` (matching the websockify port on the guest)

3. **Verify websockify and VNC are listening inside the guest:**
   ```bash
   ss -tlnp | grep -E "8001|5901"
   ```

4. **Test websockify in verbose mode:**
   ```bash
   sudo websockify --verbose 8001 127.0.0.1:5901
   ```
   If the output shows `Target closed connection` immediately, the VNC server
   authentication is failing. Restart VNC inside the guest (e.g., via
   `~/.local/bin/vnc-boot.sh` if that script exists, or `systemctl restart x11vnc`).

5. **Check if the guest has an IPv4 address.** The playground GUI action stays disabled
   until the container IP is discovered. Run the verification script:
   ```bash
   sudo bash vm-checklist-verify.sh
   ```

**How the VNC bridge works end-to-end:**

```
Browser → Playground server → websockify (:8001 on guest) → VNC server (:5901 on guest) → Guest desktop
```

The playground uses "derived mode" — it builds websocket targets as
`ws(s)://<container-ip>:<port><path>` automatically. If no container IP is available
yet, the GUI action remains disabled until discovery completes.

Operational notes:
- Restart the playground server after changing bridge variables.
- The websocket proxy only allows derived targets on the configured bridge port.

---

## 4. How the playground automates VM deployment

This section explains what happens behind the scenes when you click "Deploy VM" in the
playground admin page. Understanding this flow helps troubleshoot issues.

### 4.1 VM clone flow

The deploy process runs in two phases:

1. **Clone (immediate):** The playground clones the selected VM template on Proxmox and
   returns control to the UI immediately (you see a "Deploying..." row).
2. **Configure + start (background):** After the clone task completes, the playground
   runs the following steps in the background:
   - If the clone is missing a network interface, the playground adds `net0` on the
     configured bridge (`PVE_VM_NETWORK_BRIDGE`, default `vmbr0`).
   - If the clone is missing DHCP configuration, the playground sets `ipconfig0 ip=dhcp`.
   - If the clone is missing a cloud-init drive, the playground attaches
     `ide2=<storage>:cloudinit` (`PVE_VM_CLOUDINIT_STORAGE`, default `local-lvm`).
   - The playground sets `cicustom` to point to the cloud-init guest-agent install snippet.
   - If the clone has no usable serial port, the playground adds `serial0=socket` for
     terminal access (see [Section 4.1.2](#412-serial-port-for-terminal-access)).
   - The playground starts the cloned VM.
   - On first boot, cloud-init installs the QEMU guest agent (if the template was
     prepared correctly — see [Section 1.4](#14-prepare-a-cloud-init-ready-vm-template)).

If any background step fails after the clone has completed, the playground will
automatically destroy the orphan VM (stop if running, then delete with purge).

### 4.1.1 Why the two-phase architecture?

The clone operation can take a minute or more. With the two-phase design, the UI
displays the "Deploying..." status immediately rather than showing a loading spinner
while waiting for the HTTP response. The configure + start steps run as a background
task on the server.

### 4.1.2 Serial port for terminal access

The playground's terminal feature connects to VMs via the Proxmox `termproxy` endpoint,
which requires a serial console configured on the VM. The deploy flow automatically
adds `serial0=socket` if the clone doesn't already have a usable serial port.

If an existing template lacks a serial port and you want terminal access, either:
- Let the deploy flow add it automatically (recommended)
- Add `serial0=socket` manually in Proxmox: `qm set <vmid> --serial0 socket` (requires
  a VM reboot to take effect)

### 4.2 Deploy outcomes and failure detection

The playground tracks the state of every deploy and provides visual feedback:

| Status | When it appears | Auto-removed? |
|---|---|---|
| **Deploying...** | Immediately after submit; shows a blue badge | Yes — when workload appears or failure detected |
| **deploy-failed** | After 60s grace period if tasks settled but workload doesn't exist | Yes — after 10s with an error notification |

#### 4.2.1 What happens when a deploy fails?

If the background configure + start task fails after the clone has completed:
1. The server automatically destroys the orphan VM (stops it if running, then deletes
   with purge).
2. The UI detects the failure after a **60-second grace period** following task
   completion (this covers orphan cleanup time and any slow backend processing).
3. The workload row shows a red "deploy-failed" badge for **10 seconds** before being
   auto-removed.
4. An inline error toast notification appears with context about the failure.

**Common reasons for deploy failure:**
- **Template lacks cloud-init** — Non-cloud images (Ubuntu Desktop, Windows) without
  `cloud-init` cannot process the `cicustom` snippet. Fix: install `cloud-init` in
  the template (Section 1.4).
- **Snippet not deployed** — `install-agent.yaml` is missing from Proxmox snippets
  storage. Fix: run `deploy-cloudinit-snippets.sh` (Section 1.7.2).
- **Storage or network error** during clone or start operations.

#### 4.2.2 Deploy visibility timing

| Constant | Value | Purpose |
|---|---|---|
| Minimum "deploying" visible time | 30s | Prevents flash of deploy-complete before data refresh |
| Failure grace period | 60s | Wait after tasks settle before declaring failure |
| "deploy-failed" visible time | 10s | Brief red badge before auto-removal |
| Hard cap | 10 minutes | Maximum time before forced cleanup of stale entries |

### 4.3 DHCP to static IP conversion

Every deployed VM initially receives a DHCP address. There are **two layers** of
automatic DHCP-to-static conversion — both are idempotent and safe to coexist:

1. **Cloud-init snippet (guest-side):** If the `install-agent.yaml` snippet was deployed
   to the Proxmox host (via `deploy-cloudinit-snippets.sh`, Section 1.7.2), it includes
   a `runcmd` that rewrites the Ubuntu netplan YAML: sets `dhcp4: false`, writes the
   discovered IP with `/24` prefix, adds a default route, and configures DNS (`1.1.1.1`,
   `8.8.8.8`). This runs on first boot **inside the guest** and survives networkManager
   restarts or template drift.

2. **Playground server (Proxmox side):** Once the guest agent reports the first IPv4
   address, the playground converts `ipconfig0` to a static IP
   (e.g., `ip=145.24.222.128/24`) via the Proxmox API. This ensures the Proxmox-level
   ZKBMetadata stays in sync and the IP appears correctly in the Proxmox GUI.

- The playground server conversion happens without user interaction on the next page
  refresh, and a green toast notification confirms it.
- The cloud-init snippet conversion requires the snippet to be deployed (Section 1.7.2)
  and is independent of the playground server — it will work even if the playground is
  not running at boot time.
- If both mechanisms run, the second one is a no-op (the IP is already static).
- This only works if the guest agent is running (Section 1.7).

Manual override (if automatic conversion fails):
```bash
qm set <vmid> --ipconfig0 ip=145.24.222.128/24
```

### 4.4 LXC container deploy flow

1. The playground creates the LXC container with `nesting=1`.
2. Proxmox runs the post-create hook script (installed in [Section 1.2](#12-install-the-lxc-post-create-hook-script)).
3. The hook script appends device passthrough entries to the container config.
4. The playground starts the container.

---

## Appendix A. Environment variables

This appendix documents environment variables used by the admin environment profiles
(`dev-env.ps1`, `test-env.ps1`, and `acctest-env.ps1`). This is the canonical
environment variable inventory for the playground. When adding a new environment
variable in code or scripts, update this guide in the same change.

### A.1 Proxmox connection and authentication

- `PVE_BASE_URL`: Base URL of the Proxmox API endpoint, including protocol and port (example: `https://<host>:8006`).
- `PVE_NODE`: Preferred Proxmox node name used for node-scoped operations.
- `PVE_API_TOKEN`: Proxmox API token for token-based authentication. Use this instead of username/password when available.
- `PVE_USERNAME`: Proxmox username for password authentication.
- `PVE_PASSWORD`: Password for `PVE_USERNAME`.
- `PVE_REALM`: Proxmox authentication realm (for example `pam`, `pve`, or LDAP realms).
- `PVE_INSECURE_TLS`: Set to `true` to allow self-signed or otherwise untrusted TLS certificates.

### A.2 VM deployment and storage

- `PVE_VM_CLOUDINIT_STORAGE`: Preferred storage name for VM cloud-init disks in automation workflows (example: `local-lvm`).
- `PVE_VM_NETWORK_BRIDGE`: Bridge used when VM deploy must add a missing NIC (`net0`) to a cloned VM (default: `vmbr0`).
- `PVE_VM_NETWORK_MODEL`: Proxmox NIC model used when VM deploy must add a missing NIC (`net0`) to a cloned VM (default: `virtio`).
- `PVE_SNIPPET_STORAGE`: Proxmox storage ID for cloud-init snippets (default: `local`). Must support `snippets` content-type. Used by `deploy-cloudinit-snippets.sh` and the deploy flow `cicustom` parameter.

### A.3 LXC deployment and storage

- `PVE_LXC_HOOKSCRIPT_VOLID`: Hookscript volume ID in Proxmox format `<storage>:snippets/<file>`. Example: `local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE`: Target storage for new LXC root filesystem allocation when deploying from storage templates. This storage must support `rootdir` / container directories (example: `local-lvm`).

### A.4 Terminal and runtime

- `PVE_TERMINAL_TRACE`: Enables verbose terminal proxy/debug logging when set to `true`.
- `NODE_ENV`: Node.js runtime mode (typically `development` for local/admin use).

### A.5 Diagnostics and benchmarking

- `PLAYGROUND_PROFILE_LOAD`: Enables timing/profile logs for Proxmox page load paths when set to `true`.
- `PLAYGROUND_REFRESH_INTERVAL_SECONDS`: Default auto-refresh interval for the PxMxAdmin screen, in seconds (minimum `1`, maximum `3600`, default `5`).
- `PLAYGROUND_DEV_BENCH_RUNS`: Number of benchmark runs for `npm run bench:dev-startup` (default `4`).
- `PLAYGROUND_DEV_BENCH_BASE_PORT`: Base port used by dev-startup benchmarking (default `45173`).

### A.6 LXC VNC bridge variables

- `LXC_VNC_BRIDGE_WS_URL`: Explicit websocket URL template for VNC bridge targets (supports placeholders like `{ip}` / `{ipv4}`).
- `LXC_VNC_BRIDGE_ALLOWED_HOSTS`: Comma-separated host:port allowlist for bridge targets in explicit URL mode.
- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4`: When `true`, derives bridge targets from discovered container IPv4 addresses.
- `LXC_VNC_BRIDGE_WS_SCHEME`: Websocket scheme for derived mode (`ws` or `wss`).
- `LXC_VNC_BRIDGE_WS_PORT`: Websocket bridge port for derived mode (playground policy range `8000`-`9000`, default example `8001`).
- `LXC_VNC_BRIDGE_WS_PATH`: Optional URL path appended in derived mode.

Bridge runtime configuration details are in [Section 3.3](#33-lxc-vnc-bridge-configuration).

### A.7 Current `acctest-env.ps1` profile

- Password authentication with `PVE_USERNAME`, `PVE_PASSWORD`, and `PVE_REALM`.
- `PVE_INSECURE_TLS=true`.
- `PVE_VM_CLOUDINIT_STORAGE=local-lvm`.
- `PVE_VM_NETWORK_BRIDGE=vmbr0`.
- `PVE_VM_NETWORK_MODEL=virtio`.
- `PVE_SNIPPET_STORAGE=local`.
- `PLAYGROUND_REFRESH_INTERVAL_SECONDS=5`.
- `PVE_LXC_HOOKSCRIPT_VOLID=local:snippets/lxc-post-create-hook.sh`.
- `PVE_LXC_ROOTFS_STORAGE=local-lvm`.
- `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`, `LXC_VNC_BRIDGE_WS_SCHEME=ws`, and `LXC_VNC_BRIDGE_WS_PORT=8001`.

---

## Appendix B. Troubleshooting index

| Symptom | Likely cause | Section |
|---|---|---|
| Terminal stuck on "starting serial terminal" | No `serial-getty@ttyS0` running in guest | [1.4.4 Serial console getty](#144-serial-console-getty-required-for-terminal-access) |
| Xorg fails with "no screens found" in LXC | Missing device passthrough; hook script not installed | [1.5 LXC device passthrough](#15-lxc-device-passthrough-done-automatically-by-the-hook-script) |
| Container created but no `/dev/dri` | Hook script didn't run | [1.2 Install the LXC post-create hook script](#12-install-the-lxc-post-create-hook-script) |
| VM clone fails with cloud-init LV collision | Stale cloud-init volume for that VMID | Section [1.8 Troubleshooting host-side issues](#18-troubleshooting-host-side-issues) |
| Hook script "file not found" on deploy | `PVE_LXC_HOOKSCRIPT_VOLID` path is wrong | [1.2 Install the LXC post-create hook script](#12-install-the-lxc-post-create-hook-script) |
| Static IP conversion doesn't happen | Guest agent hasn't reported an IP yet, or cloud-init snippet failed to install the agent | [Section 1.7](#17-qemu-guest-agent---how-it-gets-installed), [Section 4.3](#43-dhcp-to-static-ip-conversion) |
| Deploy stuck for 10 minutes then disappears | No cloud-init in template, so `cicustom` snippet can't run — agent never installs | [Section 1.4](#14-prepare-a-cloud-init-ready-vm-template) |
| "Submitting credentials..." stuck | See dedicated troubleshooting steps below | [3.4 VNC troubleshooting](#34-troubleshooting-vnc-page-stuck-on-submitting-credentials) |
| GUI action is grayed/disabled | Guest IP not yet discovered | [2.4 Run the verification checklist](#24-run-the-verification-checklist) |
| VNC page shows "Target closed connection" | VNC server auth failing inside guest | [3.4 VNC troubleshooting](#34-troubleshooting-vnc-page-stuck-on-submitting-credentials) |
| Ubuntu 24.04 LXC has no console or network | Missing `nesting=1` feature flag | [1.4 Enable nesting](#14-enable-nesting-at-lxc-container-creation) |

---

Note: this guide is intended for Proxmox administrators only.
