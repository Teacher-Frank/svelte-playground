# Feature: Rename Button

**Owner:** `PxMxWorkloadControls.svelte`  
**Server:** `proxmox-actions.ts` → `action-executors.ts`  
**First committed:** —  
**Last reviewed:** 2026-07-07

---

## Summary

The Rename button lets a user change the name of a running or stopped workload (VM or LXC container). It is presented as a rename-icon button in the workload controls row, opens a small modal dialog with the current name pre-filled, and submits a SvelteKit form action to the server.

**Scope change (2026-07-07):** Reduced from multi-field "Configure" (CPU/memory/storage/name) to rename-only. Hardware configuration (CPU, memory, storage) is now handled via the template system — templates encode the resource profiles, so per-workload tweaking of raw hardware values is unnecessary. The button icon changed from settings (⚙️) to a rename icon, and the button label changed to "Rename."

---

## User Flow

1. User clicks the rename icon button in a workload's action toolbar.
2. A modal dialog appears titled **"Rename Workload"** with a single text input field:
   — *Name* (required, pre-filled with current workload name)
3. User edits the name and clicks **OK**.
4. Modal closes immediately (optimistic UX). A toast notification shows the server result on return.
5. On success: show "Renamed to \"…\"" toast. On failure: error toast with server message.

---

## Enablement Conditions

The rename button is enabled only when **all** of the following are true:

| Condition | Source |
|-----------|--------|
| Workload is a VM (`type === 'vm'`) or container (`type === 'container'`) | `selectedWorkload?.type` |
| Workload has a valid `id` and `node` | `selectedWorkload` fields |
| Controls are not globally disabled | `controlsDisabled` prop |

Unlike the previous full configure button, the rename button does **not** require host capacity data. It remains enabled regardless of whether `hostMaxCpu`/`hostMaxMemory` are available.

---

## Architecture

### Client-Side (`PxMxWorkloadControls.svelte`)

```
User clicks rename button
  → openRenameModal()        — seeds workloadName, sets showRenameModal = true
  [modal dialog rendered with {#if showRenameModal}]
  → User submits form        — method="POST" action="?/renameWorkload"
  → enhanceRenameSubmit()    — SvelteKit enhance handler:
      1. Sets renameSubmitInFlight = true
      2. Closes modal immediately (showRenameModal = false)
      3. Races update() against 30 s timeout (prevents hung state)
      4. On success  → notify.success(server message)
      5. On failure  → notify.error(server message)
      6. Finally     → renameSubmitInFlight = false
```

**State variables:**
- `showRenameModal` — dialog visibility
- `renameSubmitInFlight` — guards against duplicate submits during flight
- `workloadName` — form field binding (single text input)

**Scroll preservation:** The enhance handler captures `window.scrollX/Y` before submit and restores it after form state update, preventing page jump on SvelteKit form navigation.

**Effect cleanup:** An `$effect` closes the rename modal (and the delete-confirm dialog) when `controlsDisabled` becomes `true`.

### Server-Side (`proxmox-actions.ts` → `action-executors.ts`)

**Action: `renameWorkload`**

1. **Parse form data** — `parseWorkloadSubmission()` extracts type, id, node, (current) name.
2. **Validate fields:**
   - New name: required (from `newName` form field), must be non-empty, validated by `validateProxmoxName()` (letters, digits, hyphens, dots)
3. **Call executor** — `executeWorkloadRenameAction()`

**Executor: `executeWorkloadRenameAction()`**

```
1. Create client (createClient())
2. Validate new name differs from current name (no-op → early return)
3. Call Proxmox config API:
   - LXC: PUT /nodes/{node}/lxc/{vmid}/config with { name: newName }
   - QEMU: PUT /nodes/{node}/qemu/{vmid}/config with { name: newName }
4. Return UPID (config task UPID)
```

**Workload type branching:**

| | LXC Container | QEMU VM |
|---|---|---|
| Config API | `PUT /nodes/{node}/lxc/{vmid}/config` | `PUT /nodes/{node}/qemu/{vmid}/config` |
| Body | `{ name: newName }` | `{ name: newName }` |

The rename operation is the same API call pattern for both workload types — only the endpoint path differs (`lxc` vs `qemu`). No CPU, memory, or resize parameters are sent.

**Return value** (to action handler):
```ts
{
  upid?: string;    // config task UPID
}
```

**Success message format** (returned to client):
```
Renamed "<kind>" from "<oldName>" to "<newName>"
Task UPID returned to client for server-side event polling (not waited on in this action).
```

---

## Error Handling

| Layer | Error Type | Response |
|-------|-----------|----------|
| Client form validation | Empty name | HTML5 `required` + minlength=1 validation |
| Client form validation | Invalid Proxmox name | Server returns `fail(400)` with `validateProxmoxName()` error text |
| Server executor | Name unchanged from current | Early return, success message "Name unchanged" |
| Server executor | Proxmox API error | `throw Error` → caught by global fallback handler |
| Client enhance | Server timeout (30 s) | Timeout resolves Promise.race; in-flight cleared; no toast |

---

## Key Dependencies

| Module | File | Purpose |
|--------|------|---------|
| `parseWorkloadSubmission()` | `routes/proxmox/action-validators.ts` | Extracts workload identity from FormData |
| `validateProxmoxName()` | `routes/proxmox/action-validators.ts` | Proxmox name regex validation |
| `useToast()` | `notification-store.svelte.ts` | Toast notification store |
| `ToastNotification.svelte` | `src/` | Unified toast UI component |
| `createClient()` | `routes/proxmox/` | Proxmox API client factory |

---

## Design Decisions

1. **Optimistic modal close** — Modal closes on submit without waiting for server response. Follows POLICIES.md P6 (predictable UI behavior) and the "single-shot submit" pattern.

2. **No host capacity dependency** — Unlike the previous full configure button, rename doesn't need node status data. The button is enabled whenever a workload is selected and controls aren't disabled.

3. **Dedicated rename action** — Rather than keeping `configureWorkload` with CPu/memory/storage validation, a new `renameWorkload` action takes the path of least complexity. The executor calls the same Proxmox config API but only sends `{ name }`.

4. **Name validation preserved** — `validateProxmoxName()` still enforces Proxmox's naming rules (letters, digits, hyphens, dots). No relaxation of constraints.

5. **30-second client-side timeout** — Prevents the rename submit from entering a permanently stuck state if the server hangs. The `renameSubmitInFlight` flag is cleared in a `finally` block.

6. **Task UPIDs returned, not awaited** — The executor returns the UPID for the config task but does not wait on it. Task completion follows the background task tracking pattern per POLICIES.md.

7. **`/rename.svg` icon exists** — A rename icon asset already exists in `static/rename.svg`. Use it instead of `settings.svg`.

---

# Removed Sections (from former "Configure" scope)

The following sections were part of the multi-field Configure button and are no longer applicable:

- **Workload Profiles Redesign** — database-backed CPU/memory/storage presets. Removed because the configure form was replaced with rename-only.
- **Default value calculations** for CPU share %, memory MiB, storage GiB.
- **Host capacity validation** — `executeWorkloadConfigureAction` node status fetch, CPU share/memory/storage range checks.
- **Storage resize logic** — LXC `rootfs` resize, QEMU disk auto-detection, `validResizeDisks`.
- **CPU parameter distinction** — LXC `cpulimit` vs QEMU `cores` mapping.

The `executeWorkloadConfigureAction` function in `action-executors.ts` will be replaced by a simpler `executeWorkloadRenameAction`.

---

## Related Features

- **Destroy** (`feature-destroy.md`) — Same component, shared notification system
- **Deploy** (`feature-deploy.md`) — Complementary lifecycle action (create vs. modify)
- **Notifications** (`feature-notifications.md`) — Toast system consumed by this feature


