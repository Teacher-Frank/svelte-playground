# File Upload Feature — Implementation Progress

**Created:** 2026-06-18  
**Status:** Planning phase — no code changes made yet  
**Approach:** Option 2 — Dedicated HTTP Upload Endpoint using Proxmox APIs

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
//   - file: File (binary content)
//   - path: string (target path inside VM/container, default: ~/upload/)

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
    // Parse query params
    // Create PVE client
    // For VMs: try agent/network-get-interfaces, return available=true if successful
    // For containers: check if running, return available=true
  });
}
```

### 4. Modify Terminal Page: `src/routes/proxmox/terminal/+page.svelte`
**Changes needed:**

1. **Add upload button to terminal header toolbar**
2. **Add file input element (hidden, triggered by button click)**
3. **On file selection:**
   - Read file as ArrayBuffer
   - Send via `fetch()` POST to `/proxmox/upload` with multipart form data
   - Show upload progress in terminal (write colored text to terminal output)
4. **On page load:**
   - Call `/proxmox/agent-status?vmid=...&node=...&type=...` to check availability
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
      onclick={() => fileInput?.click()}
    >
      Upload File
    </button>
    <input
      bind:this={fileInput}
      type="file"
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
   - For VMs: call `agent_file_write` with base64 content
   - For LXC: call `exec` with base64 decode command, poll for completion
   - Return JSON response with success/error status

2. **Create `server/proxmoxGuestAgentStatus.ts`** — Agent availability check
   - For VMs: try `agent/network-get-interfaces`, return success/failure
   - For LXC: check if container is running via `lxc.id(vmid).get()`, return true if status is "running"

3. **Update `server/index.ts`** — Wire up new handlers

4. **Update `+page.svelte`** — Add upload button to terminal header
   - Fetch agent status on mount
   - Handle file selection and upload via fetch()
   - Show progress/disabled state

5. **Add `busboy` dependency** to `package.json`
   - `npm install busboy` (server-side multipart parsing)

---

## Design Notes

### Upload Target Path
- Default target: `/tmp/upload/{filename}` (platform-safe, writable by most users)
- Show a notification in the terminal when upload completes:
  ```
  [Upload] myfile.txt -> /tmp/upload/myfile.txt (1.2 MB) ✓
  ```

### File Size Limits
- Maximum file size: 100 MB (enforced server-side)
- Proxmox guest agent file-write has its own limits (typically ~500 MB but varies)

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

1. **Target directory:** Should we create `~/upload/` as a default directory, or use a configurable path via env var?
2. **Directory creation:** Do we need to ensure the target directory exists before writing?
3. **Resume support:** Not needed for MVP — full file upload only.
4. **Multiple files:** MVP supports single file upload. Multiple files can be added later.
5. **LXC file-restore vs exec:** Which approach is better for LXC? Exec is simpler and more universal (works on any running container). File-restore requires storage volume access.
