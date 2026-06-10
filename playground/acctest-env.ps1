# Fail fast on setup or command errors.
$ErrorActionPreference = "Stop"

Clear-Host

# Set environment variables for Proxmox authentication
# Required
$env:PVE_BASE_URL = "https://145.24.222.41:8006"
$env:PVE_NODE = "pve"


# Option B: Username/password authentication
$env:PVE_USERNAME = "root"
$env:PVE_PASSWORD = "dSaiJYTpy4eX0Y177"
$env:PVE_REALM = "pam"

#debugging
$env:PVE_TERMINAL_TRACE = "true"

# Optional: allow self-signed TLS certs
$env:PVE_INSECURE_TLS = "true"
# Optional: admin contact used when VM template cloud-init prerequisites are missing
$env:PVE_ADMIN_CONTACT_EMAIL = "thifm@hr.nl"
# Optional: preferred storage for VM cloud-init disks in automation workflows
$env:PVE_VM_CLOUDINIT_STORAGE = "local-lvm"
# Optional: default admin-page auto refresh interval (seconds)
$env:PLAYGROUND_REFRESH_INTERVAL_SECONDS = "1"
# Optional: Proxmox hookscript volume ID (<storage>:snippets/<file>)
$env:PVE_LXC_HOOKSCRIPT_VOLID = "local:snippets/lxc-post-create-hook.sh"
# Optional: target storage for LXC root filesystem (must support rootdir/container directories)
$env:PVE_LXC_ROOTFS_STORAGE = "local-lvm"

# Optional: LXC VNC web bridge (derived mode)
# The app derives ws://<container-ip>:<port> from each container IPv4 address.
# Keep websockify listening on the same port on each reachable container/host target.
$env:LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 = "true"
$env:LXC_VNC_BRIDGE_WS_SCHEME = "ws"
$env:LXC_VNC_BRIDGE_WS_PORT = "8001"
$env:LXC_VNC_BRIDGE_WS_PATH = ""

# Leave explicit URL/allowlist empty in derived mode.
$env:LXC_VNC_BRIDGE_WS_URL = ""
$env:LXC_VNC_BRIDGE_ALLOWED_HOSTS = ""

# Optional: Set Node.js environment
$env:NODE_ENV = "development"

# Show effective Proxmox target values before startup
Write-Host "PVE_BASE_URL=$($env:PVE_BASE_URL)"
Write-Host "PVE_NODE=$($env:PVE_NODE)"
Write-Host "PVE_ADMIN_CONTACT_EMAIL=$($env:PVE_ADMIN_CONTACT_EMAIL)"
Write-Host "PVE_VM_CLOUDINIT_STORAGE=$($env:PVE_VM_CLOUDINIT_STORAGE)"
Write-Host "PLAYGROUND_REFRESH_INTERVAL_SECONDS=$($env:PLAYGROUND_REFRESH_INTERVAL_SECONDS)"
Write-Host "PVE_LXC_HOOKSCRIPT_VOLID=$($env:PVE_LXC_HOOKSCRIPT_VOLID)"
Write-Host "PVE_LXC_ROOTFS_STORAGE=$($env:PVE_LXC_ROOTFS_STORAGE)"
Write-Host "LXC_VNC_BRIDGE_WS_URL=$($env:LXC_VNC_BRIDGE_WS_URL)"
Write-Host "LXC_VNC_BRIDGE_ALLOWED_HOSTS=$($env:LXC_VNC_BRIDGE_ALLOWED_HOSTS)"

# Resolve repo paths from this script location.
$playgroundRoot = Split-Path -Parent $PSCommandPath
$pveClientRoot = Resolve-Path (Join-Path $playgroundRoot "..\..\pve-client")

Write-Host "Building pve-client from $pveClientRoot ..."
npm --prefix $pveClientRoot run build
if ($LASTEXITCODE -ne 0) {
	throw "pve-client build failed with exit code $LASTEXITCODE"
}

# Start the playground dev server.
Push-Location $playgroundRoot
try {
	npm run dev
	if ($LASTEXITCODE -ne 0) {
		throw "playground dev server failed with exit code $LASTEXITCODE"
	}
}
finally {
	Pop-Location
}