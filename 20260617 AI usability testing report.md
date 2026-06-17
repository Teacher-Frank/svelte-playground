# AI Usability Testing Report — 2026-06-17

## Session Info

- **Tester**: GitHub Copilot (Qwen3.6:27b)
- **Date**: 2026-06-17
- **Target**: `svelte-playground/playground` — Proxmox admin page (`/proxmox`)
- **Proxmox Host**: `145.24.222.41:8006` (node: `compute1-dev`)
- **Dev Server**: `https://localhost:8000` (started via `acctest-env.ps1`)
- **Test Duration**: ~40 minutes

## Scope

Full usability testing of the Proxmox admin page and related sub-pages:

- Main admin page (`/proxmox`) — VMs & LXC tabs
- VM/LXC template lists, deploy dialogs, rename dialogs
- Workload list, selection, action buttons
- Configure dialog (CPU/memory/storage)
- Terminal sub-page (`/proxmox/terminal`)
- VNC sub-page (`/proxmox/vnc`)
- Task log (Last 10 Actions)
- Refresh controls (interval, toggle)

---

## Bugs Found & Fixed During Testing

### 1. QEMU resize `disk: 'rootfs'` — HTTP 400 on every storage resize _(FIXED)_

- **Severity**: High
- **File**: `playground/src/routes/proxmox/action-executors.ts`
- **Root cause**: The code correctly discovers the QEMU disk key (`vmDiskKey`) but then passes `disk: 'rootfs'` to the resize endpoint. `rootfs` is only valid for LXC. QEMU expects `scsi0`, `virtio0`, etc.
- **Fix**: Changed `disk: 'rootfs'` → `disk: vmDiskKey`
- **Verification**: Confirmed — resize task appeared in task log with status "OK"

### 2. Raw JSON API errors dumped into UI _(FIXED)_

- **Severity**: High
- **File**: `playground/src/routes/proxmox/proxmox-actions.ts`
- **Root cause**: Proxmox API errors (including full JSON response bodies) were passed directly to the UI. A `formatApiError` helper was partially implemented but applied to only 1 of 9 catch blocks.
- **Fix**: Applied `formatApiError` to **all** catch blocks across the file
- **Verification**: Error messages now show readable text rather than raw JSON blobs

### 3. Duplicate error display — inline row + dismissible toast _(REVIEWED)_

- **Severity**: Low-Medium
- Both `PxMxWorkloadList.svelte` (inline section message) and `PxMxWorkloadControls.svelte` (config toast) rendered the same error. This is a by-design separation (section-level vs dialog-level feedback). Left as-is.

---

## Usability Findings (Remaining)

| # | Severity | Area | Finding |
|---|----------|------|---------|
| 1 | Low | Refresh interval | `acctest-env.ps1` sets `PLAYGROUND_REFRESH_INTERVAL_SECONDS=1` — aggressive for production; 5-10s recommended |
| 2 | Low | Terminal page | Terminal input textbox captures keyboard focus but leaves no visual feedback for first-time users |
| 3 | Low | VNC page | No offline/error state when container IP isn't available — currently shows blank |
| 4 | Low | Task log | `vncproxy` tasks clutter the log; could filter or collapse identical consecutive entries |
| 5 | Low | VM IP display | Running VMs show `?` for IP when guest agent unavailable — no tooltip explains this to users |

---

## Test Coverage Matrix

| Feature | Tested | Result |
|---------|--------|--------|
| Page initial load & data population | ✅ | All templates, VMs, containers, tasks load correctly |
| Server status bar | ✅ | Shows online/node/API host |
| Tab switch (VMs ↔ LXC) | ✅ | Persistent via cookie, survives navigation |
| Refresh interval control | ✅ | Number input + toggle checkbox work |
| Workload row selection | ✅ | Click selects, action bar updates |
| Configure dialog (CPU/memory/storage) | ✅ | Dialog opens, form validates, API call succeeds after fix |
| Deploy VM from template dialog | ✅ | Dialog opens, fields present |
| Start / Stop / Restart actions | ❌ | Not triggered during session (no destructive changes) |
| Terminal sub-page (VM) | ✅ | Serial terminal connects and displays boot output |
| VNC sub-page (container) | ✅ | Page navigable, VNC viewer present |
| Task log collapse/expand | ✅ | Toggle button works |
| Error message formatting | ✅ | Formatted through `formatApiError` after fix |

---

## Files Changed

| File | Change |
|------|--------|
| `playground/src/routes/proxmox/action-executors.ts` | QEMU resize: `disk: 'rootfs'` → `disk: vmDiskKey` |
| `playground/src/routes/proxmox/proxmox-actions.ts` | Applied `formatApiError` to all 9 catch blocks |

---

## Next Steps

1. Filter `vncproxy` tasks from public task log or group consecutive entries
2. Add tooltip to VM IP column explaining `?` = guest agent unavailable
3. Add idle state to VNC page when no IP is available (rather than blank screen)
4. Review refresh interval default (`1s` → `5s` recommended)
5. Add keyboard navigation for workload selection (arrow keys)
6. Add Escape key to close dialogs
