# Fail fast on setup or command errors.
$ErrorActionPreference = "Stop"

Clear-Host

# Set environment variables for Proxmox authentication
# Required
$env:PVE_BASE_URL = "https://testpxmx.dev.datalabrotterdam.nl:8006"
$env:PVE_NODE = "pve"

# Option A: API token authentication
# $env:PVE_API_TOKEN = "PVEAPIToken=root@pam!mytoken=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# Option B: Username/password authentication
$env:PVE_USERNAME = "root"
$env:PVE_PASSWORD = "Defcon54!"
$env:PVE_REALM = "pam"

#debugging
$env:PVE_TERMINAL_TRACE = "true"

# Optional: allow self-signed TLS certs
$env:PVE_INSECURE_TLS = "true"

# Optional: admin contact used when VM template cloud-init prerequisites are missing
$env:PVE_ADMIN_CONTACT_EMAIL = "thifm@hr.nl"

# Optional: preferred storage for VM cloud-init disks in automation workflows
$env:PVE_VM_CLOUDINIT_STORAGE = "local-lvm"

#optional: VNC configuration
# $env:LXC_VNC_BRIDGE_WS_URL=ws://<your-host>:8001
# $env:LXC_VNC_BRIDGE_ALLOWED_HOSTS=<your-host>:8001,<other-host>:9001
# Optional placeholder variant: ws://{ip}:8001 (or use {ipv4})
# Optional derived mode (when no explicit URL template is provided):
#   LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true
#   LXC_VNC_BRIDGE_WS_SCHEME=ws
#   LXC_VNC_BRIDGE_WS_PORT=8001
#   LXC_VNC_BRIDGE_WS_PATH=
$env:LXC_VNC_BRIDGE_DERIVE_FROM_IPV4='true'
$env:LXC_VNC_BRIDGE_WS_SCHEME='ws'
$env:LXC_VNC_BRIDGE_WS_PORT='8001'
$env:LXC_VNC_BRIDGE_WS_PATH=''
# Keep this empty to let derived mode build ws://<container-ip>:<port>.
$env:LXC_VNC_BRIDGE_WS_URL=''
# Allowlist is not needed in derived mode; proxy validates IPv4 + configured port.
$env:LXC_VNC_BRIDGE_ALLOWED_HOSTS=''

# Optional: Set Node.js environment
$env:NODE_ENV = "development"

# Show effective Proxmox target values before startup
Write-Host "PVE_BASE_URL=$($env:PVE_BASE_URL)"
Write-Host "PVE_NODE=$($env:PVE_NODE)"
Write-Host "PVE_ADMIN_CONTACT_EMAIL=$($env:PVE_ADMIN_CONTACT_EMAIL)"
Write-Host "PVE_VM_CLOUDINIT_STORAGE=$($env:PVE_VM_CLOUDINIT_STORAGE)"

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