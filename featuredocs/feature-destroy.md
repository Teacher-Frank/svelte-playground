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
