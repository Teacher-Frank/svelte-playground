# Deploy Progress — Investigation Notes

**Date:** 2026-06-18 → Updated 2026-06-19
**Issue:** Ubuntu Desktop VM deployment stays stuck in "Deploying..." mode until the 10-minute hard cap expires.

## Root Cause: Guest Agent Not Installed

The deployment flow needs `qemu-guest-agent` running inside the guest OS to discover IP addresses. The current code does:

1. Clone VM template
2. Attach cloud-init disk (`ide2`) if missing
3. Set `ipconfig0=ip=dhcp` if missing
4. Set `agent=enabled=1` if not already set — **this only enables the virtio serial channel on the Proxmox side, does NOT install the agent inside the guest**
5. Set cloud-init username/password
6. Start the VM

Without the agent binary installed in the guest, `agent=enabled=1` does nothing — there's no process on the other end of the serial channel to respond to queries.

## ❌ Fabricated Fix Discovered — `cicommand` Does Not Exist

**Update 2026-06-19:** A previous fix attempted to set `cicommand` on the VM config body, intending to have cloud-init install the guest agent on first boot. **This parameter does not exist in the Proxmox API and is silently ignored.**

### Verification

1. **Official Proxmox API docs** — No `cicommand` parameter in `/nodes/{node}/qemu/{vmid}/config` (verified via [pve-docs](https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/config))
2. **pve-client type definitions** (`types.ts`) — No `cicommand` type exists
3. **Existing test** (`proxmox-actions.spec.ts` line 285) — Already documented: *"no cicommand - not a supported Proxmox API parameter"*

### Canary Test Created

Added `c:\hrgit\pve-client\tests\unit\qemuConfigCloudInit.test.ts`:
- Compile-time assertion that `cicommand` is NOT in the type definitions (will break if someone adds it)
- Confirms all valid cloud-init params (`cicustom`, `cipassword`, `citype`, `ciupgrade`, `ciuser`, `ipconfig[n]`, `nameserver`, `searchdomain`, `sshkeys`) DO exist
- All 11 tests pass ✓

### Valid Cloud-Init Parameters

| Parameter | Purpose |
|-----------|---------|
| `cicustom` | Path to custom cloud-init ISO that replaces auto-generated files |
| `cipassword` | Password for ciuser |
| `citype` | Format: configdrive2 / nocloud / opennebula |
| `ciupgrade` | Boolean — run apt upgrade on first boot (Linux only) |
| `ciuser` | Username for cloud-init |
| `ipconfig[n]` | IP address/gateway configuration |
| `nameserver` | DNS server IP |
| `searchdomain` | DNS search domains |
| `sshkeys` | Public SSH keys |

### Resolution

**Completed 2026-06-19:** Removed the `cicommand` line from `action-template-deployers.ts`. Replaced with a comment documenting that `agent=enabled=1` only opens the virtio serial channel and linking to this file for full context.

**Completed 2026-06-19:** Consolidated duplicate `expect(mocks.request)` assertions in `proxmox-actions.spec.ts` into a single assertion with commentary confirming `cicommand` is intentionally absent.

## ✅ Working Solution: `cicustom` with cloud-init `runcmd`

**Discovered 2026-06-19** via Proxmox documentation:
- [Proxmox cloud-init docs](https://pve.proxmox.com/pve-docs/pve-admin-guide.html#qm_cloud_init)
- [Proxmox QEMU Guest Agent wiki](https://pve.proxmox.com/wiki/Qemu-guest-agent)

### Why the original approach was wrong

The fabricated `cicommand` parameter was a confusion with cloud-init's `runcmd` directive. Proxmox doesn't expose `runcmd` directly as a VM config parameter — instead, you use `cicustom` to point to a custom cloud-init user-data file.

### How `cicustom` works

1. Create a YAML file (cloud-init user-data) on a Proxmox storage that supports `snippets` content type
2. The YAML includes an `runcmd` section with shell commands to run on first boot
3. Set `cicustom` on the VM config to point to the snippet

Example user-data YAML (`install-agent.yaml`):

```yaml
#cloud-config
runcmd:
  - >-
    test -f /usr/sbin/qemu-ga ||
    (apt-get update -qq && apt-get install -y qemu-guest-agent) &&
    systemctl enable --now qemu-guest-agent
```

Then in the Proxmox config:
```
qm set <vmid> --cicustom "user=local:snippets/install-agent.yaml"
```

Or via API, in the config body:
```typescript
configBody.cicustom = 'user=local:snippets/install-agent.yaml';
```

### Steps to implement in deployment flow

1. **Create the snippet file** — Deploy `install-agent.yaml` to the Proxmox `local:snippets` storage (one-time setup, could be baked into the Proxmox host provisioning)
2. **Set `cicustom`** in `configBody` during deployment alongside existing cloud-init params
3. **Cloud-init runs `runcmd`** on first boot, installing and enabling the guest agent

### ⚠️ Prerequisite: cloud-init must be present in the VM

`cicustom` only works if the guest OS has `cloud-init` installed and running. Cloud images (Debian, Ubuntu Server, etc.) include it by default. **Desktop images (Ubuntu Desktop, Windows, etc.) typically do not.**

When deploying from a non-cloud image:
1. The `cicustom` cloud-init disk is attached, but no process reads it
2. Neither `qemu-guest-agent` nor `cloud-init` runs in the guest
3. The IP address is never discovered
4. The deploy will fail after the grace period with a "deploy-failed" status

**Fix:** Install `cloud-init` in the template before cloning:
```bash
# Inside the Ubuntu Desktop VM (before making it a template)
sudo apt update && sudo apt install -y cloud-init
cloud-init clean  # reset state so it runs on next boot
```

Or use the pre-bake approach below to install both `cloud-init` and `qemu-guest-agent` in the template image.

### Alternative approaches (ranked)

| Approach | Effort | Reliability | Notes |
|----------|--------|-------------|-------|
| **Pre-bake agent in template** | Medium | ★★★★★ | Install `qemu-guest-agent` in the gold image before making it a template. Still the gold standard. |
| **`cicustom` + `runcmd`** | Medium | ★★★★ | Point to a custom cloud-init YAML snippet with install commands. Works without modifying the template. |
| **Post-start via SSH** | High | ★★★ | After first boot, SSH in and install. Requires password auth + timing. |
| **Hookscript** | High | ★★★ | Proxmox-side hook script runs after VM start. Still needs the agent. |
| ~~Post-start agent exec~~ | — | ✗ | `/nodes/{node}/qemu/{vmid}/agent/exec` requires agent already running (chicken/egg) |
| ~~`ciupgrade`~~ | — | ✗ | `ciupgrade=true` upgrades packages but won't *install* new ones |

**Recommended for immediate fix:** `cicustom` with `runcmd` — works with existing templates.
**Recommended long-term:** Pre-bake the agent in the Ubuntu template image.

## Deploying State Machine — Still to Investigate

The "deploying stuck" issue persists regardless. The deployment state machine in `PxMxAdmin.svelte` resolves when:
- Tasks complete (clone + start)
- Workload appears in server VM list
- Minimum 30 seconds elapsed (hard cap: 10 minutes)

The user reported it stays deployed until the 10-minute cap. Two likely causes remain:

1. **Workload not appearing in VM list**: The `isDeployResolved` check looks for the workload name in `vmWorkloadsFromServer`. If the VM name doesn't match or the VM fails to start, the workload won't appear and the deploying state persists until the 10-minute cap.

2. **Task stuck or failing silently**: `isTaskActive` returns `true` if a task has no `endtime` and status isn't `ok`/`stopped`/`error`/`warnings`. If task data is stale or missing from `recentTasks`, `isTaskActive` returns `undefined` which is neither `true` nor `false` — the code treats `undefined` as "not active" so `states.some(state => state === true)` is false.

3. **Name mismatch**: The workload name comparison is case-insensitive lowercase trimming. If the deployed name differs from the reported name, `workloadExists` will be false.

## Next Steps

- [x] Confirm `cicommand` is not a valid Proxmox API parameter
- [x] Create canary test in pve-client to prevent recurrence
- [x] Remove dead `cicommand` code from `action-template-deployers.ts`
- [x] Create `scripts/host/deploy-cloudinit-snippets.sh` host setup script
- [x] Add `configBody.cicustom` to deploy flow with `PVE_SNIPPET_STORAGE` env var
- [x] Update `PxMx-Admin-For-Datalab-Guide.md` §2.3 with correct guest agent instructions
- [x] **Fix stuck delete modal** — added `try/finally` + 30s hard timeout to `enhanceDestroySubmit`
- [x] **Fix stuck deploy dialog (empty backdrop)** — added `$effect` auto-close in `PxMxTemplateDialog`
- [x] **Fix YAML fragment syntax** — changed `->` to `|` + shell `&&` command in `install-agent.yaml`
- [x] **Fix notification gap** — added `pending` notification kind that stays until outcome arrives
- [x] **Consolidate notification paths** — removed duplicate `onDeployStarted` + `$effect(form)`, single `onSubmitEnd` path
- [x] **Fix configure modal no `try/finally`** — wrapped `enhanceConfigureSubmit` in `try/finally` with timeout
- [x] **Make server deploy non-blocking** — return clone UPID immediately; config+start in `setTimeout` background task
- [x] **Add orphan VM cleanup** — if config/start background task fails after clone completes, destroy orphan VM (stop-if-running + delete with purge)
- [x] Test full deploy flow end-to-end (snippet install → cicustom → agent detected → IP shown) — confirmed 2026-06-24, IP visible on deployed VM
- [x] **Fix stuck deploy on background failure** — add deploy failure detection with 60s grace period, show "deploy-failed" status + notification, auto-remove after 10s
- [x] **Check Proxmox task logs** — added `[taskTransition]` console.info on task state change (started → completed/error) + `window.pveDebug.allTasks()` for manual inspection
- [x] **Install `cloud-init` in template** — admin guide §1.4 updated to document correct architecture: template needs `cloud-init` + `/etc/cloud/cloud.cfg` only; `qemu-guest-agent` is installed by deploy flow via `cicustom`. §1.7 rewritten, section numbering fixed, appendix updated.
- [x] Add debug logging to `isDeployResolved` to trace why the 10-minute cap is hit

- [x] **Add serial0=socket during deployment** — `runPostCloneSteps` now checks for a usable serial port and adds `serial0=socket` if missing (same pattern as net0/ipconfig0/agent). This ensures terminal access works on every deployed VM without manual Proxmox UI intervention.

## Policy Added

**P2c: Unknown API Surface Validation** — Added to `POLICIES.md`. Before using an external API parameter/endpoint that hasn't been verified, write a test that proves it exists.

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/proxmox/action-template-deployers.ts` | VM deployment logic (cicustom wired in, PVE_SNIPPET_STORAGE env var) |
| `scripts/host/deploy-cloudinit-snippets.sh` | Host setup script — deploys install-agent.yaml to /var/lib/vz/snippets (new) |
| `src/PxMxAdmin.svelte` | Deploying state machine and resolution logic |
| `src/routes/proxmox/helpers.ts` | Guest agent error detection, client creation |
| `src/routes/proxmox/loadData.ts` | Data loading and guest agent handling |
| `pve-client/tests/unit/qemuConfigCloudInit.test.ts` | Canary test for cloud-init API surface (new) |
| `tests/lib/server/proxmox-actions.spec.ts` | Playground test (consolidated assertions, updated comment) |
| `POLICIES.md` | P2c: Unknown API Surface Validation (new) |
| `PxMx-Admin-For-Datalab-Guide.md` | Admin guide §2.3 updated with cicustom option |
| `scripts/guest/install-guest-agent.sh` | Manual guest agent install script (fallback) |

## Implementation Details

### Deploy flow (action-template-deployers.ts)

```typescript
const snippetStorage = process.env.PVE_SNIPPET_STORAGE?.trim() || 'local';
// ...
configBody.cicustom = `user=${snippetStorage}:snippets/install-agent.yaml`;
```

### Host setup (scripts/host/deploy-cloudinit-snippets.sh)

```bash
# Default storage: local
sudo bash scripts/host/deploy-cloudinit-snippets.sh

# Custom storage
PVE_SNIPPET_STORAGE=fast-ssd sudo bash scripts/host/deploy-cloudinit-snippets.sh
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PVE_SNIPPET_STORAGE` | `local` | Proxmox storage ID for cloud-init snippets |
| `PVE_VM_CLOUDINIT_STORAGE` | `local-lvm` | Proxmox storage ID for cloud-init disks (existing) |

---

## Deploy Flow Refactor — 2026-06-23 Session Notes

### Audit: 6 Issues Found

| # | Issue | Severity | Status |
|---|-------|----------|--------|
| 1 | YAML syntax error (`->` rejected by Proxmox) | 🔴 Runtime failure | ✅ Fixed |
| 2 | Server blocks HTTP for 10-30s on `task.wait()` | 🔴 User waits with no feedback | ✅ Fixed |
| 3 | Orphan VM if clone succeeds but config/start fails | 🔴 Resource leak | ✅ Fixed |
| 4 | Notification gap (toast at 3s, bar at 30s+) | 🟡 User sees nothing for ~25s | ✅ Fixed |
| 5 | Duplicate notification paths (3 channels firing) | 🟡 Messy UI, potential double-notifications | ✅ Fixed |
| 6 | Delete/config modal hangs on server timeout | 🟡 Requires hard refresh | ✅ Fixed |

### Changes Made (In Working Tree — Not Yet Committed)

**1. YAML syntax fix** (`scripts/host/deploy-cloudinit-snippets.sh`)
- Changed folded scalar (`->`) to literal block scalar (`|`) with shell `&&` continuation
- **Must be re-run on server** to update `/var/lib/vz/snippets/install-agent.yaml`

**4. Notification gap** (`notification-store.svelte.ts`, `ToastNotification.svelte`, `PxMxStyle.css`)
- Added `pending` notification kind — no auto-dismiss, stays until replaced by success/error
- Blue inline bar styling. Applied to both VM and LXC template deploys

**5. Duplicate notification consolidation** (`PxMxVMTemplateList.svelte`, `PxMxLxcTemplateList.svelte`)
- Removed redundant first `onDeployStarted(payload)` from `onSubmitStart` (fired with stale data)
- Removed `$effect(form)` handler (duplicated server message display)
- All success/error now flow through single `onSubmitEnd` path

**6. Modal timeout** (`PxMxWorkloadControls.svelte`)
- 30s `Promise.race` timeout on destroy & configure enhance handlers
- `try/finally` ensures state cleanup even on hung server

**Bonus: Dialog sticky backdrop** (`PxMxTemplateDialog.svelte`)
- `$effect` auto-closes `<dialog>` when `active` prop goes false

### Remaining: Issues #2 and #3

**#2 — Non-blocking server action:** ✅ Completed. `deployVmFromTemplate` now returns clone UPID immediately; config+start runs in `setTimeout` background task. Verified 2026-06-24.

**#3 — Orphan VM cleanup:** ✅ Completed. `destroyOrphanVm()` is called in `runPostCloneSteps` catch block when `cloneCompleted` is true. Stop-if-running + delete with purge. Verified 2026-06-24.

### E2E Test — 2026-06-24

Deployed `usability-test-vm` (VM 104) from `debian-12-cloud-template`.
- Credentials used: username `root`, password `TestP@ssw0rd123!`
- Clone task: OK (~1m 8s), Start task: OK
- Guest agent detected, IP address shown in workload list
- Deploy dialog opened → filled → closed on submit → notification shown → task completed
- No stuck states, no orphan VMs observed

---

## Deploy Failure Detection — 2026-06-24 Session Notes

### Problem
When deploying from template 103 (`ubuntudesktop`), the background `runPostCloneSteps` task failed (non-cloud Ubuntu Desktop image + `cicustom` cloud-init snippet). The orphan VM was destroyed, but **the UI never knew** — it only tracked the `cloneUpid` (which succeeded). The deploying row stayed visible indefinitely until the 10-minute hard cap expired.

### Root Cause
- Server returns only `[cloneUpid]` to the UI immediately
- `runPostCloneSteps` (wait for clone + apply config + start) runs in `setTimeout` background task
- If it fails, `destroyOrphanVm` cleans up, but error is only `console.error` — never surfaced to UI
- `isDeployResolved` checks: clone task done (true) → workload exists? (false) → stuck forever until hard cap

### Fix Applied
1. **Added `tasksSettledAt` timestamp** to `DeployingWorkload` — tracks when all tracked tasks first settled as completed
2. **Added `$effect` in `PxMxAdmin.svelte`** — on each refresh cycle, detects when tasks have completed but workload doesn't exist, sets `tasksSettledAt`
3. **Added 60-second grace period** (`DEPLOY_FAILURE_GRACE_MS`) — after tasks settle, if workload still doesn't exist after 60s, mark as failed
4. **Show `deploy-failed` status** — red badge in workload list, 10-second visibility window (`DEPLOY_FAILED_VISIBLE_MS`) before auto-removal
5. **Fire error notification** — `PxMxWorkloadList.svelte` detects `deploy-failed` workloads and fires inline error toast with context
6. **Fixed pre-existing syntax error** — corrupted template literal in `proxmox-actions.ts` line 586

### Files Changed
| File | Change |
|------|--------|
| `src/PxMxAdmin.svelte` | Added `tasksSettledAt` to `DeployingWorkload`, updated `isDeployResolved`/`isDeployFailed`, added `$effect` to track when tasks settle |
| `src/PxMxWorkloadList.svelte` | Added `deploy-failed` status class + tooltip, error notification on failure detection, red badge CSS |
| `src/routes/proxmox/proxmox-actions.ts` | Fixed syntax error (corrupted template literal, duplicate string, stray template literal syntax) |

### Timing Constants
| Constant | Value | Purpose |
|----------|-------|---------|
| `DEPLOY_FAILURE_GRACE_MS` | 60s | Wait after tasks settle before declaring failure (covers orphan cleanup time, backend task completion) |
| `DEPLOY_FAILED_VISIBLE_MS` | 10s | Show "deploy-failed" status briefly before auto-removal |
| `DEPLOY_MIN_VISIBLE_MS` | 30s | Existing: minimum time to show "deploying" status |
| Hard cap | 10min | Maximum time before forced cleanup (unchanged) |

### Before vs After
**Before:** Deploy fails silently → stuck "deploying" for 10 minutes → entry disappears with no feedback
**After:** Deploy fails → 60s grace → "deploy-failed" red badge + error notification → 10s → entry auto-removed

### Tests
- 18 of 22 proxmox-actions tests pass (4 pre-existing LXC destroy test failures)
- No errors introduced by deploy failure detection changes

---

## Serial Port Configuration via Proxmox API — 2026-06-25 Notes

### Background

The terminal feature (`svelte-playground/playground/server/proxmoxTerminalWs.ts`) connects to VMs via the Proxmox `termproxy` endpoint, which requires a serial console to be configured on the VM. When no serial port exists, the terminal shows a "serial not configured" error (close code 4001).

**Serial ports can be added via the Proxmox API** — no manual Proxmox web UI intervention required.

### API Reference (pve-client)

| Operation | Method | Endpoint | Serial Param |
|---|---|---|---|
| **Read current serial config** | `config.get()` | `GET /nodes/{node}/qemu/{vmid}/config` | Response: `"serial[n]"?: string` |
| **Update serial config (sync)** | `config.put()` | `PUT /nodes/{node}/qemu/{vmid}/config` | Body: `"serial[n]"?: string` |
| **Update serial config (async)** | `config.post()` | `POST /nodes/{node}/qemu/{vmid}/config` | Body: `"serial[n]"?: string` |
| **List VMs (serial flag)** | `list()` | `GET /nodes/{node}/qemu` | Response per VM: `"serial"?: boolean` |
| **Connect to serial console** | `termproxy()` | `POST /nodes/{node}/qemu/{vmid}/termproxy` | Body: `"serial"?: "serial0" \| "serial1" \| "serial2" \| "serial3"` |

### TypeScript Types (pve-client `src/api/nodes/types.ts`)

```typescript
// Config GET return, PUT body, POST body all include:
"serial[n]"?: string;

// termproxy POST body:
$body: { "serial"?: "serial0" | "serial1" | "serial2" | "serial3" };

// termproxy POST return:
return: { "port": number; "ticket": string; "upid": string; "user": string };
```

### Serial Port Values

| Value | Meaning |
|---|---|
| `"socket"` | Socket-based serial (what `termproxy` needs for terminal access) |
| `"none"` | Disabled (default on many templates) |
| `"socket,rfc2217"` | Socket with RFC 2217 telnet escaping |
| `"file:/path"` | Logs to file (not useful for terminals) |
| `"null"` | Null device (discards output) |

### Usage Example

```typescript
// Check current serial config
const config = await client.api.nodes.get(node).qemu.vmid(vmid).config.get();
const serial0 = config["serial0"];  // e.g., "none" or undefined

// Add serial0=socket (sync — blocks until done)
await client.api.nodes.get(node).qemu.vmid(vmid).config.put({
  "serial0": "socket",
});

// Add serial0=socket (async — returns task UPID)
const upid = await client.api.nodes.get(node).qemu.vmid(vmid).config.post({
  "serial0": "socket",
});
```

### Notes

- **VM restart required:** Changes to `serial[n]` take effect only after a VM reboot (hot-plug not supported for serial ports).
- **Up to 4 ports:** `serial0` through `serial3` are valid.
- **LXC containers:** Use the `lxc` API path (`client.api.nodes.get(node).lxc.cid(id).config`) — LXC uses `tty` count instead of `serial[n]`.
- **Related to agent channel:** The `agent=enabled=1` config also uses a virtio serial channel internally, but this is separate from the QEMU serial ports used by `termproxy`.

### Self-Healing Opportunity

The terminal error overlay (close code 4001) could offer an "Enable serial port" button for admins:
1. Detect serial error → show overlay
2. Admin clicks "Add serial0=socket"
3. Calls `config.post({ "serial0": "socket" })` (async, returns UPID)
4. Tracks task completion, shows "VM needs restart" notice
5. After restart, terminal becomes available

This would require the same admin auth already used for terminal login (username/password), so no additional auth surface is needed.

---

## Usability Test — 2026-06-26 Deploy Results

### Test Parameters
- **Server:** compute1-dev (pve, 145.24.222.41:8006)
- **Credentials:** root / TestP@ssw0rd123!
- **Naming convention:** ut-{template-name}
- **Started:** ~10:07 PM

### Results Summary

| # | VM Name | VMID | Template (ID) | Result | IP | Notes |
|---|---------|------|---------------|--------|----|-------|
| 1 | ut-debian12 | 101 | debian-12-cloud-template (9000) | ✅ PASS | 145.24.222.113 | IP discovered ~8m after start |
| 2 | ut-ubuntu24 | 102 | ubuntu-24.04-cloud-template (9001) | ✅ PASS | 145.24.222.217 | IP discovered ~9m after start |
| 3 | ut-ubuntu-desktop | 104 | UbuntuDesktop (103) | ✅ PASS | 145.24.222.126 | IP discovered ~2m after start |

### Key Observations
- All 3 templates deployed successfully — cloning + config + start completed without errors
- Guest agent IP discovery works on all 3 templates (cloud-init via `cicustom` installed `qemu-guest-agent`)
- Non-cloud UbuntuDesktop template (previously failing) now works — `cloud-init` was installed in the template
- Deploy notifications showed correctly (pending → success)
- No stuck states, no orphan VMs, no deploy-failed statuses
- IP discovery times: ~8-9m for cloud templates, ~2m for UbuntuDesktop (just needed agent install + reboot cycle)

### Timeline
- 10:07:33 — debian-12 clone started (qmclone 9000)
- 10:08:15 — ubuntu-24.04 clone started (qmclone 9001)
- 10:08:40 — debian-12 start completed (qmstart OK VM 101)
- 10:09:59 — ubuntu-24.04 start completed (qmstart OK VM 102)
- 10:09:xx — UbuntuDesktop clone started (qmclone 103)
- 10:12:xx — server timeout/reconnect event
- 10:14:xx — server back online
- 10:16:44 — UbuntuDesktop start completed (qmstart OK VM 104)
- 10:17:xx — debian12 IP discovered (145.24.222.113)
- 10:19:xx — all 3 VMs running with IPs
