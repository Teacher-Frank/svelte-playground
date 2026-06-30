# File Upload Feature — Implementation Progress

**Created:** 2026-06-18  
**Updated:** 2026-07-02  
**Status:** ✅ Working (verified on VM 102 Ubuntudesktop)  
**Approach:** Option 2 — Dedicated HTTP Upload Endpoint using Proxmox APIs  
**Scope:** Multiple file upload, no resume, configurable target directory, available-space–aware limits

---

## Architecture

### Upload Flow
1. Click button → dialog opens → calls `GET /proxmox/agent-status` for agent availability
2. Select files → client accounts for remaining space in upload limit
3. Click Upload → sends `POST /proxmox/upload`
4. **For VMs:** `agent/file_write` with base64 content + `encode: 0` → verify with `agent/file_read` (30s timeout) → `chmod +x` scripts
5. **For containers:** `agent/exec` with base64 decode → poll exec status

### File Size Limits
- **Hard cap:** Total upload size never exceeds (available disk space − 100 MB)
- **Max files:** 10 per upload batch

### Security Considerations
- Uploads use same credentials as terminal (PVE_USERNAME/PVE_PASSWORD from env)
- Target path controlled by server, defaults to `/tmp/upload/`
- Root ownership: QEMU guest agent writes as root — note displayed in dialog

---

## API Endpoints

### `agent/file-write`
- `POST /nodes/{node}/qemu/{vmid}/agent/file-write`
- Body: `{ file, content: base64String, encode: 0 }`
- `encode=1` (default): Proxmox base64-encodes content before passing to QEMU
- `encode=0`: Proxmox passes content as-is (you must pre-encode)
- Returns: `{"data": null}` (fire-and-forget)

### `agent/file-read` (verification)
- `GET /nodes/{node}/qemu/{vmid}/agent/file-read?file=...`
- Returns: `{ content: "base64", bytes-read: N }`

### `agent/exec` (chmod, directory creation)
- `POST /nodes/{node}/qemu/{vmid}/agent/exec`
- Body: `{ command: ["chmod", "+x", "/tmp/file.sh"] }`
- Known issue: HTTP 596 on `mkdir -p` — works for `chmod +x`
- Returns: `upid` for polling

---

## Bug Log

### Bug 1: Dev server 404 on `/proxmox/upload` and `/proxmox/agent-status` ✅
**Cause:** `server.on('request')` raced with SvelteKit `handler()` in dev mode.  
**Fix:** `vite.config.ts` → Vite middleware plugins; `server/index.ts` → `httpGuards` array with `await`.

### Bug 2: pve-client dist not picked up by Vite SSR cache ✅
**Cause:** Vite caches SSR deps in `node_modules/.vite/`.  
**Fix:** Full dev server restart required after pve-client source changes (HMR reload skips dist).

### Bug 3: pve-client POST body encoding ✅
**3a.** `encodeForm` spread arrays as separate POST fields (`command=a&command=b`). Fixed to JSON-stringify: `command=["a","b"]`.  
**3b.** `request()` ignored non-`$body` params for POST. Fixed to auto-collect non-`$` params.

### Bug 4: QEMU agent/exec 596 Broken pipe ⚠️
**Cause:** `agent/exec` returns 3xx redirect causing TLS reset. `agent/file_write` unaffected.  
**Workaround:** Directory creation is best-effort — log warning, continue to file write.

### Bug 5: Double-encoding (files stored as base64 text) ✅
**Root cause:** `encode=1` means "Proxmox encodes for you". Sent `true` with pre-encoded content → double-encoding.  
**Serialization layer:** Proxmox rejects `"false"` string (expects `"0"`/`"1"`). Vite SSR serialized booleans as `"false"`.  
**Fix:** `encode: 0` (numeric literal). Updated `types.ts` to accept `boolean | number`.  
> Lesson captured in POLICIES.md: "Proxmox API Debugging".

### Bug 6: Verification timeout too short ✅
**Cause:** 6s timeout. QEMU is fire-and-forget, files arrived after.  
**Fix:** `maxRetries` 6 → 30.

### Bug 7: Root-owned, non-executable files ✅
**Cause:** QEMU guest agent writes as root, doesn't set executable bit.  
**Server fix:** After verification, `chmod +x` via `agent/exec` on `.sh`, `.bash`, `.py`, `.pl`, `.rb`, extensionless files. Best-effort.  
**UI fix:** ℹ️ notice in dialog (VMs): "Files are uploaded as root. `sudo` is required..."

### Bug 8: `type` ReferenceError (2026-07-02) ✅
**Cause:** Dialog rendered `{#if type === 'vm'}` but `type` isn't scoped — should be `data.type`.  
**Fix:** `{#if data.type === 'vm'}`.

---

## Bugs Summary

| # | File | Bug | Status | Fix |
|---|------|-----|--------|-----|
| 1 | `vite.config.ts` | Dev server 404 | ✅ | Middleware plugins |
| 1 | `server/index.ts` | SvelteKit async race | ✅ | httpGuards array |
| 2 | (process) | Vite SSR stale dist | ✅ | Full restart required |
| 3a | `pve-client/src` | Array params spread | ✅ | JSON-stringify |
| 3b | `pve-client/src` | POST body auto-wrapping | ✅ | Auto-collect |
| 4 | `upload.ts` | agent/exec 596 | ⚠️ | Best-effort + warn |
| 5 | `upload.ts`, `types.ts` | Double-encoding | ✅ | `encode: 0` numeric |
| 6 | `upload.ts` | Verification timeout | ✅ | 6s → 30s |
| 7 | `upload.ts`, `+page.svelte` | Root-owned, non-executable | ✅ | chmod +x, notice |
| 8 | `+page.svelte` | `type` ReferenceError | ✅ | `data.type` |

---

## Completed Changes (2026-06-19)

### pve-client
- Added `exec`, `exec_status` factory methods to LXC API surface
- Added `LXCExec`, `LXCExecStatus` types
- Wired `exec`, `exec_status`, `delete` in node-scoped LXC builder
- Added missing `delete` alias to node-scoped QEMU `vmid()` builder
- Fixed 4 pre-existing test failures (210/210 passing)
- Updated `encode` param on `agent/file-write` to accept `boolean | number`

### playground
- **New:** `server/proxmoxTerminalUpload.ts` — busboy multipart, QEMU agent file-write (VMs), LXC exec+base64 (containers)
- **New:** `server/proxmoxGuestAgentStatus.ts` — GET agent availability + disk space
- **New:** `tests/lib/server/proxmox-upload.spec.ts` — 3 unit tests
- **Modified:** `server/index.ts` — attached upload + agent-status handlers
- **Modified:** `+page.svelte` — upload button, dialog, file picker, progress, a11y
- **Modified:** `package.json` — added `busboy` + `@types/busboy`

---

## Dev Tooling
- **`acctest-env.ps1`** — Sets env vars, builds pve-client, starts dev server
- **`test-upload.ps1`** — Standalone Node script exercising `agent/file-write` with real VM

## Validation (P3)
- `npm run check` — ✅ 0 errors
- `npm run lint` — ✅ 0 errors
- `npx vitest run` — ✅ all tests pass (both repos)
