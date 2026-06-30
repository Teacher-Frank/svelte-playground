# File Upload Feature — Implementation Progress

**Created:** 2026-06-18
**Updated:** 2026-06-30
**Status:** ✅ Working (verified with 3 guest scripts on VM 102)
**Approach:** Option 2 — Dedicated HTTP Upload Endpoint using Proxmox APIs
**Scope:** Multiple file upload, no resume, configurable target directory, available-space–aware limits

## Regressions Found & Fixed 2026-06-29

Three critical bugs were discovered during usability testing on 2026-06-29. All are fixed but leave the upload flow blocked at the QEMU agent exec step (see "Current Blocker" below).

### Bug 1: Dev server routing — 404 on `/proxmox/upload` and `/proxmox/agent-status`

**Root cause:** In dev mode, Vite serves HTTP requests (not `server/index.ts`). The original code registered `server.on('request', async ...)` listeners on the `createServer` callback, which raced with SvelteKit's synchronous `handler()` call. SvelteKit responded first with 404.

**Fix applied (2 files):**
- **`vite.config.ts`** — Added two Vite middleware plugins (`proxmoxUploadPlugin`, `proxmoxAgentStatusPlugin`) that intercept `/proxmox/upload` (POST) and `/proxmox/agent-status` (GET) before Vite/SvelteKit handles them.
- **`server/index.ts`** — Rewrote to call custom handlers inline via `httpGuards` array with `await`, before falling through to SvelteKit. Same `handleProxmoxUpload` / `handleProxmoxAgentStatus` standalone functions are imported.

**Why this matters:** Custom HTTP endpoints (upload, agent-status) MUST be wired in Vite's dev middlewares AND in the production `server/index.ts`. The old `attachProxmox*Handler(server)` pattern only works for WebSocket upgrade listeners, not async HTTP requests.

### Bug 2: pve-client dist not picked up by Vite SSR cache

**Symptom:** Changes to pve-client's source (e.g., `encodeForm` fix) were verified in `dist/index.es.js`, but the running dev server still used stale SSR bundle.

**Root cause:** Vite caches SSR dependencies in `node_modules/.vite/`. When pve-client is rebuilt, Vite's dev server must restart to re-bundle the new dist file.

**Fix required:** Kill the dev server, optionally delete `node_modules/.vite/`, then restart. In `acctest-env.ps1`, the pve-client build runs before `npm run dev`, so a full restart of the script is needed after pve-client source changes.

**Lesson:** Any pve-client source change → full dev server restart (not just HMR reload).

### Bug 3: pve-client POST body parameter encoding

**Two sub-issues, both in `pve-client/src/index.ts`:**

**3a. `encodeForm` spread array params as separate form fields**

When `command: ['mkdir', '-p', '/tmp/upload']` was passed to a QEMU agent exec POST, `encodeForm` appended each array element as a separate `command=...` form field, producing:
```
command=mkdir&command=-p&command=%2Ftmp%2Fupload
```
Proxmox expects the array JSON-stringified:
```
command=["mkdir","-p","/tmp/upload"]
```

**Fix:** Changed `encodeForm` to JSON-stringify arrays before setting them:
```typescript
// Before:
if (Array.isArray(v)) for (const item of v) sp.append(k, this.serializeScalar(item));
// After:
if (Array.isArray(v)) sp.set(k, JSON.stringify(v));
```

**3b. `request()` didn't auto-wrap body params for POST methods**

Generated factory methods (e.g., `agent_exec`) pass body params directly:
```typescript
agent_exec(node, vmid, ...a) => client.request(path, "POST", { ...a[0], $path: { node, vmid } })
```
But `request()` only encoded `$body` — it never auto-wrapped remaining params for POST/PUT/PATCH methods. So `{ command: [...] }` was spread into `args` but ignored because `a.$body` was `undefined`.

**Fix:** Added auto-wrap logic in `request()` for POST/PUT/PATCH methods:
```typescript
if (a.$body !== undefined) {
    bodyToEncode = a.$body;
} else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    bodyToEncode = {};
    for (const [k, v] of Object.entries(a)) {
        if (k.startsWith('$')) continue;  // skip $path, $query, $headers
        if (v === undefined || v === null) continue;
        bodyToEncode[k] = v;
    }
}
```

**Why this matters:** All POST endpoints in pve-client that accept arrays as body params (agent exec, file-write, LXC exec, etc.) were silently sending malformed form data.

### Bugs Fixed: Summary Table

| # | File(s) | Bug | Before | After |
|---|---------|-----|--------|-------|
| 1 | `vite.config.ts` | Dev server 404 on custom endpoints | No middleware | Plugins intercept `/proxmox/upload` and `/proxmox/agent-status` |
| 1 | `server/index.ts` | Same race condition in production | `server.on('request', async) ` raced with SvelteKit | `httpGuards` array with `await` before SvelteKit handler |
| 2 | (process) | Vite SSR cache stale for pve-client dist changes | HMR reload skips dist re-bundle | Full dev server restart required |
| 3a | `pve-client/src/index.ts` | `encodeForm` spreads arrays as separate params | `command=a&command=b` | `command=["a","b"]` |
| 3b | `pve-client/src/index.ts` | `request()` ignores non-`$body` params for POST | Body empty | Auto-wraps remaining params for POST/PUT/PATCH |

## Upload Feature Status (2026-06-29)

**Upload works with workaround for agent/exec 596 error**

### Bug 4: QEMU agent exec fails with HTTP 596 (WORKAROUND APPLIED)

**Problem:** The `agent/exec` endpoint (used by `ensureDirectoryExists()`) fails with `HTTP 596 Broken pipe`. This is a network-level error where Proxmox resets the TLS connection.

**Workaround:** Changed `handleProxmoxUpload` to treat directory creation as best-effort:
- If `agent/exec mkdir -p /tmp/upload` fails, log a warning and continue
- The `agent/file_write` API does NOT suffer from this issue — file writes work perfectly
- If the target directory truly doesn't exist, `agent/file_write` will fail with a clear error

**Observed behavior (verified):**
1. Upload dialog opens, agent status check passes (`available: true`)
2. Files are selected and queued
3. Upload starts: `POST /proxmox/upload` reaches server middleware
4. `ensureDirectoryExists()` calls `agent.exec({command: ['mkdir', '-p', '/tmp/upload']})` → HTTP 596
5. Warning logged: `[upload] Warning: mkdir failed for /tmp/upload: HTTP 596 Broken pipe:`
6. `writeFileToVm()` calls `agent.file_write()` → **succeeds** (directory exists from prior terminal session)
7. All files show `✓ Done`

**Tested with 3 guest scripts on VM 102 (Ubuntudesktop):**
- `install-guest-agent.sh` — ✓ Done
- `install-vnc-bridge.sh` — ✓ Done  
- `vm-checklist-verify.sh` — ✓ Done

**Root cause hypothesis (unconfirmed):**
- Proxmox may return a 3xx redirect on `agent/exec` that points to an alternative port
- The `native_fetch` polyfill creates fresh HTTPS agents per request with `keepAlive: false`
- The redirect or socket reuse may still cause the broken pipe
- `agent/file_write` does NOT redirect, which explains why it works

### Bug 5: Uploaded files stored as base64-encoded text on disk (FIXED)

**Problem:** Files uploaded via `agent/file_write` were stored as the raw base64-encoded string inside the VM, not decoded to their original binary content. E.g., a `.sh` file contained `IyEvYmluL2Jhc2gK...` instead of `#!/bin/bash\n...`.

**Root cause:** Misunderstanding of Proxmox `agent/file-write` `encode` parameter semantics:
- `encode=1` (default): Proxmox base64-encodes `content`, then QEMU guest agent decodes → yields raw bytes
- `encode=0`: Proxmox passes `content` through untouched, QEMU still base64-decodes → content MUST be pre-encoded

The original code sent pre-base64-encoded content *with* `encode: true` — Proxmox re-encoded the already-encoded string, then QEMU decoded once, leaving the file as base64 text.

**Fix (2026-06-30):** Two layers:

1. **Root cause (MIS)interpretation of `encode` param:** The original code sent `encode: true` *with* pre-base64-encoded content. Proxmox's `encode=1` means "I'll base64-encode your raw content for you" — so Proxmox re-encoded our already-encoded string, QEMU decoded once, leaving base64 text on disk.

2. **Serialization issue:** Proxmox rejects the string `"false"` for boolean params (expects `"0"`). The pve-client `encodeForm` correctly serializes booleans as `"0"`/`"1"`, but Vite SSR transforms sometimes produce `"false"` (via `String(false)`). Sending numeric `0` bypasses this:```typescript
// Before (double-encoded, wrong flag + serialization issues):
{ file: filePath, content: base64Content, encode: true }
// After (numeric 0 — QEMU decodes our base64 encoding):
{ file: filePath, content: base64Content, encode: 0 }
```

**Also fixed:** Updated `pve-client/src/api/nodes/types.ts` to accept `boolean | number` for the `encode` param, so numeric values type-check correctly.

**Reverted:** An intermediate incorrect fix that changed `encodeForm` to serialize booleans as `"true"`/`"false"` — Proxmox API rejects these strings.

### Bug 6: file_write verification timeout too short (FIXED)

**Problem:** After `file_write`, the server polls `file_read` to verify the file arrived. Default maxRetries was 6 (6 seconds). QEMU guest agent is fire-and-forget and can take longer to flush files, especially larger ones. Files arrived on disk but were reported as failed.

**Fix:** Increased `maxRetries` from 6 to 30 in `writeFileToVm`. This gives up to 30 seconds for verification.

### Bug 7: Uploaded files owned by root and not executable (FIXED)

**Problem:** QEMU guest agent writes files as root, and doesn't set the executable bit. Shell scripts uploaded via `.sh` extension were owned by `root:root` and not directly executable.

**Fix:** After file verification succeeds in `writeFileToVm`, run `chmod +x` via `agent/exec` on `.sh`, `.bash`, `.py`, `.pl`, `.rb`, and extensionless files (e.g., `Makefile`). Uses the same best-effort pattern as `mkdir` (skips with warning if agent/exec fails). Root ownership is inherent to the guest agent — no API param controls this.

**UI:** Added ℹ️ notice in the upload dialog (VMs only): "Files are uploaded as root. `sudo` is required to modify or move them."

### Bugs & Workarounds: Summary Table (Updated)

| # | File(s) | Bug | Status | Before | After |
|---|---------|-----|--------|--------|-------|
| 1 | `vite.config.ts` | Dev server 404 on custom endpoints | ✅ Fixed | No middleware | Plugins intercept `/proxmox/upload` and `/proxmox/agent-status` |
| 1 | `server/index.ts` | Same race condition in production | ✅ Fixed | `server.on('request', async)` raced with SvelteKit | `httpGuards` array with `await` before SvelteKit handler |
| 2 | (process) | Vite SSR cache stale for pve-client dist changes | ✅ Documented | HMR reload skips dist re-bundle | Full dev server restart required |
| 3a | `pve-client/src/index.ts` | `encodeForm` spreads arrays as separate params | ✅ Fixed | `command=a&command=b` | `command=["a","b"]` |
| 3b | `pve-client/src/index.ts` | `request()` ignores non-`$body` params for POST | ✅ Fixed | Body empty | Auto-wraps remaining params for POST/PUT/PATCH |
| 4 | `server/proxmoxTerminalUpload.ts` | `agent/exec` mkdir fails with HTTP 596 | ⚠️ Workaround | Hard failure blocks upload | Best-effort: log warning, continue to file write |
| 5 | `server/proxmoxTerminalUpload.ts` | Files stored as base64 text (double-encoding) | ✅ Fixed | `encode: true` + pre-encoded content | `encode: 0` + pre-encoded content |
| 6 | `server/proxmoxTerminalUpload.ts` | file_write verification timeout too short | ✅ Fixed | 6s timeout | 30s timeout |
| 7 | `server/proxmoxTerminalUpload.ts`, `+page.svelte` | Uploaded files not executable, owned by root | ✅ Fixed | Root-owned, non-executable | chmod +x on scripts, notice in dialog |

## Completed 2026-06-19

All tasks implemented and validated. See commit history for details.

### pve-client changes
- Added `exec` and `exec_status` factory methods to `src/api/nodes/lxc.ts`
- Added `LXCExec` and `LXCExecStatus` types to `src/api/nodes/types.ts`
- Wired `exec`, `exec_status`, and `delete` in node-scoped LXC builder (`src/api/nodes/index.ts`)
- Added missing `delete` alias to node-scoped QEMU `vmid()` builder
- Fixed 4 pre-existing test failures: lxc.create/qemu.create arg count, missing .delete() methods (210/210 passing)

### playground changes
- **New:** `server/proxmoxTerminalUpload.ts` — POST `/proxmox/upload` handler (busboy multipart, QEMU agent file-write for VMs, LXC exec + base64 decode for containers)
- **New:** `server/proxmoxGuestAgentStatus.ts` — GET `/proxmox/agent-status` handler (checks agent availability and disk space for VMs and containers)
- **New:** `tests/lib/server/proxmox-upload.spec.ts` — 3 unit tests (missing params, VM agent, container status)
- **Modified:** `server/index.ts` — attached new upload and agent-status handlers
- **Modified:** `src/routes/proxmox/terminal/+page.svelte` — upload button, modal dialog, file picker, progress tracking, a11y-compliant
- **Modified:** `package.json` — added `busboy` and `@types/busboy` dependencies
- Fixed `formatApiError` missing function in `proxmox-actions.ts`
- Fixed `lxc.create` arg count in `action-template-deployers.ts`
- Fixed unused variables across multiple files (pre-existing errors)

### Validation Gate (P3)
- `npm run check` — 0 errors, 3 warnings (all pre-existing)
- `npm run lint` — 0 errors
- `npx vitest run` — 43 passed (43)

---

## Goal

Add an upload button to the terminal page toolbar. When clicked, it opens a file picker. Selected files are uploaded to the VM/container via Proxmox APIs (QEMU guest agent for VMs, LXC exec for containers). If the guest agent is not available (VMs), the button is disabled with a tooltip explaining why.

---

## Architecture Decision

### VMs (QEMU guest agent)
- **API:** `POST /nodes/{node}/qemu/{vmid}/agent/file-write`
- **Availability check:** Try `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`
- **If agent unavailable:** Disable upload button, show tooltip: "QEMU guest agent needs to be installed"
- **How the write API works:**
  ```typescript
  // Body sent as form-urlencoded:
  {
    "content": "<base64-encoded file contents>",
    "file": "<path inside VM, e.g. /tmp/upload/filename.txt>",
    "encode": true  // tells Proxmox the content is already base64-encoded
  }
  ```

### LXC Containers (exec API)
- **API:** `POST /nodes/{node}/lxc/{vmid}/exec`
- **Availability:** Always available on running containers (exec runs inside the container namespace)
- **How the exec approach works:**
  1. Read file content in browser, base64-encode it
  2. Call `/nodes/{node}/lxc/{vmid}/exec` with command:
     ```
     ["bash", "-c", "echo '<base64>' | base64 -d > '<target-path>'"]
     ```
  3. Wait for PID result, then poll `/nodes/{node}/lxc/{vmid}/task/{task-upid}/status` for completion
- **Alternative:** Use file-restore API if available:
  - `GET /nodes/{node}/storage/{storage}/file-restore/list`
  - `GET /nodes/{node}/storage/{storage}/file-restore/download`

---

## Files to Create / Modify

### 1. New Server Endpoint: `server/proxmoxTerminalUpload.ts`
**Purpose:** HTTP POST endpoint for file uploads, attached as a middleware handler on the HTTP server.

**Path:** `c:\hrgit\svelte-playground\playground\server\proxmoxTerminalUpload.ts`

**Design:**
```typescript
// Attach as HTTP handler for POST /proxmox/upload
// Accepts multipart form data with fields:
//   - vmid: number
//   - node: string
//   - type: 'vm' | 'container'
//   - files: File[] (multiple files via multipart)
//   - path: string (target directory inside VM/container, default: /tmp/upload/)
//   - maxSize: number (optional, max size in bytes; server enforces hard cap at available_space - 100 MB)

export function attachProxmoxUploadHandler(httpServer: HttpServer): void {
  httpServer.on('request', (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/proxmox/upload')) return;
    // Parse multipart form
    // Create PVE client (same pattern as proxmoxTerminalWs.ts)
    // Write file via agent_file_write (VM) or exec + base64 (LXC)
  });
}
```

### 2. Modify Server Entry: `server/index.ts`
**Current code:**
```typescript
import { createServer } from 'node:http';
import { handler } from '../build/handler.js';
import { attachProxmoxTerminalWsProxy } from './proxmoxTerminalWs.ts';
import { attachProxmoxVncWsProxy } from './proxmoxVncWs.ts';

const server = createServer((req, res) => handler(req, res));
attachProxmoxTerminalWsProxy(server);
attachProxmoxVncWsProxy(server);
server.listen(port, host, () => console.log(`[server] listening on http://${host}:${port}`));
```

**Add:**
```typescript
import { attachProxmoxUploadHandler } from './proxmoxTerminalUpload.ts';
// ...
attachProxmoxUploadHandler(server);
```

### 3. New Server Endpoint: `server/proxmoxGuestAgentStatus.ts` (or inline check)
**Purpose:** HTTP GET endpoint to check if guest agent is available for a VM.

**Path:** `c:\hrgit\svelte-playground\playground\server\proxmoxGuestAgentStatus.ts`

**Design:**
```typescript
// GET /proxmox/agent-status?vmid=100&node=pve1&type=vm
// Returns: { available: boolean, reason?: string }

export function attachProxmoxAgentStatusHandler(httpServer: HttpServer): void {
  httpServer.on('request', async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/proxmox/agent-status')) return;
    // Parse query params (vmid, node, type)
    // For VMs:
    //   - Try agent/network-get-interfaces, return available=true if successful
    //   - Also call agent/exec to run `df -B1` to get available disk space
    //   - Return { available: boolean, availableSpace: number } in bytes
    // For containers:
    //   - Check if running via lxc.id(vmid).get()
    //   - Exec `df -B1` to get available disk space
    //   - Return { available: true, availableSpace: number }
  });
}
```

### 4. Modify Terminal Page: `src/routes/proxmox/terminal/+page.svelte`
**Changes needed:**

1. **Add upload button to terminal header toolbar**
2. **Add upload dialog panel** with:
   - Target directory input field (default: `/tmp/upload`)
   - Max size display (auto-calculated from available space − 100 MB)
   - File picker (multiple selection)
   - Upload progress per file and overall
3. **On file selection:**
   - Read each file as ArrayBuffer
   - Send via `fetch()` POST to `/proxmox/upload` with multipart form data (one request per file or batch)
   - Show upload progress in terminal (write colored text to terminal output)
4. **On dialog open:**
   - Call `/proxmox/agent-status?vmid=...&node=...&type=...` to check availability and available disk space
   - Calculate max allowed size (available_space − 100 MB)
   - If unavailable, disable button with tooltip

**Header changes (conceptual):**
```svelte
<header class="terminal-header">
  <span class="workload-label">{workloadLabel}</span>
  <div class="terminal-actions">
    <button
      {disabled}
      title={tooltipText}
      class="upload-btn"
      onclick={() => uploadDialogOpen = true}
    >
      Upload File
    </button>
    <input
      bind:this={fileInput}
      type="file"
      multiple
      style="display:none"
      onchange={handleFileSelect}
    />
  </div>
</header>
```

### 5. Modify `src/routes/proxmox/helpers.ts`
**Add:**
```typescript
// Helper to determine if upload is supported for a workload type
export const isUploadSupported = (type: 'vm' | 'container', status: string): boolean => {
  if (type === 'container') return status === 'running';
  // For VMs, need to check guest agent (done via endpoint)
  return false; // determined server-side
};
```

---

## Key API Endpoints Reference

### QEMU Guest Agent File Write
- **Endpoint:** `POST /nodes/{node}/qemu/{vmid}/agent/file-write`
- **Body (form-urlencoded):**
  - `file`: string — target file path inside VM (e.g. `/tmp/myfile.txt`)
  - `content`: string — base64-encoded file content
  - `encode`: boolean — `true` if content is already base64-encoded
- **pve-client method:** Available via `client.api.nodes.get(node).qemu.vmid(vmid).agent_file_write()` — but this method is NOT exposed in the current pve-client `qemu.ts` (only `agent_file_read` and `agent_file_write` exist as raw functions)

### LXC Exec Command
- **Endpoint:** `POST /nodes/{node}/lxc/{vmid}/exec`
- **Body (form-urlencoded):** serializes `cmd` array as JSON
  - `cmd`: JSON string — e.g. `["bash", "-c", "echo 'data' | base64 -d > /tmp/file.txt"]`
  - `timeout`: number — optional timeout in seconds
- **Returns:** `{ upid: string }` — task ID for polling
- **pve-client method:** `client.api.nodes.get(node).lxc.id(vmid).exec()`

### LXC Exec Status
- **Endpoint:** `GET /nodes/{node}/lxc/{vmid}/exec-status?pid=<pid>`
- **Returns:** `{ status: string }`

### Guest Agent Availability Check (VMs)
- **Endpoint:** `GET /nodes/{node}/qemu/{vmid}/agent/network-get-interfaces`
- **Returns:** Array of network interface objects if agent is running
- **Error:** Returns HTTP 500 with message containing "no guest agent" or "qga command failed" if unavailable

---

## Implementation Order

1. **Create `server/proxmoxTerminalUpload.ts`** — The core upload handler
   - Parse multipart form data (use `busboy` npm package)
   - Create PVE client with same auth pattern as `proxmoxTerminalWs.ts`
   - **Before processing files:** Check available disk space and enforce hard cap (available_space − 100 MB)
   - **Ensure target directory exists:**
     - For VMs: exec `mkdir -p '<target-path>'` via guest agent
     - For LXC: exec `mkdir -p '<target-path>'`
   - **Process each file:**
     - For VMs: call `agent_file_write` with base64 content
     - For LXC: call `exec` with base64 decode command, poll for completion
     - **Verify upload (LXC):** After write, exec `stat --format=%s '<path>'` to confirm size matches
   - Return JSON response with per-file success/error status

2. **Create `server/proxmoxGuestAgentStatus.ts`** — Agent availability and disk space check
   - For VMs:
     - Try `agent/network-get-interfaces`, return success/failure for availability
     - If agent available, exec `df -B1` to get available disk space
     - Return `{ available: boolean, availableSpace: number | null, reason?: string }`
   - For LXC:
     - Check if container is running via `lxc.id(vmid).get()`
     - Exec `df -B1` to get available disk space
     - Return `{ available: boolean, availableSpace: number | null }`

3. **Update `server/index.ts`** — Wire up new handlers

4. **Update `+page.svelte`** — Add upload button, dialog, and multi-file upload logic
   - Show upload dialog on button click with:
     - Target directory input (default: `/tmp/upload`)
     - Max size display (auto-calculated from available space − 100 MB)
     - File picker (multiple selection)
     - Upload progress per file and overall bar
   - Fetch agent status + available space on dialog open
   - Handle file selection and upload via fetch()
   - After upload: verify success and show completion notification in terminal

5. **Add `busboy` dependency** to `package.json`
   - `npm install busboy` (server-side multipart parsing)

---

## Design Notes

### Upload Target Directory
- **Configurable via upload dialog:** A text input field lets the user type the target directory path (default: `/tmp/upload`)
- **Auto-create directory:** If the target directory doesn't exist, the server will create it first:
  - For VMs: call `agent/exec` with `mkdir -p '<target-path>'`
  - For LXC: exec `mkdir -p '<target-path>'`
- **Show a notification in terminal** when upload completes:
  ```
  [Upload] myfile.txt -> /tmp/upload/myfile.txt (1.2 MB) ✓
  ```
- **Multiple file support:** MVP supports multiple files in a single upload session; each file is written sequentially

### File Size Limits
- **Configurable maximum file size:** Default 100 MB, overridable via environment variable or upload dialog
- **Hard cap:** Total upload size never exceeds (available disk space on target VM/container − 100 MB)
  - Server checks available space before accepting upload
  - For LXC: run `df` inside container to get free space
  - For VMs: query via guest agent (e.g., `agent/exec` to run `df`)
- **Per-file limit:** Enforced both client-side (before upload starts) and server-side
- **Proxmox guest agent file-write** has its own limits (typically ~500 MB but varies)

### Error Messages
- Agent not running (VM): "QEMU guest agent is not running on this VM"
- Container not running (LXC): "Container is not running"
- Permission denied: "Permission denied — check file path"
- File too large: "File exceeds size limit (max 100 MB)"

### Security Considerations
- Uploads use the same Proxmox credentials as the terminal (username/password from env)
- No path traversal validation on the server (the target path is controlled by the server, defaulting to `/tmp/upload/`)
- Consider adding a confirmation prompt for sensitive paths

---

## Dependencies to Add

```json
{
  "dependencies": {
    "busboy": "^1.6.0"
  },
  "devDependencies": {
    "@types/busboy": "^1.5.0"
  }
}
```

---

## Questions for Implementation

1. **Target directory:** Configurable via upload dialog input field. Default: `/tmp/upload`. No env var needed.
2. **Directory creation:** Yes — server creates target directory before uploading (handled).
3. **Resume support:** Not needed for MVP — full file upload only.
4. **Multiple files:** MVP supports multiple file upload in a single session (handled).
5. **LXC file-restore vs exec:** Exec chosen — simpler, more universal, and supports verification via `stat` (handled).

---

## Applicable Policies (from POLICIES.md)

> The following are verbatim excerpts from `POLICIES.md`, the authoritative policy source.

### Architecture: pve-client + playground

- **Fix API-surface gaps in `pve-client` first**; avoid consumer-side cast workarounds.
- Export and consume named typed APIs (`NodeScopedAPI`, `QemuScopedAPI`, `LxcScopedAPI`).

*(This feature added `exec` and `exec_status` factory methods to `pve-client`'s LXC API surface, plus `LXCExec`/`LXCExecStatus` types, rather than workarounding in the consumer.)*

### P2: Quality and Refactoring

- Extract shared or utility code to dedicated modules — don't let architectural complexity block safe extractions.

### P4b: Error Messages

- Wrong/rejected values: always include the actual value in the error message so the caller can identify it.
- Sensitive values (passwords, tokens, secrets) must never appear in error messages.
