# Terminal Feature — Current State

**Date:** 2026-06-25
**Scope:** End-to-end web terminal for Proxmox VMs and LXC containers, spanning `pve-client` (library) and `svelte-playground` (application).

## Architecture Overview

The terminal subsystem is a multi-layer protocol chain:

```
Browser keyboard → xterm.js → Browser WebSocket → Playground server → pve-client bridge → TerminalSession → Proxmox WS → Guest PTY → Shell
```

```
┌─────────────────────────────────────────────────────────┐
│  pve-client (library)                                   │
│  Terminal.ts  →  TerminalSession, TerminalRenderer       │
│  terminal-utils.ts  →  pure parsing, repair, normalize   │
│  terminal-bridge.ts  →  bridgeTerminalSessionToSocket     │
│  LocalPromptNudge.ts →  CLI-only prompt nudge             │
└────────────────────────┬────────────────────────────────┘
                         │ Client.helpers.terminal(vmid)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  svelte-playground (application)                        │
│  Client: +page.svelte (xterm.js + WebSocket + resize)    │
│  Server: proxmoxTerminalWs.ts (WS upgrade → auth → Terminal.open → manual bridge)    │
│  Upload: proxmoxTerminalUpload.ts (POST /proxmox/upload) │
└─────────────────────────────────────────────────────────┘
```

---

## 1. pve-client — Library Layer

### 1a. Core Terminal Module (`src/helpers/Terminal.ts`)

~520 lines. The heart of terminal functionality.

| Export | Kind | Purpose |
|--------|------|---------|
| `Terminal` | Class | High-level helper. Creates auth tickets via API, opens terminal sessions. Methods: `createTicket()`, `getConnectionInfo()`, `open()`, `get ticket()` |
| `TerminalSession` | Class | EventEmitter managing WebSocket to Proxmox termproxy. Events: `ready`, `data`, `close`, `resize`, `error`, `state`, `reconnect`. Methods: `start()`, `write()`, `writeRaw()`, `close()`, `pipe()` |
| `TerminalRenderer` | Class | Feeds data through `terminal.js` for VT100/xterm escape parsing. Events: `render`, `error`. Methods: `write()`, `resize()`, `getState()`, `clear()` |
| `TerminalState` | Enum | `START(1)`, `CONNECTING(2)`, `CONNECTED(3)`, `DISCONNECTING(4)`, `DISCONNECTED(5)`, `RECONNECTING(6)` |

**Key types:** `TerminalTicket`, `TerminalConnectionInfo`, `TerminalOpenOptions`, `TerminalBrowserMessage`, `TerminalBrowserSocket`, `TerminalBridgeOptions`, `TerminalPipe`, `TerminalRendererState`.

**Protocol wiring:**
- `Terminal` calls `client.request()` on `/nodes/{node}/{type}/{vmid}/termproxy` to obtain a ticket
- `Terminal.open()` internally creates a `TerminalSession` with a socket factory
- `TerminalSession` handles the Proxmox termproxy protocol: auth handshake (`user:ticket\n`), keepalive (`2`), stdin frames (`0:byteLength:data`), resize frames (`1:cols:rows:`), OK response (`OK`)
- Built-in reconnection with configurable intervals and max attempts
- Auto-subscribes to SIGHUP/SIGWINCH for TTYWatcher-based terminal resize detection

### 1b. Terminal Utils (`src/helpers/terminal-utils.ts`)

~290 lines. Pure functions for wire-data parsing, conversion, and repair.

| Function | Purpose |
|----------|---------|
| `rawToBuffer(data)` | Convert raw `ws` data to Node Buffer |
| `browserMessageToUtf8(msg)` | Convert TerminalBrowserMessage to UTF-8 string |
| `browserMessageToBuffer(msg)` | Convert TerminalBrowserMessage to Buffer |
| `normalizeSs3CursorKeys(payload, mode?)` | SS3 → CSI normalization (`ESC O A` → `ESC [ A`); supports "all" or "vertical-only" |
| `simplifyModifiedCursorKeys(payload)` | Collapse modified CSI (`ESC[1;2D` → `ESC[D`) |
| `hasNavigationSequence(payload)` | Detect navigation ESC sequences in payload |
| `isSingleNavigationSequence(payload)` | Check if payload is exactly one navigation sequence |
| `repairOrphanNavigationFragments(payload, recentNavigation)` | Reconstruct missing-ESC fragments (e.g. bare `D` → `ESC[D`) |
| `splitIncompleteAnsiTail(payload)` | Split trailing incomplete ANSI prefix for reassembly |
| `parseBrowserFrame(text, resizePrefix)` | Parse browser text into `{ kind: "resize" \| "input", ... }`; supports JSON and legacy `R:cols:rows` |

All functions are pure and take/return Buffers. Repair functions activate only within a time-windowed `recentNavigation` flag to avoid corrupting normal typed text.

### 1c. Terminal Bridge (`src/helpers/terminal-bridge.ts`)

~370 lines. Extracted from `Terminal.ts` to stay under the 750-line ESLint threshold.

| Export | Signature | Purpose |
|--------|-----------|---------|
| `bridgeTerminalSessionToSocket()` | `(session, browserSocket, options?) => void` | Full bidirectional bridge with all compatibility/normalization features |
| `openTerminalBridge()` | `(terminal, browserSocket, openOptions?, bridgeOptions?) => Promise<TerminalSession>` | Convenience: opens Terminal session and bridges it, preserving pre-ready browser input |

**Bridge features (all via `TerminalBridgeOptions`):**
- Pre-ready input buffering (queues browser messages until `ready`)
- Binary stdin forwarding with control-sequence fidelity
- Text frame parsing (JSON structured frames and legacy `R:` prefix for resize)
- ANSI tail reassembly (split ESC bytes recombined across WebSocket frames)
- SS3 → CSI normalization (optional application cursor mode)
- Modified key simplification
- Orphan fragment repair (compatibility mode)
- Navigation repeat coalescing
- Prompt nudge (one-time `\r` after readiness when no output yet)
- Frame tracing (ordered trace with sequence numbers)

### 1d. Local Prompt Nudge (`src/helpers/LocalPromptNudge.ts`)

Standalone helper for CLI/local terminal piping (not browser). Sends a delayed carriage return after session `ready` if no stdin was sent. Used by `examples/terminal-local.ts`.

### 1e. Client Integration

The `Client` class exposes terminals via:
```ts
client.helpers.terminal(vmid) → new Terminal(vmid, this)
```

All terminal classes, functions, and types are re-exported from `pve-client/src/index.ts`.

### 1f. Examples

- **`examples/terminal-local.ts`** — Local CLI terminal, pipes session to local TTY (stdin/stdout). Raw mode, resize via `stdout.on('resize')`, Ctrl-] to exit. Uses `attachLocalPromptNudge`.
- **`examples/terminal-local.ts`** also demonstrates `docker-compose.yml` for local testing.

### 1g. Tests (6 files, ~31 tests)

| File | Tests | Coverage |
|------|-------|----------|
| `tests/unit/terminal-auth.test.ts` | 3 | Auth header (API token), Cookie header (session), missing auth fast-fail |
| `tests/unit/terminal-bridge.test.ts` | 9 | Socket error safety, browser-close before ready, prompt nudge, `openTerminalBridge` preserve-input, resize (3 inc. JSON) |
| `tests/unit/terminal-normalization.test.ts` | 11 | Binary arrow-key preservation, SS3 repeat preservation, normalize SS3, simplify modified keys, coalesce split ANSI, coalesce nav repeats, drop text stdin |
| `tests/unit/terminal-coalesce-navigation.test.ts` | 6 | No-repair missing-escape (default), repair orphans (compat mode), forward mixed bursts, no-repair batched, no-repair malformed, no-remap uppercase |
| `tests/unit/terminal-nudge-local.test.ts` | 1 | Standalone local prompt nudge with fake timers |
| `tests/unit/terminalRenderer.test.ts` | 1 | Max buffer size overflow protection |

**Test infrastructure:** Custom Vite pre-transform plugin (`/// #include ./shared-mock-setup.ts`) to inline a shared mocked `ws` module (workaround for Vitest's `vi.hoisted` ESM constraint). Documented in `reports/Terminal-Test-Refactoring.md`.

---

## 2. svelte-playground — Application Layer

### 2a. Server WebSocket Handler (`playground/server/proxmoxTerminalWs.ts`)

~160 lines. Intercepts HTTP upgrades on `/proxmox/terminal/ws`.

**Flow:**
1. Lazy-imports `pve-client` `Client` and `ws` `WebSocketServer`
2. Validates `vmid` query param (positive integer)
3. Reads env vars: `PVE_BASE_URL`, `PVE_USERNAME`, `PVE_PASSWORD`, `PVE_REALM`, `PVE_INSECURE_TLS`
4. Creates `Client`, calls `client.login()` (username/password only — API tokens explicitly unsupported for terminal sessions)
5. Calls `client.helpers.terminal(vmid).open({ reconnect: true })`
6. Wires manual event handlers:
   - `session.on('data')` → `browserWs.send(chunk)` (binary forwarding)
   - `session.on('error')` → sends red ANSI error text to browser
   - `session.on('close')` → closes browser WS
   - `browserWs.on('message')` → parses JSON resize frames OR forwards as `session.write(text)`
   - `browserWs.on('close')` / `browserWs.on('error')` → `session.close()`

**⚠️ Divergence:** Does NOT use `bridgeTerminalSessionToSocket` or `openTerminalBridge` from pve-client. Implements a simplified manual bridge with its own `tryParseResizeFrame` and `toUtf8Text` helpers. This means all pve-client bridge features (ANSI tail reassembly, SS3 normalization, orphan repair, nav coalescing, prompt nudge, structured trace) are **inactive** in this path.

### 2b. File Upload Handler (`playground/server/proxmoxTerminalUpload.ts`)

POST `/proxmox/upload` — multipart file upload to VM/container via Proxmox APIs.
- **VMs:** QEMU `agent_file_write`
- **Containers:** LXC `exec` + base64 decode

Mounted in `playground/server/index.ts` alongside terminal, VNC, and agent-status handlers.

### 2c. Client Terminal Page (`playground/src/routes/proxmox/terminal/+page.svelte`)

~400 lines. Svelte page rendering xterm.js terminal with WebSocket connection.

**Key architecture:**
- Dynamic imports of `@xterm/xterm` and `@xterm/addon-fit` in `onMount` (SSR-safe)
- xterm.js config: `cursorBlink: true`, `scrollback: 5000`, `scrollOnUserInput: true`
- WebSocket to `/proxmox/terminal/ws?vmid=...&node=...&type=...` with `binaryType = 'arraybuffer'`
- Binary stdin: `term.onData()` → `TextEncoder.encode()` → `ws.send()`
- Binary output: `ws.onmessage` → `term.write(new Uint8Array(...))` for ArrayBuffer

**Resize convergence system (most complex subsystem):**
1. `FitAddon.fit()` syncs xterm size to container
2. `maybeApplyFallbackGeometry()` — derives cols/rows from container pixels + measured cell metrics as fallback when fit lags
3. `sendResizeFrame(force?)` — sends JSON `{ type: "resize", cols, rows }`; deduplicates unless `force`
4. `scheduleInitialResizeResends()` — after WS open, force-sends resize up to 8 times at 250ms intervals
5. `scheduleConvergenceResync()` — rechecks geometry at [50, 150, 300, 600, 1000, 1600, 2400]ms delays on open/visibility change
6. `ResizeObserver` on container + `window.resize` + `window.focus` + `document.visibilitychange` all trigger resync
7. `requestAnimationFrame` debouncing on size sync

**Startup behavior:** On `ws.onopen`: clears `lastSentSize`, resets attempts, forces resize, starts convergence retries, sends initial `\n` to nudge shell prompt. On first 3 frames of `ws.onmessage`: triggers geometry recheck.

**Upload UI:** Upload dialog with target directory selector, multi-file picker (max 10), agent status check via `/proxmox/agent-status`, available space enforcement (max = available - 100MB), per-file progress tracking.

### 2d. Server Load (`playground/src/routes/proxmox/terminal/+page.server.ts`)

SvelteKit page server load — validates URL params (`vmid` positive integer, `node` non-empty, `type` is `vm` | `container`), passes data to page.

### 2e. Server Entry Point (`playground/server/index.ts`)

Node HTTP server running SvelteKit handler + all WebSocket/HTTP proxy routes. Attaches (in order): terminal WS proxy, VNC WS proxy, upload handler, agent status handler.

---

## 3. Known Issues & Resolved History

Three significant issues were discovered and resolved during initial build (documented in `svelte-playground/About_terminals_in_browsers.md`):

1. **Held navigation key corruption** — Repeated arrow keys sent as ANSI repeat sequences were being corrupted. Fixed via orphan fragment repair in `terminal-utils.ts`.
2. **Vi fullscreen mode breakage** — Application cursor mode (SS3) sequences weren't being handled. Fixed via SS3 → CSI normalization.
3. **Shell prompt delay** — First shell prompt not visible until user types. Fixed via prompt nudge (delayed `\r` after `ready`).

**Current recommendation:** bash is the robust default shell for web terminals.

---

## 4. Open Questions & Technical Debt

| Item | Severity | Description |
|------|----------|-------------|
| Manual bridge in playground | Medium | `proxmoxTerminalWs.ts` implements its own simplified bridge instead of using `bridgeTerminalSessionToSocket` from pve-client. All bridge compatibility features (ANSI reassembly, SS3 normalization, orphan repair, nav coalescing, prompt nudge) are **inactive** in the playground server path. Consider migrating to `openTerminalBridge`. |
| Text vs binary stdin | Low | Playground server sends text frames to `session.write()` rather than binary to `session.writeRaw()`. This converts all input to UTF-8 strings first, potentially losing control sequences. |
| API token auth unsupported | Medium | Terminal sessions require username/password login; API tokens are explicitly unsupported in the playground server. The pve-client library supports both via auth header vs cookie. |
| Resize convergence complexity | Low | The client-side resize system is the most complex subsystem (8 retry attempts, 7 convergence deadlines, fallback geometry, private xterm accessor). Works well but is fragile. |

---

## 5. File Map

| Path | Layer | Lines | Purpose |
|------|-------|-------|---------|
| `pve-client/src/helpers/Terminal.ts` | Library | ~520 | Terminal, TerminalSession, TerminalRenderer classes |
| `pve-client/src/helpers/terminal-utils.ts` | Library | ~290 | Pure parsing, conversion, repair functions |
| `pve-client/src/helpers/terminal-bridge.ts` | Library | ~370 | WebSocket-to-session bridging with compatibility features |
| `pve-client/src/helpers/LocalPromptNudge.ts` | Library | ~ | CLI-only prompt nudge helper |
| `pve-client/src/types/terminal.js.d.ts` | Library | ~ | TypeScript declarations for `terminal.js` |
| `pve-client/examples/terminal-local.ts` | Example | ~ | Local CLI terminal demo |
| `playground/server/proxmoxTerminalWs.ts` | App server | ~160 | WebSocket upgrade handler, manual bridge |
| `playground/server/proxmoxTerminalUpload.ts` | App server | ~ | File upload handler (POST /proxmox/upload) |
| `playground/src/routes/proxmox/terminal/+page.svelte` | App client | ~400 | xterm.js terminal page with resize convergence |
| `playground/src/routes/proxmox/terminal/+page.server.ts` | App client | ~ | URL param validation |
| `playground/server/index.ts` | App server | ~ | HTTP server entry, route attachment |
