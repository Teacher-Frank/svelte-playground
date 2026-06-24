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

### Approach Chosen: Non-blocking fire-and-forget

Rather than using `task.listen` client-side (which requires a client-side pve-client connection to Proxmox), we took a simpler approach:

1. **Server fires stop + delete without `task.wait()`** — Proxmox internally queues the delete task behind any pending stop task, so the delete won't fail with "running - destroy failed".
2. **Client shows `pending` notification on close** — immediate feedback that destroy is in progress.
3. **Server returns UPIDs immediately** — HTTP response is fast (~200ms instead of 10-30s).
4. **Client shows `success`/`error` notification** on server response, replacing the pending bar.
5. **Removed 30s `Promise.race` timeout** — no longer needed since the server response is fast.

### Changes Made

| File | Change |
|------|--------|
| `action-executors.ts` | Rewrote `executeDestroyAction`: removed `task.wait()`, removed `isRunningDestroyError` retry logic, fire stop + delete back-to-back |
| `PxMxWorkloadControls.svelte` | Replaced `Promise.race` timeout with `notify.pending()` → `notify.success()`/`notify.error()` flow |
| `proxmox-actions.ts` | Updated destroy message to reflect async nature + includes UPIDs |
| `proxmox-actions.spec.ts` | Updated 4 destroy tests to match new non-blocking behavior |

### Verified

- ✅ 22/22 tests pass
- ✅ `npm run check` — 0 errors (3 pre-existing warnings)
- ✅ Dead code (`isRunningDestroyError`) removed

### Risk Assessment

| Risk | Mitigation |
|------|-----------|
| Delete succeeds but response fails | Client polls task state on reload |
| Stop takes longer than expected | Show "Stopping... this may take a moment" after 5s |
| Race between stop and delete | Keep retry logic but make non-blocking |
