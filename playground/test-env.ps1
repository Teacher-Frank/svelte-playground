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

# Optional: allow self-signed TLS certs
$env:PVE_INSECURE_TLS = "true"

# Optional: Set Node.js environment
$env:NODE_ENV = "development"

# Show effective Proxmox target values before startup
Write-Host "PVE_BASE_URL=$($env:PVE_BASE_URL)"
Write-Host "PVE_NODE=$($env:PVE_NODE)"

# Start the server
npm run dev