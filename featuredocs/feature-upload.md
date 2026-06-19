# File Upload Feature — Implementation Progress

**Created:** 2026-06-18  
**Updated:** 2026-06-19  
**Status:** ✅ Complete — merged and passing validation gate (check + lint + tests)  
**Approach:** Option 2 — Dedicated HTTP Upload Endpoint using Proxmox APIs  
**Scope:** Multiple file upload, no resume, configurable target directory, available-space–aware limits

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

## pve-client Limitations

- **No native multipart support:** The pve-client `request()` method only handles form-urlencoded JSON or raw string/Blob bodies. For the upload endpoint, we'll call the Proxmox API directly using the session cookie from the client rather than using pve-client's typed methods.
- **agent_file_write exists** in the pve-client but needs verification it's callable — the code generates it dynamically via path patterns.
- **LXC exec exists** in pve-client via `client.api.nodes.get(node).lxc.id(vmid).exec()`

---

## Questions for Implementation

1. **Target directory:** Configurable via upload dialog input field. Default: `/tmp/upload`. No env var needed.
2. **Directory creation:** Yes — server creates target directory before uploading (handled).
3. **Resume support:** Not needed for MVP — full file upload only.
4. **Multiple files:** MVP supports multiple file upload in a single session (handled).
5. **LXC file-restore vs exec:** Exec chosen — simpler, more universal, and supports verification via `stat` (handled).
