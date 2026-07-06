# Self-healing dev server startup script for VS Code task
# - Kills stale processes on port 8000
# - Ensures pve-client dist exists (builds if needed)
# - Runs `npm run dev` in foreground; restarts on crash (up to 5 times)
#
# Output sentinels for problemMatcher:
#     "starting dev server"  → background beginsPattern
#     "VITE v... ready in"   → background endsPattern (Vite's natural output)

# ── Environment ─────────────────────────────────────────────────
$env:PVE_BASE_URL = "https://145.24.222.41:8006"
$env:PVE_NODE = "pve"
$env:PVE_USERNAME = "root"
$env:PVE_PASSWORD = "dSaiJYTpy4eX0Y177"
$env:PVE_REALM = "pam"
$env:PVE_TERMINAL_TRACE = "true"
$env:PVE_INSECURE_TLS = "true"
$env:PVE_ADMIN_CONTACT_EMAIL = "thifm@hr.nl"
$env:PVE_VM_CLOUDINIT_STORAGE = "local-lvm"
$env:PLAYGROUND_REFRESH_INTERVAL_SECONDS = "1"
$env:PVE_LXC_HOOKSCRIPT_VOLID = "local:snippets/lxc-post-create-hook.sh"
$env:PVE_LXC_ROOTFS_STORAGE = "local-lvm"
$env:LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 = "true"
$env:LXC_VNC_BRIDGE_WS_SCHEME = "ws"
$env:LXC_VNC_BRIDGE_WS_PORT = "8001"
$env:LXC_VNC_BRIDGE_WS_PATH = ""
$env:LXC_VNC_BRIDGE_WS_URL = ""
$env:LXC_VNC_BRIDGE_ALLOWED_HOSTS = ""
$env:NODE_ENV = "development"

$playgroundRoot = Split-Path -Parent $PSCommandPath
$pveClientRoot  = Resolve-Path (Join-Path $playgroundRoot "..\..\pve-client")


# ── Helpers ─────────────────────────────────────────────────────

function Kill-Port8000 {
	$lines = netstat -ano 2>$null | Select-String ":8000\s"
	if (-not $lines) { return }
	$pids = $lines | ForEach-Object { ($_ -split '\s+')[-1] } |
		Where-Object { $_ -and $_ -match '^\d+$' -and $_ -ne '0' } |
		Select-Object -Unique
	foreach ($p in $pids) {
		Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
	}
	Start-Sleep -Seconds 1
}

function Ensure-PveClientBuilt {
	Write-Host ">>> Building pve-client..." -ForegroundColor Cyan
	npm --prefix $pveClientRoot run build
	if ($LASTEXITCODE -ne 0) {
		Write-Host ">>> pve-client build failed!" -ForegroundColor Red
		exit 1
	}
}

# ── Main: crash-restart loop ────────────────────────────────────

Ensure-PveClientBuilt

$maxRestarts = 5
$restarts    = 0

while ($restarts -lt $maxRestarts) {
	Kill-Port8000

	# Sentinel — VS Code problemMatcher beginsPattern
	Write-Host "starting dev server"

	# Run npm run dev in foreground; output flows through naturally
	# Vite will output "VITE v7.x.x  ready in ...ms" — matches endsPattern
	Push-Location $playgroundRoot
	npm run dev
	$exitCode = $LASTEXITCODE
	Pop-Location

	# If we reach here, `npm run dev` exited (crash, EADDRINUSE, Ctrl+C, etc.)
	$restarts++

	if ($restarts -lt $maxRestarts) {
		Write-Host ">>> Dev server exited (code $exitCode). Restarting..." -ForegroundColor Yellow
		Kill-Port8000
		Start-Sleep -Milliseconds 1500
	}
}

Write-Host ">>> Dev server crashed $maxRestarts times. Giving up." -ForegroundColor Red
exit 1