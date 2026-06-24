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
      - [1.4.3 Cloud-init + QEMU guest agent combined (recommended)](#143-cloud-init--qemu-guest-agent-combined-recommended)
    - [1.5 Enable nesting at LXC container creation](#15-enable-nesting-at-lxc-container-creation)
      - [1.5.1 Why nesting is required for Ubuntu 24.04](#151-why-nesting-is-required-for-ubuntu-2404)
    - [1.6 LXC device passthrough (done automatically by the hook script)](#16-lxc-device-passthrough-done-automatically-by-the-hook-script)
    - [1.7 QEMU guest agent (required for all VMs)](#17-qemu-guest-agent-required-for-all-vms)
      - [1.7.1 Option A: pre-install in the base template (recommended)](#171-option-a-pre-install-in-the-base-template-recommended)
      - [1.7.2 Option B: auto-install via cloud-init snippet (cicustom)](#172-option-b-auto-install-via-cloud-init-snippet-cicustom)
      - [1.7.3 Option C: install manually on an existing guest](#173-option-c-install-manually-on-an-existing-guest)
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
    - [4.2 DHCP to static IP conversion](#42-dhcp-to-static-ip-conversion)
    - [4.3 LXC container deploy flow](#43-lxc-container-deploy-flow)
  - [Appendix A. Environment variables](#appendix-a-environment-variables)
    - [A.1 Proxmox connection and authentication](#a1-proxmox-connection-and-authentication)
    - [A.2 LXC deployment and storage](#a2-lxc-deployment-and-storage)
    - [A.3 Terminal and runtime](#a3-terminal-and-runtime)
    - [A.4 Diagnostics and benchmarking](#a4-diagnostics-and-benchmarking)
    - [A.5 VM template deploy guard](#a5-vm-template-deploy-guard)
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
   Alternatively, pre-install the agent in the template directly (see [Section 1.7](#17-qemu-guest-agent-required-for-all-vms)).
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
configuration (username/password, network) on first boot. This is required for:
- Automatic credential injection during deploy
- IP address discovery through the guest agent
- DHCP → static IP conversion (Section 4.2)

**Why is this needed?** Cloud images from Proxmox Cookbook (Debian, Ubuntu Server, etc.)
include `cloud-init` by default. Desktop images (Ubuntu Desktop, Windows, custom images)
typically do not. Without cloud-init, the playground cannot inject credentials or network
configuration into cloned VMs.

#### 1.4.1 Why cloud-init is required for the deploy flow

The playground uses Proxmox's cloud-init integration (`cicustom`, `ciuser`, `cipassword`,
`ipconfig0`) to configure new VMs at deploy time. This works as follows:

1. The playground sets `ipconfig0=ip=dhcp` and attaches a cloud-init disk (`ide2`)
2. On first boot, the guest's `cloud-init` service reads the config from the disk
3. Cloud-init can execute commands (e.g., install the guest agent via `cicustom` snippet)
4. Once the guest agent reports an IP, the playground converts DHCP to static

Without cloud-init in the guest OS:
- Credentials cannot be injected
- `cicustom` snippets are ignored
- The guest agent cannot be auto-installed via cloud-init
- IP discovery fails → deploy will fail after the grace period

#### 1.4.2 Installing cloud-init in the template

**For Ubuntu/Debian:** Boot the template VM and SSH in (or use the Proxmox console).

```bash
# Install cloud-init
sudo apt update && sudo apt install -y cloud-init

# Initialize cloud-init
sudo cloud-init init

# Disable cloud-init persistence so it runs fresh on each clone
sudo cloud-init clean
```

**For RHEL/CentOS/Fedora:**
```bash
sudo dnf install -y cloud-init
sudo cloud-init init
sudo cloud-init clean
```

After installing cloud-init, shut down the VM and convert it to a template:
```bash
qm template <vmid>
```

#### 1.4.3 Cloud-init + QEMU guest agent combined (recommended)

The most reliable approach is to install **both** `cloud-init` and `qemu-guest-agent`
in the template. This eliminates the need for the `cicustom` auto-install path:

```bash
# Inside the template VM
sudo apt update
sudo apt install -y cloud-init qemu-guest-agent

# Initialize cloud-init
sudo cloud-init init
sudo cloud-init clean

# Enable guest agent
sudo systemctl enable --now qemu-guest-agent
```

Then in Proxmox GUI:
1. Hardware → Agent → check "Enable"
2. Shut down the VM
3. Convert to template

**Every VM cloned from this template will have both cloud-init and the guest agent
ready to go — no additional configuration needed.**

> **For non-cloud images specifically (Ubuntu Desktop, etc.):** This combined approach
> is the recommended path. The `cicustom` auto-install (Section 1.7.2) only works if
> cloud-init is already present in the guest.

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

### 1.7 QEMU guest agent (required for all VMs)

The QEMU guest agent enables the playground to discover VM IP addresses, collect
guest-side metrics, and perform graceful shutdowns. Without it:

- VM IPs show as `?` in the playground UI
- Automatic DHCP → static IP conversion cannot trigger
- Graceful shutdown from the UI won't work

#### 1.6.1 Option A: pre-install in the base template (recommended)

The most reliable approach is to install `qemu-guest-agent` in the VM template image
before deploying from it:

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

Every VM cloned from this template will have the agent ready to go.

> **Note:** The deploy flow sets `agent=enabled=1` on cloned VMs, which enables the
> virtio serial channel on the Proxmox side. However, this alone does not install the
> agent inside the guest — the binary must be present in the guest OS.

#### 1.6.2 Option B: auto-install via cloud-init snippet (cicustom)

If you can't modify the template image, you can use Proxmox's `cicustom` cloud-init
parameter to install the guest agent on first boot. This requires a one-time host
setup, then works for every cloned VM.

**Step 1: Deploy the cloud-init snippet to the Proxmox host (one-time)**

SSH into the Proxmox host and run:

```bash
sudo bash deploy-cloudinit-snippets.sh
```

This creates `/var/lib/vz/snippets/install-agent.yaml` — a cloud-init user-data file
that installs and enables `qemu-guest-agent` on first boot via `runcmd`.

> **Note:** This installs the `install-agent.yaml` snippet to the `local` storage.
> If your storage with `snippets` support has a different ID (e.g., `fast-ssd`), you'll
> need to update the `PVE_SNIPPET_STORAGE` variable in the script before running it.

**Step 2: Set cicustom during deployment**

When deploying a VM, set the `cicustom` config parameter to point to the snippet:

```bash
# Proxmox CLI
qm set <vmid> --cicustom "user=${PVE_SNIPPET_STORAGE:-local}:snippets/install-agent.yaml"
```

Or in the playground deploy config:

```typescript
configBody.cicustom = `${snippetStorage}:snippets/install-agent.yaml`;
```

On first boot, cloud-init reads the snippet and runs the install command. The playground
will detect the guest agent and display the VM's IP on the next refresh.

#### 1.6.3 Option C: install manually on an existing guest

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
| VM IP shows as `?` in UI | Guest agent not installed or not running — see [Section 1.7](#17-qemu-guest-agent-required-for-all-vms) |

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
- VNC server listening on port 5901 (optional)
- websockify bridge listening on port 8001 (optional)
- Network connectivity (IPv4 address and internet reachability)

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

1. The playground clones the selected VM template on Proxmox.
2. If the clone is missing a network interface, the playground adds `net0` on the
   configured bridge (`PVE_VM_NETWORK_BRIDGE`, default `vmbr0`).
3. If the clone is missing DHCP configuration, the playground sets `ipconfig0 ip=dhcp`.
4. If the clone is missing a cloud-init drive, the playground attaches
   `ide2=<storage>:cloudinit` (`PVE_VM_CLOUDINIT_STORAGE`, default `local-lvm`).
5. The playground starts the cloned VM.
6. On first boot, cloud-init installs the QEMU guest agent (if the template was
   prepared correctly — see [Section 1.3](#13-prepare-a-vm-template-for-cloning)).

### 4.2 DHCP to static IP conversion

Every deployed VM initially receives a DHCP address. Once the guest agent reports the
first IPv4 address, the playground **automatically** converts `ipconfig0` to a static IP
(e.g., `ip=145.24.222.128/24`).

- This happens without user interaction on the next page refresh.
- A green toast notification appears confirming the conversion.
- This only works if the guest agent is running (Section 1.7).

Manual override (if automatic conversion fails):
```bash
qm set <vmid> --ipconfig0 ip=145.24.222.128/24
```

### 4.3 LXC container deploy flow

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

Bridge runtime configuration details are in [Section 3.3](#33-lxc-vnc-bridge-configuration).

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

---

## Appendix B. Troubleshooting index

| Symptom | Likely cause | Section |
|---|---|---|
| Xorg fails with "no screens found" in LXC | Missing device passthrough; hook script not installed | [1.5 LXC device passthrough](#15-lxc-device-passthrough-done-automatically-by-the-hook-script) |
| Container created but no `/dev/dri` | Hook script didn't run | [1.2 Install the LXC post-create hook script](#12-install-the-lxc-post-create-hook-script) |
| VM clone fails with cloud-init LV collision | Stale cloud-init volume for that VMID | Section [1.6 Troubleshooting host-side issues](#16-troubleshooting-host-side-issues) |
| Hook script "file not found" on deploy | `PVE_LXC_HOOKSCRIPT_VOLID` path is wrong | [1.2 Install the LXC post-create hook script](#12-install-the-lxc-post-create-hook-script) |
| Static IP conversion doesn't happen | Guest agent hasn't reported an IP yet, or failed to install | [4.2 DHCP to static IP conversion](#42-dhcp-to-static-ip-conversion) |
| "Submitting credentials..." stuck | See dedicated troubleshooting steps below | [3.4 VNC troubleshooting](#34-troubleshooting-vnc-page-stuck-on-submitting-credentials) |
| GUI action is grayed/disabled | Guest IP not yet discovered | [2.4 Run the verification checklist](#24-run-the-verification-checklist) |
| VNC page shows "Target closed connection" | VNC server auth failing inside guest | [3.4 VNC troubleshooting](#34-troubleshooting-vnc-page-stuck-on-submitting-credentials) |
| Ubuntu 24.04 LXC has no console or network | Missing `nesting=1` feature flag | [1.4 Enable nesting](#14-enable-nesting-at-lxc-container-creation) |

---

Note: this guide is intended for Proxmox administrators only.
