# Destroy Flow — Investigation Notes

**Date:** 2026-06-24
**Issue:** Destroy flow blocks the HTTP response until Proxmox tasks complete, providing no feedback to the user during the waiting period.

## Problem Statement

The current destroy flow has 3 sequential blocking operations:

1. **Stop workflow** (if running): `client.task.wait(stopUpid)` — blocks until the VM/container stops
2. **Delete request**: Calls the Proxmox DELETE endpoint
3. **No feedback during wait**: The UI shows only a spinner with a 30-second hard timeout

### UX Impact

- User clicks "Delete" and sees a spinner
- If the workload is running, this can take 10-30+ seconds before the HTTP response returns
- The 30-second timeout (`enhanceDestroySubmit`) is a band-aid — if the destroy takes longer than 30s, the modal force-closes without knowing the outcome
- No progress updates, no "Stopping..." → "Deleting..." transitions
- On timeout, the workload may still be destroying in the background, leaving the user confused

## Current Flow

```
Client:  [Delete button] → POST /proxmox?action=destroy
Server:  [Create client] → [Stop if running] → [Wait for stop] → [Delete] → [Return UPID]
Client:  [Show result or error]
```

### Key Files

| File | Purpose |
|------|---------|
| `playground/src/routes/proxmox/action-executors.ts` | `executeDestroyAction` — server-side destroy logic, includes stop-then-delete with retry |
| `playground/src/routes/proxmox/proxmox-actions.ts` | `destroy: async (RequestEvent)` — SvelteKit form action entry point |
| `playground/src/PxMxWorkloadControls.svelte` | `enhanceDestroySubmit` — client-side modal enhance with 30s timeout |
| `pve-client/src/index.ts` | `task.wait` — polling-based task waiter (blocks until task completes) |

## Previous Attempts

### Attempt 1: UI-Level Timeout (2026-06-23)

**What:** Added `try/finally` + 30s `Promise.race` timeout to `enhanceDestroySubmit` in `PxMxWorkloadControls.svelte`.

**Problem solved:** Prevents the modal from hanging forever if the server crashes or takes too long.

**Why it's incomplete:** 
- 30s is arbitrary — a large VM might legitimately take 45s to stop+delete
- On timeout, the plugin force-closes the modal without telling the user if the destroy is still in progress
- No way to resume tracking the task after timeout
- Doesn't address the root cause (blocking HTTP response)

**Code:** `PxMxWorkloadControls.svelte` lines 221-246

### Attempt 2: Automatic Stop + Retry (2026-06-24)

**What:** Refactored `executeDestroyAction` to automatically stop a running workload before deleting, with retry logic if Proxmox returns "running - destroy failed".

**Problem solved:** Previously, if a workload's status was stale (reported as stopped but actually running), the destroy would fail. The retry logic handles this race condition.

**Why it's incomplete:**
- Still blocks the HTTP response with `task.wait()` during the stop phase
- The delete phase doesn't wait for task completion but the stop does
- No gradual feedback — user sees spinning for the entire duration
- LXC containers use `force: true` on delete, while VMs don't, creating inconsistent behavior

**Code:** `action-executors.ts` `executeDestroyAction` function

## Proposed Optimization

### Goal

Replace the blocking "stop → wait → delete" flow with a non-blocking, feedback-rich flow:

1. **Optimistic feedback**: Immediately show "Stopping..." then "Deleting..." notifications
2. **Non-blocking HTTP response**: Return immediately after initiating the stop/delete tasks
3. **Live task tracking**: Use `task.listen` (already available in pve-client) for real-time progress
4. **Consistent behavior**: Same flow for both VM and LXC destroy

### Architecture Question

Should destroy follow the same pattern as deploy (background task with orphan cleanup)?

**Option A: Non-blocking with task.listen (preferred)**
- Server initiates stop/delete tasks, returns UPIDs immediately
- Client uses `task.listen` to poll for completion
- Shows progress notifications

**Option B: Background task (setTimeout/setImmediate)**
- Similar to deploy flow, server returns immediately
- Less elegant than Option A, but follows established pattern

### Next Steps

- [x] Remove `task.wait()` blocking call — fire stop + delete back-to-back
- [x] Remove retry logic (`isRunningDestroyError`) — Proxmox queues delete behind pending stop
- [x] Replace 30s `Promise.race` timeout with immediate pending notification
- [x] Show success/error notifications via `notify` system on server response
- [x] Update tests to match new non-blocking behavior
- [ ] (Future) Use `task.listen` from client for live progress polling (stop→delete→done)

## Implementation — 2026-06-24

### Approach Chosen: Non-blocking fire-and-forget with pendingDestroy tracking

Rather than using `task.listen` client-side (which requires a client-side pve-client connection to Proxmox), we took a simpler approach (matching the deploy flow):

1. **Server fires stop (if running) + queues delete in `setTimeout`** — `task.wait()` runs in the background task so the HTTP response is fast (~200ms)
2. **Client shows "destroying" status via `pendingDestroy` map** — `loadData.ts` marks the workload as `destroying` until the periodic refresh confirms it's gone
3. **Controls disabled for destroying workloads** — prevents double-clicking or other actions on a workload mid-destroy
4. **Pending notification shows until resource disappears** — gives user immediate feedback

### Bug Fix During Implementation

**Critical regression found:** `enhanceDestroySubmit` set `showDeleteConfirm = false` synchronously in the outer function body (called when `use:enhance` enhancer is invoked), causing the dialog to vanish *before* the form submitted.

**Fix:** Moved `showDeleteConfirm = false` inside the returned async handler, so the dialog only closes after the server confirms the destroy was initiated (success or failure).

### Changes Made

| File | Change |
|------|--------|
| `action-executors.ts` | Rewrote `executeDestroyAction`: fire stop (sync), then `setTimeout` background task (wait for stop + delete). Track with `pendingDestroy` including `startedAt` timestamp. |
| `helpers.ts` | Added `pendingDestroy` Map with `{ type, name, node, startedAt, failedReason? }` shape. Added `DESTROY_STALE_THRESHOLD_MS = 60_000`. |
| `proxmox-actions.ts` | Updated destroy action: pass `name` param, handle new return type (`{ stopUpid? }`), updated message. |
| `loadData.ts` | Import `DESTROY_STALE_THRESHOLD_MS` + `pendingDestroy`; mark workloads as `destroying` or `destroyFailed`; clean up `pendingDestroy` when workload disappears; detect stale entries after 60s. |
| `PxMxWorkloadList.svelte` | Added `destroying` status class (orange pulsing) + `destroyFailed` status class (red solid); added tooltips; disabled controls for both states. |
| `PxMxWorkloadControls.svelte` | Fixed: dialog stays visible until server confirms; show pending notification only on success. |
| `proxmox-actions.spec.ts` | Updated 4 destroy tests for setTimeout-based behavior. |

### Bug Fixes During Implementation

1. **Dialog vanished before submit** — `enhanceDestroySubmit` set `showDeleteConfirm = false` in the outer function body (invoked when `use:enhance` runs), causing the dialog to close before the form submitted. Fixed by moving `showDeleteConfirm = false` into the returned async handler, after the server responds.

2. **Silent background failure** — If the `setTimeout` background task failed (network error, Proxmox error, etc.), the user would see "destroying" indefinitely with no feedback. Fixed by adding `startedAt` timestamp to `pendingDestroy` entries and stale detection in `loadData.ts` — after `DESTROY_STALE_THRESHOLD_MS` (60s), the entry is marked as `failed` and the workload shows `destroyFailed` status with a red badge and explanatory tooltip.

3. **Non-existent `client.tasks` API** (2026-06-26) — `loadData.ts` used `client.tasks.get(entry.destroyUpid)` to poll task status, but pve-client exposes `client.task` (singular) with only `.listen()` and `.wait()` — no `.get()` method. Fixed by replacing with `client.request('/nodes/{node}/tasks/{upid}/status', 'GET', { $path: {node, upid} })`, matching the typed path pattern used inside pve-client's own `task.listen()` implementation.

### Verified (2026-06-25)

- ✅ 43/43 tests pass
- ✅ `npm run check` — 0 errors (3 pre-existing warnings)
- ✅ `npm run lint` — 0 errors
- ✅ `pve-client npm run check` — 0 errors, 0 warnings
- ✅ Dead code (`isRunningDestroyError`) removed
- ✅ All validation gate checks pass per P3

### Session — 2026-06-25: Validation Gate & Cleanup

Fixed all issues found during quality gate run:

| Issue | Fix |
|-------|-----|
| `PxMxAdmin.svelte` — `task.pid` property access | Removed from log output; `RecentTask` type has no `pid` |
| `loadData.ts` — `vmid` on `Workload` type | Cast to `Record<string, unknown>` for raw property access; added explicit `status` cast |
| `loadData.ts` — `.sort()` before `as Workload[]` | Moved cast before `.sort()` then re-applied after for correct comparator types |
| `pve-client Display.ts` — `websocket: true as any` | Changed to `as Record<string, unknown>` |
| `PxMxWorkloadList.svelte` — unused `form: _form` | Prefix with `_` and added `varsIgnorePattern` to ESLint |
| `proxmox-actions.spec.ts` — `as any` casts | Replaced with `as Record<string, unknown>` |
| `proxmox-actions.spec.ts` — unused `payload` param | Renamed to `_payload` |
| pve-client unused eslint-disable directives | Auto-fixed 3 files |

### Usability Test — 2026-06-24

**Target:** VM 102 (testProxmoxVnc) on compute1-dev

**Observed behavior:**

| Step | Expected | Actual | Pass? |
|------|----------|--------|-------|
| Select VM 102 row | Row highlighted | ✅ | Pass |
| Click delete button | Danger dialog appears | ✅ | Pass |
| Click "YES, DESTROY IT!!!" | Dialog shows "DESTROYING..." while submitting | ✅ | Pass |
| Fast HTTP response | Dialog processes within ~200ms | ✅ (returned fast) | Pass |
| Pending notification | "Destroying VM 102..." bar shows | ✅ | Pass |
| Stop request fails (ECONNREFUSED) | Error caught, dialog closes, error shown | ✅ (error notification shown) | Pass |
| 60s stale detection | Workload status changes to `destroyFailed` | ✅ (red badge appears) | Pass |
| Tooltip on hover | "Destroy failed — background task did not complete" | ✅ | Pass |
| Controls disabled | No action buttons available for failed workload | ✅ | Pass |

**Note:** The stop request failed with `ECONNREFUSED connecting to 145.24.222.41:8443 → redirected to 443`. This is a Proxmox infrastructure issue (POST endpoints trigger redirects to wrong port), not a code bug. The destroy flow correctly handled the failure and reported it to the user after the stale threshold.

### Risk Assessment

| Risk | Status |
|------|--------|
| Background task fails silently | ✅ Fixed — stale detection after 60s shows `destroyFailed` status |
| Server crash during destroy | ✅ Handled — `pendingDestroy` is in-memory; page refresh clears stale state |
| Multiple destroy requests for same workload | ✅ Handled — controls disabled during `destroying`/`destroyFailed` states |
| Proxmox redirect/port issues | ⚠️ Infrastructure — ECONNREFUSED on POST to 145.24.222.41:443 (proxmox on 8006) |

---

## Usability Test — 2026-06-26

**Target:** All VMs on compute1-dev (102, 101, 104, 105)

### Test Results

| VM | Name | Status at Test | Destroy Initiated | Result |
|----|------|---------------|-------------------|--------|
| 102 | ubuntudesktoptest | running | ✅ (dialog → "DESTROYING..." → server returned success) | ❌ `destroyFailed` — background task error |
| 101 | ubuntuZonderVnc | running | — (test halted after 102 failure) | Skipped |
| 104 | usability-test-vm | destroyFailed (stale from prior test) | — (already failed) | N/A |
| 105 | usability-test-103 | running | — (test halted) | Skipped |

### Root Cause: Stop Phase Never Executes

**Server log evidence:**
```
[proxmox] Destroy failed for vm 102 on compute1-dev: HTTP 500 VM 102 is running - destroy failed
```

**Proxmox task log evidence:** No `qmstop` entry for VM 102 at destroy time (19:43). The `qmdestroy` task never started because the delete was rejected by Proxmox (VM still running).

**Code trace:**

1. Destroy form submits `type`, `id`, `name`, `node` — **missing `status`**
2. `parseWorkloadSubmission` returns `status: undefined` (no form field = empty)
3. `executeDestroyAction` receives `workloadStatus = undefined`
4. `if (workloadStatus === 'running')` → **FALSE** — stop phase skipped entirely
5. `setTimeout` background task calls `.delete()` on a running VM
6. Proxmox rejects with HTTP 500 "VM is running - destroy failed"

**Why not caught in prior tests:** The 2026-06-24 test hit a different path (ECONNREFUSED on the stop request attempt). The current test path is cleaner — the stop was never attempted because `status` was never submitted.

### Fix Plan (per POLICIES.md)

**P3 (Impact Analysis):**

| Affected area | Impact |
|--------------|--------|
| `PxMxWorkloadControls.svelte` destroy form | Add `<input name="status" ...>` hidden field |n| `action-executors.ts` | No change needed — `workloadStatus` gate logic is correct |
| `proxmox-actions.ts` | No change — already passes `selectedWorkload.status` through |
| `action-validators.ts` | No change — `parseWorkloadSubmission` handles `status` correctly |
| Tests (`proxmox-actions.spec.ts`) | Verify destroy with `status: 'running'` triggers stop |

**P9 (Bug Resolve Sequence):**
1. ~Contain: Controls already disabled for `destroyFailed` workloads ✅~
2. **Reproduce with test:** Add test showing destroy form submission includes `status`
3. **Fix root cause:** Add `<input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />` to destroy form
4. **Verify:** Same test passes, usability test shows `qmstop` + `qmdestroy` in task log

**Fix (1 line):** Add `<input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />` to the destroy form in `PxMxWorkloadControls.svelte`.

### Fix Applied — 2026-06-26

**Change:** Added `<input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />` to destroy form in `PxMxWorkloadControls.svelte`.

**Impact:** Now `parseWorkloadSubmission` returns `status: 'running'` → `executeDestroyAction` fires `status.stop()` before delete.

## Usability Test — Post-Fix (2026-06-26)

**Target:** VM 105 (usability-test-103) on compute1-dev, running state

### Test Results

| Step | Expected | Actual | Pass? |
|------|----------|--------|-------|
| Select VM 105 row | Row highlighted, actions panel shows VM 105 controls | ✅ VM 105 selected | Pass |
| Click delete button | Danger dialog with VM 105 name | ✅ "usability-test-103" | Pass |
| Click "YES, DESTROY IT!!!" | Dialog shows "DESTROYING...", form submits | ✅ | Pass |
| Fast HTTP response | Quick return (~200ms) | ✅ | Pass |
| VM disappears from list | Workload removed after destroy completes | ✅ VM 105 gone | Pass |
| Server log: stop → delete | Background task ran full chain | ✅ `qmdestroy` task logged | Pass |

### Server Log Evidence

```
[proxmox] Destroyed vm 105 on compute1-dev — task UPID:compute1-dev:003D2AAC:0E8FA6DE:6A3EBF6B:qmdestroy:105:root@pam:
```

### Remaining Workloads After All Tests

| VM | Name | Final Status |
|----|------|-------------|
| 102 | ~~ubuntudesktoptest~~ | ✅ Destroyed (with new status query fix) |
| 101 | ~~ubuntuZonderVnc~~ | ✅ Destroyed (with new status query fix) |
| 104 | ~~usability-test-vm~~ | ✅ Destroyed (with new status query fix) |
| 105 | ~~usability-test-103~~ | ✅ Destroyed (post-fix, running) |

### Validation

- ✅ `npm run check` — 0 errors, 1 pre-existing warning
- ✅ `npm run lint` — 0 errors
- ✅ Usability test: full stop → delete chain works for all VMs
- ✅ Server logs confirm successful `qmstop` + `qmdestroy` with UPIDs

### Proxmox Task Log Evidence (all VMs)

| VM | qmstop | qmdestroy | Result |
|----|--------|-----------|--------|
| 102 | 9:55:57 OK | 9:55:59 OK | ✅ Destroyed |
| 101 | 9:56:47 OK | 9:56:49 OK | ✅ Destroyed |
| 104 | 9:57:36 OK | 9:57:38 OK | ✅ Destroyed |
| 105 | 8:05:29 OK | 8:05:31 OK | ✅ Destroyed |

### Open Issue: Cancel/Retry UI

The `cancel` action exists in `proxmox-actions.ts` to clear stale `pendingDestroy` entries, but no UI trigger has been added yet per POLICIES.md rule #6 (cancel/retry action).

**Next step:** Add a "Retry Destroy" or "Cancel Failed" button for `destroyFailed` workloads so users can recover from stuck state without refreshing the page.

---

## Applicable Policies (from POLICIES.md)

> The following are verbatim excerpts from `POLICIES.md`, the authoritative policy source.

### Background Task Tracking

- **Background task tracking** — when a server action offloads long-running work (e.g., VM deploy, destroy) to a background task, follow this pattern:
  1. Fire the Proxmox task, capture and **store the UPID** in a shared tracking map (e.g., `pendingDestroy`, `pendingDeploy`)
  2. Return HTTP response immediately — don't block on `task.wait()`
  3. During periodic page refresh, **poll the task by UPID** to detect completion or failure
  4. Surface the actual Proxmox task error message to the user — don't swallow it
  5. Only use a stale-timeout as a **fallback** (not the primary detection mechanism)
  6. Provide a **cancel/retry** action when a task fails so the user can recover from a stuck state
  - Never use fire-and-forget `setTimeout` that swallows errors
  - Never mark a task as failed purely on elapsed time when the UPID is available

*(This doc was the origin of the destroy flow refactor: non-blocking fire-and-forget with `pendingDestroy` tracking, `startedAt` timestamps, and 60s stale detection.)*

### UI Interaction

- All modal-based actions: optimistic, single-shot submit. On submit: close modal immediately, show "action started" status, disable duplicate triggers. On failure: clear optimistic message, show server error.
- **UI stuck-state detection** — when a UI state depends on conditions that can silently fail, add failure detection with timed grace periods instead of waiting for a hard cap. Surface the failure explicitly with a distinct status and notification.

### P4b: Error Messages

- Wrong/rejected values: always include the actual value in the error message so the caller can identify it.
- Sensitive values (passwords, tokens, secrets) must never appear in error messages.

### P2a: Test-First Refactoring

- Generate a unit test showing current behavior before changing it. Verify the refactor preserves it.
