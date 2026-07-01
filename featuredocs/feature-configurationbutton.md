# Feature: Configure Button

**Owner:** `PxMxWorkloadControls.svelte`  
**Server:** `proxmox-actions.ts` → `action-executors.ts`  
**First committed:** —  
**Last reviewed:** 2026-07-01

---

## Summary

The Configure button lets a user adjust CPU share, memory allocation, storage size, and name on a running or stopped workload (VM or LXC container). It is presented as a settings-icon button in the workload controls row, opens a modal dialog with pre-filled defaults, and submits a SvelteKit form action to the server.

**Status:** The configure form is scheduled for redesign around **workload profiles** (see [Workload Profiles Redesign](#workload-profiles-redesign) below). The current behavior documented in this file remains the active implementation until the redesign ships.

---

## User Flow

1. User clicks the settings (⚙️) icon button in a workload's action toolbar.
2. A modal dialog appears titled **"Workload Configuration"** with four input fields:
   — *Name* (optional rename, pre-filled with current name)
   — *CPU share (%)* (required, derived from current CPU limit relative to host cores)
   — *Memory (MiB)* (required, derived from current memory limit)
   — *Add storage (GiB)* (optional, increments existing disk size)
3. User edits desired values and clicks **OK**.
4. Modal closes immediately (optimistic UX). A toast notification shows the server result on return.
5. On success:_show_ "Configuration updated" toast. On failure: error toast with server message.

---

## Enablement Conditions

The configure button is enabled only when **all** of the following are true:

| Condition | Source |
|-----------|--------|
| Workload is a VM (`type === 'vm'`) or container (`type === 'container'`) | `selectedWorkload?.type` |
| Workload has a valid `id` and `node` | `selectedWorkload` fields |
| Controls are not globally disabled | `controlsDisabled` prop |
| Host capacity data is available (`hostMaxCpu > 0`, `hostMaxMemory > 0`) | `hasHostCapacityData` derived |

If host capacity data is missing, the button shows the tooltip _"Host capacity is unavailable for this node"_.

---

## Default Value Calculation

When the modal opens, the form fields are seeded from the `openConfigureModal()` function:

| Field | Derivation |
|-------|------------|
| **CPU share %** | `round((currentCpulimit / hostCpuCount) × 100)`, clamped 1–75. Falls back to 25% if current value is invalid or missing. |
| **Memory (MiB)** | `floor(currentMemoryLimit / 1024²)`, clamped 16–`maxMemoryMiB`. Falls back to min(1024, maxMemoryMiB). |
| **Add storage (GiB)** | 1 (if host has available storage), else 0 (disabled). |
| **Name** | Current workload name (unchanged → no rename performed). |

**Capacity caps** (enforced both client-side via `max` attributes and server-side):
- CPU share: maximum **75% of host CPU count**
- Memory: maximum **75% of host total memory** (MiB), minimum 16 MiB
- Storage increase: maximum **host available storage** (GiB)

---

## Architecture

### Client-Side (`PxMxWorkloadControls.svelte`)

```
User clicks button
  → openConfigureModal()     — seeds form state, sets showConfigureModal = true
  [modal dialog rendered with {#if showConfigureModal}]
  → User submits form        — method="POST" action="?/configureWorkload"
  → enhanceConfigureSubmit() — SvelteKit enhance handler:
      1. Sets configureSubmitInFlight = true
      2. Closes modal immediately (showConfigureModal = false)
      3. Races update() against 30 s timeout (prevents hung state)
      4. On success  → notify.success(server message)
      5. On failure  → notify.error(server message)
      6. Finally     → configureSubmitInFlight = false
```

**State variables:**
- `showConfigureModal` — dialog visibility
- `configureSubmitInFlight` — guards against duplicate submits during flight
- `cpuSharePercent`, `memoryMiB`, `storageGiB`, `workloadName` — form field bindings

**Scroll preservation:** The enhance handler captures `window.scrollX/Y` before submit and restores it after form state update, preventing page jump on SvelteKit form navigation.

**Effect cleanup:** An `$effect` closes the modal (and the delete-confirm dialog) when `controlsDisabled` becomes `true`.

### Server-Side (`proxmox-actions.ts` → `action-executors.ts`)

**Action: `configureWorkload`**

1. **Parse form data** — `parseWorkloadSubmission()` extracts type, id, node, name.
2. **Validate fields:**
   - CPU share: required, must parse to number
   - Memory: required, must parse to number
   - Storage: optional, must be ≥ 1 GiB if provided
   - Name: optional, validated by `validateProxmoxName()` (letters, digits, hyphens, dots)
3. **Call executor** — `executeWorkloadConfigureAction()`

**Executor: `executeWorkloadConfigureAction()`**

```
1. Create client (createClient())
2. Fetch node status: GET /nodes/{node}/status
3. Read host capacity (CPU cores, memory bytes, storage bytes)
4. Validate CPU share: 1–75% of host CPU
5. Validate memory: 16 MiB – 75% of host memory
6. Validate storage: requested increase ≤ available node storage
7. Compute applied values:
   - appliedCpuLimit = (hostCpuCount × cpuSharePercent) / 100
   - appliedMemoryMiB = floor(memoryMiB)
   - shouldRename = newName differs from currentName
   - shouldResizeStorage = storageGiB > 0
```

**Workload type branching:**

| | LXC Container | QEMU VM |
|---|---|---|
| Config API | `PUT /nodes/{node}/lxc/{vmid}/config` | `PUT /nodes/{node}/qemu/{vmid}/config` |
| Body | `{ cpulimit, memory, name? }` | `{ cores, memory, name? }` |
| CPU value | `cpulimit` (float, e.g. 2.25) | `cores` (integer, rounded up) |
| Resize API | `PUT /nodes/{node}/lxc/{vmid}/resize` | `PUT /nodes/{node}/qemu/{vmid}/resize` |
| Resize disk | `rootfs` (fixed) | Auto-detected from VM config (first scsi/virtio/sata/ide disk without cloudinit) |

**Return value** (to action handler):
```ts
{
  upid?: string;           // config task UPID
  appliedCpuLimit: number;
  appliedMemoryMiB: number;
  appliedCpuCores?: number;// QEMU only
  appliedStorageGiB?: number;
  storageTaskUpid?: string;// resize task UPID
  renamed: boolean;
}
```

**Success message format** (returned to client):
```
Configuration updated for <kind> (cpu=…, memory=…, [storage=+N GiB], [renamed to "…"])
Task UPIDs returned to client for server-side event polling (not waited on in this action).
```

---

## Error Handling

| Layer | Error Type | Response |
|-------|-----------|----------|
| Client form validation | Missing CPU/memory | `fail(400)` with "CPU share is required" / "Memory is required" |
| Client form validation | Storage < 1 GiB | `fail(400)` with actual submitted value in message |
| Client form validation | Invalid Proxmox name | `fail(400)` with `validateProxmoxName()` error text |
| Server executor | Host capacity unresolvable | `throw Error` → caught by global fallback handler |
| Server executor | CPU share out of range (1–75%) | `throw Error` with value |
| Server executor | Memory out of range (16–75%) | `throw Error` with value |
| Server executor | Storage exceeds available | `throw Error` with requested vs available |
| Server executor (VM) | No resizable disk found | `throw Error("Unable to resolve a resizable VM disk")` |
| Client enhance | Server timeout (30 s) | Timeout resolves Promise.race; in-flight cleared; no toast (server response awaited longer than timeout is treated as eventual success/failure) |

---

## Key Dependencies

| Module | File | Purpose |
|--------|------|---------|
| `parseWorkloadSubmission()` | `routes/proxmox/action-validators.ts` | Extracts workload identity from FormData |
| `validateProxmoxName()` | `routes/proxmox/action-validators.ts` | Proxmox name regex validation |
| `toPositiveNumber()` / `toNonNegativeNumber()` | `routes/proxmox/helpers.ts` | Numeric coercion utilities |
| `useToast()` | `notification-store.svelte.ts` | Toast notification store |
| `ToastNotification.svelte` | `src/` | Unified toast UI component |
| `createClient()` | `routes/proxmox/` | Proxmox API client factory |
| Host capacity loading | `routes/proxmox/loadData.ts` | `hostMaxCpu`, `hostMaxMemory`, `hostMaxStorage` — fetched per node and propagated to workload objects |

---

## Design Decisions

1. **Optimistic modal close** — Modal closes on submit without waiting for server response. Follows POLICIES.md P6 (predictable UI behavior) and the "single-shot submit" pattern.

2. **Capacity caps are server-enforced** — Client-side `max` attributes on inputs are guidance only; the executor re-validates against real-time node status.

3. **Storage is an increment, not an absolute** — The "Add storage" field represents *how much to add* (e.g., `+10G`), not a target size. This avoids needing to query current disk size before the modal opens.

4. **VM disk auto-detection** — Rather than requiring the user to specify a disk identifier, the executor finds the first non-cloudinit disk (`scsi*`, `virtio*`, `sata*`, `ide*`) and resizes it.

5. **Name change is optional and separate** — Leaving the name field unchanged results in no rename operation. This allows users to tune resources without accidentally triggering a rename.

6. **CPULimit vs cores distinction** — LXC uses `cpulimit` (float, representing CPU units/time slices). QEMU uses `cores` (integer). The same percentage input must map to different Proxmox parameters per type.

7. **30-second client-side timeout** — Prevents the configure submit from entering a permanently stuck state if the server hangs. The `configureSubmitInFlight` flag is cleared in a `finally` block.

8. **Task UPIDs returned, not awaited** — The executor returns UPIDs for the config and resize tasks but does not wait on them. Task completion is detected by the periodic page refresh / server event polling (background task tracking pattern per POLICIES.md).

---

## Workload Profiles Redesign

**Status:** Design phase — not yet implemented. The current configuration form will be redesigned around workload profiles.

### Motivation

The current form presents raw numeric fields (CPU share %, memory MiB, storage GiB) that require the user to understand both resource units and the host's capacity. This is unintuitive and error-prone for non-technical users. Workload profiles replace raw numbers with named presets that encode sensible resource combinations for common use cases.

### Profile Concept

A **workload profile** is a named preset of resource allocations:

| Profile | CPU Cores | Internal Memory (RAM) | Persistent Memory (Swap/Disk) |
|---------|-----------|----------------------|-------------------------------|
| **Beginner** | 1–2 | 512 MiB – 1 GiB | 8–16 GiB |
| **Advanced** | 2–4 | 2–4 GiB | 16–32 GiB |
| **Expert** | 4–8 | 4–8 GiB | 32–64 GiB |

- **CPU Cores** — number of vCPU cores allocated to the workload
- **Internal Memory (RAM)** — volatile memory (Proxmox `memory` parameter)
- **Persistent Memory** — swap space or additional persistent storage for the workload

Name remains **outside** the profile — it is a separate field the user controls independently.

### Profile Storage

Profiles are stored in a **PostgreSQL database** and fetched at runtime. This allows:
- Admins to create, edit, and delete profiles without code changes or redeployment
- Per-environment customization (lab vs. production) without forking code
- Future extensions: per-user profile preferences, role-based visibility, etc.

**Proposed schema:**

```sql
CREATE TABLE workload_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,       -- e.g. 'beginner', 'advanced', 'expert'
  label           TEXT NOT NULL,              -- display name
  description     TEXT,
  cores           INTEGER NOT NULL CHECK (cores > 0),
  ram_mib         INTEGER NOT NULL CHECK (ram_mib >= 16),
  persistent_mib  INTEGER NOT NULL CHECK (persistent_mib >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Default seed data (Beginner / Advanced / Expert) is inserted on application startup if the table is empty.

### Profile Selection UX

1. User clicks the Configure button → modal opens
2. Modal shows a **profile selector** (radio buttons or dropdown) with Beginner / Advanced / Expert
3. Selecting a profile auto-fills CPU, RAM, and persistent memory with the preset values
4. User can **browse or tweak** any value after selection — profiles are starting points, not locked states
5. Name field exists separately from the profile section

### Form Layout (Proposed)

```
┌─────────────────────────────────────────────┐
│ Workload Configuration                      │
├─────────────────────────────────────────────┤
│ Name                                        │
│ [ ubuntu-desktop-01                     ]   │
│                                             │
│ ── Workload Profile ─────────────────────    │
│ (●) Beginner  (○) Advanced  (○) Expert      │
│                                             │
│ CPU Cores:          [ 2           ]  ← profile sets default │
│ Internal Memory:    [ 1024 MiB    ]  ← profile sets default │
│ Persistent Memory:  [ 16 GiB      ]  ← profile sets default │
│                                             │
│ ┌──────────┐  ┌──────────┐                  │
│ │   OK     │  │  Cancel   │                  │
│ └──────────┘  └──────────┘                  │
└─────────────────────────────────────────────┘
```

### Implementation Plan

#### 1. Database Schema and Seed

Create the `workload_profiles` table (see [Profile Storage](#profile-storage) above). On application startup, seed the three default profiles (Beginner / Advanced / Expert) if the table is empty. This ensures the profiles are available out-of-the-box while remaining editable post-deployment.

A TypeScript interface defines the shape for type-safe client-side usage:

```ts
export interface WorkloadProfile {
  id: string;           // UUID from database
  name: string;         // slug: 'beginner', 'advanced', 'expert'
  label: string;
  description: string;
  cores: number;
  ramMiB: number;
  persistentMemoryGiB: number;
}
```

#### 2. Modal State Changes

- Add `selectedProfile: string` state (profile `id` from database, or `''` for none selected)
- Fetch available profiles from the database on modal open (or cache in page load)
- Render profile options dynamically from the fetched list
- On profile selection, populate `cpuSharePercent`, `memoryMiB`, `storageGiB` from the profile's values
- All fields remain independently editable — changing a field after profile selection doesn't revert the profile

#### 3. Server-Side Changes

- New endpoint or SvelteKit server action to **list profiles** from PostgreSQL (e.g., `GET /api/workload-profiles` or a load function in `+page.server.ts`)
- `proxmox-actions.ts` and `action-executors.ts` retain all validation and API logic
- The executor's `executeWorkloadConfigureAction()` remains unchanged — profiles inform form defaults, Proxmox API receives the resolved numeric values
- No new Proxmox API calls needed; profiles map to existing `cpulimit`/`memory`/`resize` parameters

#### 4. Migration from Current Form

- The current fields (CPU share %, memory MiB, storage GiB) become the tinkerable fields shown under the profile selector
- Default value calculation (`openConfigureModal`) still applies as fallback when no profile is selected
- Profile selection overrides defaults; current workload values still inform the "best fit" profile suggestion

### Design Decisions (Redesign)

1. **Profiles are tinkerable** — selecting a profile sets defaults, but the user can modify any field. This avoids locking users into presets that don't match their exact needs.

2. **Name is separate from profile** — workload identity is orthogonal to resource allocation. Renaming and configuring resources are independent concerns.

3. **Persistent memory as swap/disk** — abstracts away Proxmox internals (swap vs additional storage) into a user-friendly concept: "how much persistent backing does this workload need?"

4. **Database-backed, server-fetched** — profiles are stored in PostgreSQL and fetched by the server. The server exposes them to the client; the client treats them as form defaults. This keeps profiles consistent across all connected clients and allows admin management without code changes.

5. **No profile stored on the workload** — profiles are a configuration-time aid only. Once applied, the workload's resources are what matter, not which profile was selected.

### Migration Path

- **Phase 1:** Introduce profile selector alongside existing form fields as an optional UX layer
- **Phase 2:** Deprecate raw numeric defaults in favor of profile-driven defaults
- **Phase 3:** Clean up legacy form logic, keep profiles as primary interface

---

## Related Features

- **Destroy** (`feature-destroy.md`) — Same component, shared notification system
- **Deploy** (`feature-deploy.md`) — Complementary lifecycle action (create vs. modify)
- **Notifications** (`feature-notifications.md`) — Toast system consumed by this feature

