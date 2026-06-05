# Fail fast on setup or command errors.
$ErrorActionPreference = "Stop"

# Set environment variables for Proxmox authentication
# Required
$env:PVE_BASE_URL = "https://localhost:8006"
$env:PVE_NODE = "pve"

# Option A: API token authentication
# $env:PVE_API_TOKEN = "PVEAPIToken=root@pam!mytoken=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# Option B: Username/password authentication
$env:PVE_USERNAME = "root"
$env:PVE_PASSWORD = "Defcon54!"
$env:PVE_REALM = "pam"

# Optional: allow self-signed TLS certs
$env:PVE_INSECURE_TLS = "true"

# Optional: admin contact used when VM template cloud-init prerequisites are missing
$env:PVE_ADMIN_CONTACT_EMAIL = "thifm@hr.nl"

# Optional: preferred storage for VM cloud-init disks in automation workflows
$env:PVE_VM_CLOUDINIT_STORAGE = "local-lvm"

# Optional: default admin-page auto refresh interval (seconds)
$env:PLAYGROUND_REFRESH_INTERVAL_SECONDS = "5"

# Optional: Set Node.js environment
$env:NODE_ENV = "development"

# Show effective Proxmox target values before startup
Write-Host "PVE_BASE_URL=$($env:PVE_BASE_URL)"
Write-Host "PVE_NODE=$($env:PVE_NODE)"
Write-Host "PVE_ADMIN_CONTACT_EMAIL=$($env:PVE_ADMIN_CONTACT_EMAIL)"
Write-Host "PVE_VM_CLOUDINIT_STORAGE=$($env:PVE_VM_CLOUDINIT_STORAGE)"
Write-Host "PLAYGROUND_REFRESH_INTERVAL_SECONDS=$($env:PLAYGROUND_REFRESH_INTERVAL_SECONDS)"

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