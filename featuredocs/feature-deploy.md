# Deploy Progress — Investigation Notes

**Date:** 2026-06-18 → Updated 2026-07-01
**Issue:** Ubuntu Desktop VM deployment stays stuck in "Deploying..." mode until the 10-minute hard cap expires.

---

## All Sessions Summary

| Session | Date | Changes |
|---------|------|---------|
| **cicommand fabrication discovery** | 2026-06-19 | Found that `cicommand` is not a real Proxmox API parameter. Removed dead code from `action-template-deployers.ts`, created canary test in pve-client, consolidated test assertions |
| **cicustom solution** | 2026-06-19 | Implemented `cicustom` + `runcmd` approach for guest agent installation via cloud-init snippet. Created `install-agent.yaml` and `deploy-cloudinit-snippets.sh` host script |
| **Deploy flow refactor** | 2026-06-23 | Fixed 6 issues: YAML syntax error, notification gap (added `pending` kind), duplicate notifications consolidated, modal timeouts added (try/finally + 30s timeout), sticky dialog backdrop fix |
| **Non-blocking server deploy** | 2026-06-24 | Server now returns clone UPID immediately; config+start runs in background. Added orphan VM cleanup (`destroyOrphanVm()`) when background task fails after clone. E2E test passed (VM 104, IP visible) |
| **Deploy failure detection** | 2026-06-24 | Added `tasksSettledAt` tracking + 60s grace period. Show `deploy-failed` red badge + error notification, auto-remove after 10s. Fixed corrupted template literal syntax error in `proxmox-actions.ts` |
| **Serial port configuration** | 2026-06-25 | Documented serial0=socket API surface. Added `serial0=socket` to `runPostCloneSteps` during deployment (same pattern as net0/ipconfig0/agent) for terminal access on every deployed VM |
| **Admin guide template update** | 2026-06-25 | Updated `PxMx-Admin-For-Datalab-Guide.md` §1.4 and §1.7: template needs `cloud-init` + `/etc/cloud/cloud.cfg`; `qemu-guest-agent` is installed by deploy flow via `cicustom` |
| **Debug logging** | 2026-06-25 | Added `[taskTransition]` console.info on task state changes + `window.pveDebug.allTasks()` for manual inspection |
| **Usability testing** | 2026-06-26 | Deployed 3 VMs (debian-12, ubuntu-24.04, ubuntu-desktop). All passed: agent detected, IPs discovered, correct notifications, no stuck states |
| **vendor= vs user= fix** | 2026-06-27 | Discovered `user=` in `cicustom` replaces Proxmox's auto-generated user-data (losing `cipassword`). Changed to `vendor=` which merges on top, preserving password login |
| **Deploy shadowing + controls** | 2026-06-27 | Fixed dual-row regression during clone (VMID propagation + VMID-first shadowing). Fixed control disable state machine (extracted `isDisabledStatus()`, delete always enabled on failure states) |
| **Static IP post-deploy** | 2026-06-29 | Implemented DHCP→static IP conversion in `install-agent.yaml` via `cicustom` vendor snippet. Second `runcmd` extracts DHCP IP + gateway, rewrites Netplan (`dhcp4: false` + static addresses/routes/nameservers), applies. Idempotent. Script updated + featuredoc section added. Awaiting host deployment + E2E test. |
| **Deploy concurrency guardrail** | 2026-07-01 | Added singleton `pendingDeployLock` in `helpers.ts` to prevent simultaneous deployments that crashed the dev server. All three deploy actions (`cloneFromTemplate`, `cloneLxcGuestTemplate`, `cloneLxcTemplate`) now acquire lock before deploy, release in finally/catch. Returns `fail(409)` with descriptive message when a deploy is already in progress. Lock auto-expires after 10 min. |

---

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
qm set <vmid> --cicustom "vendor=local:snippets/install-agent.yaml"
```

Or via API, in the config body:
```typescript
configBody.cicustom = 'vendor=local:snippets/install-agent.yaml';
```

### ⚠️ Critical: Use `vendor=` NOT `user=`

**Discovered 2026-06-27:** Using `user=` in `cicustom` causes password login to fail on deployed VMs.

**Root cause:** When `cicustom` is set to `user=...`, it **replaces** Proxmox's auto-generated cloud-init user-data file. Proxmox normally writes the `ciuser`/`cipassword` values into this auto-generated user-data file. By replacing it with a custom snippet (which only contains `runcmd` for agent installation), the password from `cipassword` is **never written to the VM**.

**Timeline of the bug:**
1. `configBody.ciuser` and `configBody.cipassword` are sent to Proxmox ✓
2. `configBody.cicustom = 'user=...'` tells Proxmox "use MY file instead of the auto-generated user-data"
3. Proxmox's auto-generated user-data (which would have embedded `ciuser`/`cipassword`) is **discarded**
4. The custom snippet (which only has `runcmd` for agent install) is used as the sole user-data source
5. The VM boots, cloud-init runs `runcmd` (agent installs), but the password was never set
6. Login fails: the credentials the user entered during deploy were silently ignored

**Fix:** Use `vendor=` instead of `user=` — the `vendor=` cloud-data file is **merged on top of** the user-data (which still contains the password), rather than replacing it.

**Proxmox `cicustom` data source keys:**

| Key | What it does | Effect on `ciuser`/`cipassword` |
|-----|-------------|-|
| `user=` | **Replaces** Proxmox's auto-generated user-data | ✗ Password is lost |
| `vendor=` | **Merges** with Proxmox's auto-generated user-data | ✓ Password preserved |
| `network=` | Replaces network configuration | N/A |

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

- [x] **Static IP post-deploy** — added DHCP→static `runcmd` to `install-agent.yaml` via `cicustom` vendor snippet. Waits for eth0 IP, reads gateway, rewrites Netplan from `dhcp4: true` to static config (addresses/routes/nameservers 1.1.1.1+8.8.8.8), applies via `netplan apply`. Idempotent (skips if already static). Fixed `${IP/24}` → `${IP}/24` bash bug. Updated script summary docs. Pending: host deployment + E2E test on fresh VM. |

- [x] **Deploy concurrency guardrail** — added singleton `pendingDeployLock` in `helpers.ts`. All three deploy actions acquire the lock before starting; second request gets `fail(409)" Deployment already in progress for '...'"`. Lock released in `finally`/catch (LXC synchronous) or `runPostCloneSteps finally` (VM background). Auto-expires after 10 min (matches hard cap). `npm run check` + `npm run lint` clean.

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

### VM Credentials (all 3 VMs)
| VM Name | IP | Username | Password |
|---------|----|----------|----------|
| ut-debian12 | 145.24.222.113 | `root` | `TestP@ssw0rd123!` |
| ut-ubuntu24 | 145.24.222.217 | `root` | `TestP@ssw0rd123!` |
| ut-ubuntu-desktop | 145.24.222.126 | `root` | `TestP@ssw0rd123!` |

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

---

## Deploy Shadowing Regression — 2026-06-27

### Problem

During deployment, two rows appeared:

| Row | ID | Name | Status |
|----|----|------|--------|
| 1 | `deploying-vm-1782555135218-0` | ubuntudesktoptest | deploying |
| 2 | `101` | VM 101 | stopped |

`isShadowedByDeployingWorkload` matches by **name + node** — but Proxmox returns a placeholder name (`"VM 101"`) during cloning, not the deploy name (`"ubuntudesktoptest"`). The shadow fails, both rows show.

### Root Cause

1. `nextid()` returns 101 (reused ID), clone starts with `{ newid, name: "ubuntudesktoptest" }`
2. The clone takes 20–60 seconds — during that window, `qemu.list()` shows the VM with its placeholder/original name
3. The deploy tracks `vmid` on the server but never propagates it to the client shadowing logic

### Fix: Federated Deploy Shadowing by VMID

**Strategy:** Extract the assigned VMID from the clone, propagate it through the server response, mark the deploying workload with its VMID, and use VMID as primary shadowing key.

#### Chain

| Layer | Change |
|-------|--------|
| `action-template-deployers.ts` | `deployVmFromTemplate` returns `{ cloneUpid, newid }` |
| `proxmox-actions.ts` | Extract `newid`, return as `deployWorkloadId` |
| `templates/EnhanceDialog.svelte` | Extract `deployWorkloadId` from result data, pass as `vmid` to `onDeployStarted` |
| `templateDialogEnhance.ts` | Extend `EnhanceResult.data` with optional `deployWorkloadId` |
| `PxMxAdmin.svelte` | Extend `DeployingWorkload` with optional `vmid`, update `markDeployingWorkload` to accept it, add VMID-first shadowing in `isShadowedByDeployingWorkload` |

```typescript
// Before — name-only shadow
return deployingWorkloads.some((pending) =>
  pending.name.trim().toLowerCase() === workloadName
);

// After — VMID-first, name fallback
const workloadVmid = typeof workload.id === 'number' ? workload.id : undefined;
if (workloadVmid != null) {
  if (deployingWorkloads.some(
    (pending) => pending.kind === kind && pending.vmid === workloadVmid
  )) return true;
}
// ...name fallback...
```

**Result:** During clone, `"VM 101"` and `"ubuntudesktoptest"` no longer matter — shadow matches by `pending.vmid === workload.id === 101`.

#### Files Changed

| File | Change |
|------|--------|
| `action-template-deployers.ts` | Return `{ cloneUpid, newid }` |
| `proxmox-actions.ts` | Extract `newid`, return as `deployWorkloadId` |
| `templates/EnhanceDialog.svelte` | Pass `vmid` from `result.data.deployWorkloadId` to parent |
| `templateDialogEnhance.ts` | Add optional `deployWorkloadId` to `EnhanceResult.data` |
| `PxMxAdmin.svelte` | Add optional `vmid` to `DeployingWorkload`, update `markDeployingWorkload(..., vmid?)`, add VMID-first shadowing |

### Control Disable State Machine — 2026-06-27

The deploy/destroy flow also surfaced a control disable regression:

**Before:**
- `deployFailed` workloads had all controls enabled (including Start/Stop/Restart on a broken deploy)
- `destroyFailed` workloads had all controls disabled (including delete — no way to retry)

**After:**

| Status | Start/Stop/Restart | Delete | Configure/Convert |
|--------|-------------------|--------|-------------------|
| `running` | ✅ | ✅ | ✅ |
| `deploying` | ❌ (all disabled) | ❌ | ❌ |
| `destroying` | ❌ (all disabled) | ❌ | ❌ |
| `deployFailed` | ❌ (controlled by component) | ✅ (enable cleanup) | ❌ |
| `destroyFailed` | ❌ (controlled by component) | ✅ (enable cleanup) | ❌ |

#### Files Changed

| File | Change |
|------|--------|
| `PxMxWorkloadList.svelte` | Add `isDisabledStatus()` helper + `DISABLED_STATUSES` constant, use in `disabled=` bindings |
| `PxMxWorkloadControls.svelte` | Add `deployFailed` to `controlsDisabled` (delete stays enabled) |

### Validation

- ✅ `npm run check` — 0 errors
- ✅ `npm run lint` — 0 errors

---

## Static IP Post-Deploy Configuration — 2026-06-29

### Problem

Deployed VMs receive a DHCP-assigned IP on first boot. The IP is ephemeral — it changes on every restart when DHCP reassigns. For any VM that needs a stable, predictable address (e.g., lab/test servers), the user must manually SSH in and edit Netplan after every deploy.

**Observed:** VM 102 (`ut-ubuntu24`) restarted — DHCP still active (`dhcp4: true`), IP changed from `145.24.222.217` to `145.24.222.38`.

### Desired State

The post-clone flow should convert the DHCP-assigned IP to static **during first boot**, so the deployed VM has a permanent IP from the start.

### Approach: Extend `cicustom` vendor snippet with DHCP→static conversion

The deploy flow already uses `cicustom` with `vendor=` to merge a cloud-init snippet that installs `qemu-guest-agent` (see "Working Solution: `cicustom` with cloud-init `runcmd"` above). The same vehicle can carry an additional `runcmd` step.

**Why `cicustom` + `vendor=` + `runcmd` is the right path:**

1. **Already works** — the `vendor=` merge path is proven (agent install works on all templates).
2. **Runs on first boot** — cloud-init executes `runcmd` during first boot, before user login.
3. **Idempotent** — the script can check current state and skip if already static.
4. **No server-side change needed** — the conversion logic lives in the VM guest, not in Proxmox.
5. **Preserves credentials** — `vendor=` merges on top of Proxmox's user-data (password login unaffected).

### Implemented `runcmd` in `deploy-cloudinit-snippets.sh`

```yaml
#cloud-config
runcmd:
  # 1. Install qemu-guest-agent (existing)
  - >-
    test -f /usr/sbin/qemu-ga ||
    (apt-get update -qq && apt-get install -y qemu-guest-agent) &&
    systemctl enable --now qemu-guest-agent

  # 2. Convert DHCP to static IP (new)
  - >-
    bash -c '
      # Wait for network to be ready
      for i in $(seq 1 30); do
        IP=$(ip -4 addr show eth0 2>/dev/null | grep -oP "inet \K[0-9.]+" | grep -v "^127.");
        if [ -n "$IP" ]; then break; fi;
        sleep 1;
      done;

      # Skip if already static
      if ! grep -q "dhcp4: true" /etc/netplan/*.yaml 2>/dev/null; then
        exit 0;
      fi;

      GATEWAY=$(ip route show default 2>/dev/null | awk "/default/{print $3}" | head -1);
      if [ -z "$IP" ] || [ -z "$GATEWAY" ]; then exit 0; fi;

      # Find the netplan file with dhcp4: true and rewrite it
      NETPLAN_FILE=$(grep -l "dhcp4: true" /etc/netplan/*.yaml | head -1);
      if [ -z "$NETPLAN_FILE" ]; then exit 0; fi;

      # Build static config
      MAC=$(ip link show eth0 | grep -oP "link/ether \K[0-9a-f:]+" );
      cat > "$NETPLAN_FILE" << EOF
      #cloud-config
      network:
        version: 2
        ethernets:
          eth0:
            match:
              macaddress: "$MAC"
            dhcp4: false
            addresses:
              - "$IP/24"
            routes:
              - to: default
                via: "$GATEWAY"
            nameservers:
              addresses:
                - 1.1.1.1
                - 8.8.8.8
            set-name: eth0
      EOF

      netplan apply 2>/dev/null || true
    '
```

### Execution order on first boot

1. VM boots from clone → cloud-init starts
2. cloud-init reads **both** data sources:
   - Proxmox auto-generated user-data (`ciuser`, `cipassword`)
   - Custom vendor-data snippet (`runcmd`: agent install + DHCP→static)
3. `runcmd` executes in order:
   - Agent install (existing)
   - DHCP→static conversion (new)
4. `netplan apply` takes effect — IP becomes static
5. VM is ready with static IP that persists across reboots

### Key design decisions

| Decision | Rationale |
|----------|-----------|
| **Extend existing snippet, not create new one** | One snippet via `vendor=` is enough — adding `runcmd` items is additive |
| **Skip if already static** | Idempotent — safe if cloud-init reruns or template is redeployed |
| **Use DHCP-discovered IP as static** | The IP the network already assigned is the one the user would expect to keep |
| **Hardcoded `1.1.1.1` + `8.8.8.8` DNS** | No env var needed; Cloudflare + Google are universal fallbacks |
| **No `PVE_` env var required** | The conversion logic is self-contained in the guest; no server-side config needed |

### Alternatives considered

| Approach | Rejected because… |
|----------|-------------------|
| Set `ipconfig0=CIDR` during deploy | Requires pre-allocating an IP range, tracking allocations, handling conflicts — over-engineered |
| Post-deploy API call (agent/exec) | Agent must already be running (chicken/egg for first boot) |
| Hookscript on Proxmox side | Runs on host, not guest — can't easily rewrite guest Netplan |
| Proxmox `ipconfig0` with static IP field in deploy dialog | Requires UI change, IP allocation tracking, conflict detection — phase 2 |

### Next implementation steps

1. [x] Extend `install-agent.yaml` with DHCP→static `runcmd` (above) — done in `scripts/host/deploy-cloudinit-snippets.sh`
2. [ ] Re-run `deploy-cloudinit-snippets.sh` on the Proxmox host to update the snippet
3. [ ] Deploy test VM from clean template, verify:
   - Agent detected ✓
   - IP shown as static (not "dynamic" in `ip addr`)
   - Netplan YAML shows `dhcp4: false` with `addresses`
   - IP persists after manual reboot
4. [ ] Update admin guide if deployment workflow changes for admins

---

## Deploy Concurrency Guardrail — 2026-07-01

### Problem

Two simultaneous deploys (triggered from tabs or rapid clicks) crashed the dev server. The root cause was that the VM deploy runs `deployVmFromTemplate` → fire clone → `setTimeout` background work, with no coordination between requests. Concurrent requests could share Proxmox client state, race on `cluster.nextid()`, or hit the background `runPostCloneSteps` work simultaneously.

### Fix: Singleton `pendingDeployLock` in `helpers.ts`

A singleton lock (following the existing `pendingDestroy` Map pattern) ensures only one deploy operation runs at a time across all server requests.

| Component | Change |
|-----------|--------|
| `helpers.ts` | Added `pendingDeployLock`, `acquireDeployLock()`, `releaseDeployLock()` — singleton process-level lock with 10-minute expiry |
| `proxmox-actions.ts` (`cloneFromTemplate`) | Acquires `vm` lock after validation, before `deployVmFromTemplate`; releases in catch |
| `proxmox-actions.ts` (`cloneLxcGuestTemplate`) | Acquires `lxc` lock; releases in `finally` + catch |
| `proxmox-actions.ts` (`cloneLxcTemplate`) | Acquires `lxc` lock; releases in `finally` + catch |
| `action-template-deployers.ts` (`runPostCloneSteps`) | Adds `finally` block releasing `vm` lock after background work (success or failure) |

### Lock semantics

- **Acquire:** returns `null` if lock is free; returns error string if held
- **Stale lock expiry:** 10 minutes (matches client hard cap) — auto-released with warning
- **Release:** idempotent (checks kind + name match); safe to call with empty string in catch
- **HTTP response:** second request gets `fail(409, "Deployment already in progress for '...'")`

### Validation

- ✅ `npm run check` — 0 errors
- ✅ `npm run lint` — 0 errors
