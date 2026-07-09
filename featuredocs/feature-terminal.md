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

The heart of terminal functionality.

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

Pure functions for wire-data parsing, conversion, and repair.

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

Extracted from `Terminal.ts` to stay under the 750-line ESLint threshold.

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

Intercepts HTTP upgrades on `/proxmox/terminal/ws`.

**Flow:**
1. Lazy-imports `pve-client` `Client`
2. Validates `vmid` query param (positive integer)
3. Reads env vars: `PVE_BASE_URL`, `PVE_USERNAME`, `PVE_PASSWORD`, `PVE_REALM`, `PVE_INSECURE_TLS`
4. Creates `Client`, calls `client.login()` (username/password only — API tokens explicitly unsupported for terminal sessions)
5. Proactively checks terminal ticket via `terminal.createTicket()` to catch fatal provisioning errors (serial not configured, VM not found, etc.) before wiring the bridge
6. Calls `openTerminalBridge(terminal, browserSocket, ...)` — the canonical bridge from pve-client

**Bridge wiring:** Uses `openTerminalBridge` from pve-client with `TerminalBrowserSocket` adapter. This activates all bridge features:
- Pre-ready input buffering (queues keystrokes until Proxmox session is ready)
- ANSI tail reassembly (handles ESC bytes split across WebSocket frames)
- SS3 → CSI normalization
- Orphan fragment repair
- Navigation repeat coalescing
- Prompt nudge (sends `\\r` if no output arrives within 400ms)
- Proper binary stdin forwarding via `writeRaw`
- Error logging on browser socket close

**Additional safeguards:**
- Fatal Proxmox error detection (`isFatalProxmoxError`) closes immediately with helpful messages for provisioning issues
- Browser socket error handler logs and gracefully closes on TLS failures, malformed frames, etc.
- Finite reconnect limit (3 attempts) prevents infinite loops on fatal errors

### 2b. File Upload Handler (`playground/server/proxmoxTerminalUpload.ts`)

POST `/proxmox/upload` — multipart file upload to VM/container via Proxmox APIs.
- **VMs:** QEMU `agent_file_write`
- **Containers:** LXC `exec` + base64 decode

Mounted in `playground/server/index.ts` alongside terminal, VNC, and agent-status handlers.

### 2c. Client Terminal Page (`playground/src/routes/proxmox/terminal/+page.svelte`)

Svelte page rendering xterm.js terminal with WebSocket connection.

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

## 3. Resolved Issue History

### 3a. Issue Summary

Three significant issues were discovered and resolved during initial build:

| Issue | Description | Status |
|-------|-------------|--------|
| 1. Held navigation key corruption | Repeated arrow keys sent as ANSI repeat sequences were being corrupted | Fixed (accepted) |
| 2. Vi fullscreen mode breakage | Application cursor mode (SS3) sequences weren't being handled; cursor jumps to middle | Fixed |
| 3. Shell prompt delay | First shell prompt not visible until user types | Fixed (observed) |

**Current operational recommendation:** use `bash` as the default guest shell. Do not treat `pwsh` as the default supported interactive shell for held-navigation stress behavior yet — pwsh still shows corruption under long-held navigation in the same conditions where bash is clean.

### 3b. Issue 1 — Held Navigation Key Corruption (Fixed, Accepted)

**What was observed:**
- Prompt responsiveness was worse than expected
- Held Left key produced corruption like `DDDDDDDD[DDDDD[DD[D[DD`
- Corruption is structured and escape-sequence shaped, not random
- Single-key navigation often worked; held-key repeats failed after a few seconds

**Investigation findings:**
- Even after browser-side deterministic CSI navigation and repeat batching, long held Left still produced visible corruption in pwsh/PSReadLine
- Removing `PSReadLine` did not eliminate corruption — later check still produced `"[D[DDD[D"`
- Running `pwsh -NoProfile` still produced corruption like `D[DD[DDDDD[DDD[DDDDDD`
- The same held-Left test in `bash` showed **no corruption after 20 seconds** — strongest evidence the remaining problem is PowerShell-host-specific
- Basic `sh` produced literal `^[[C` sequences (consistent with a shell lacking the same interactive line-editing as bash)
- Profile-based compatibility logic was removed in favor of one stable raw-leaning path + bash recommendation

**Resolution:** Issue 1 is considered fixed for this project scope by decision, with bash as the operational default shell.

### 3c. Issue 2 — Cursor Jumps / Vi Not Fullscreen (Fixed)

**What was observed:**
- Cursor jumped to middle of screen
- `vi` did not use the full screen
- Initial PTY size stuck at `20x80` until manual browser resize

**What was fixed:**
- Browser-side forced `scrollToBottom()` calls on output/input/resize were removed — full-screen TUIs like `vi` can now control viewport without client-side scroll overrides
- Startup resize convergence now force-sends initial and retry resize frames
- Under bash, `stty size` and vi dimensions now converge correctly on open
- Issue 2 had two sub-issues: incorrect initial screen size (fixed) and pwsh cursor hop toward mid-screen (fixed)

### 3d. Issue 3 — Prompt Delay (Fixed, Observed)

**What was observed:**
- Shell appeared unresponsive on open — prompt not visible until user typed

**Resolution:**
- Enabling prompt nudge (one-time delayed `\r`) restored prompt appearance
- Prompt/open behavior has been stable since; issue considered fixed unless it reappears

---

## 4. Lessons Learned from Terminal Development

### 4a. Main Lesson

> A browser terminal is not just "xterm in a page". It is a multi-stage protocol path:
> `keyboard -> browser event model -> xterm/browser terminal -> browser websocket -> app bridge -> proxmox websocket -> guest pty -> shell line editor`
>
> Any stage can preserve, rewrite, split, delay, or misinterpret control sequences.

### 4b. Key Technical Learnings

1. **Control-sequence problems were structured, not random** — Visible fragments like `D`, `[D`, `OD`, `[3~`, `;1;2D` are recognizable terminal navigation fragments with missing leading `ESC` or mismatched sequence family. This pointed to protocol fragmentation, mode mismatch, or line-editor timeout — not a classic buffer overflow.

2. **CSI and SS3 are both standard sequence families** — CSI (`ESC [`) and SS3 (`ESC O`) are standard terminal control sequence forms inherited from VT/ANSI conventions. Both matter for cursor keys (e.g., CSI Left: `ESC [ D`, SS3 Left: `ESC O D`).

3. **The guest shell and its line editor matter a lot** — bash (readline), zsh (ZLE), pwsh (PSReadLine), and fish each behave differently. pwsh in Linux containers appeared especially sensitive to repeated navigation input and cursor-mode mismatches.

4. **Long held-key corruption was a separate sub-problem from single-key behavior** — Pointed to repeat-driven frame fragmentation, late loss of `ESC`, line editor timeout on partial escape streams, or interleaving with cursor-position response traffic.

5. **Browser-side interception is cleaner than endless server-side repair** — Moving plain navigation-key handling earlier in the chain (intercepting in +page.svelte) avoids relying on xterm's cursor-mode output for the most problematic repeat cases.

### 4c. What Worked

1. **Prompt nudge re-enabled** — Restored prompt visibility after open
2. **Profile system** — Controlled way to compare raw vs compatibility behavior without code edits; made iterative testing practical
3. **Better trace labeling and richer bridge tracing** — Confirmed failures were structured sequence failures, not generic corruption
4. **Modified cursor-key simplification** — Helped with `ESC[1;2D` → `ESC[D` collapse for Shift+Arrow scenarios
5. **Split escape-tail coalescing** — Helped for fragmented escape sequences across WebSocket frames
6. **Browser-side deterministic navigation sequences** — Cleanest architectural direction for compatibility profiles; moves decision earlier in the chain
7. **Browser-side batching of intercepted navigation keys** — Reduced writes for long held keys
8. **Removing `PSReadLine` as discriminating check** — Confirmed corruption persists without it; problem is deeper than PSReadLine alone
9. **Testing in `bash` vs `pwsh`** — Confirmed bash is clean, pwsh is host-specific; justified the bash-default recommendation

### 4d. What Did Not Work

1. **Assuming problem was only Shift+Arrow or modified keys** — Too narrow; held plain navigation keys were the broader problem
2. **Treating Home/End as isolated problems** — Corruption affects multiple navigation-key families
3. **Relying on a single global SS3/CSI rule** — Not robust enough; some guests leaked `OD` or `[D`
4. **Server-side orphan-fragment repair as the only strategy** — Showed diminishing returns as a primary strategy
5. **Small coalescing-window tuning by itself** — Changed symptom timing but didn't remove root behavior
6. **Browser-side deterministic CSI + repeat batching as complete answer** — Still failed under long held Left in pwsh
7. **Binary-vs-text transport framing as complete answer** — Changed symptoms but neither mode alone solved the full problem
8. **Assuming classic buffer overflow** — Evidence showed patterned, terminal-sequence-specific corruption, not random noise

### 4e. Why Browser Terminals Are Hard to Make Universal

The target environment is LXC containers across many Linux distributions, with user-chosen shells. The terminal must tolerate variation across:

- Distros
- Terminfo definitions
- Shells and line editors
- Full-screen programs
- Guest cursor-mode behavior

There is no single transform that is perfect for every guest. The practical approach is:

1. Keep a raw path available
2. Keep runtime behavior simple and predictable by default
3. Keep trace logging available so failures are diagnosable

### 4f. Current Runtime Policy

Runtime policy is implemented in `playground/server/proxmoxTerminalWs.ts` via `openTerminalBridge` bridge options.

Current policy:
1. Prompt nudge enabled (one-time `\r` after readiness)
2. Compatibility transforms explicitly disabled:
   - `enableInputRepairCompatibility: false` — orphan fragment repair off
   - `normalizeSs3CursorKeys: false` — SS3 → CSI normalization off
   - `coalesceNavigationRepeats: false` — navigation repeat coalescing off

**Why disabled:** These transforms were implemented during initial debugging before pwsh was identified as the root cause of corruption. With `bash` as the operational default shell, the transforms are unnecessary — bash handles standard CSI sequences cleanly. Leaving them off avoids unintended input mutation and keeps the protocol chain predictable.

### 4g. Recommended Engineering Stance Going Forward

1. Treat the browser terminal as a protocol stack, not a widget
2. Prefer targeted compatibility profiles over one global rewrite path
3. Add fixes at the earliest stable layer when possible
4. Keep raw mode available for guests that already behave correctly
5. Test against multiple shells and line editors, especially pwsh + PSReadLine
6. Avoid broad repairs that can mutate ordinary user text

---

## 5. Open Questions & Technical Debt

| Item | Severity | Description |
|------|----------|-------------|
| Manual bridge in playground | Medium | `proxmoxTerminalWs.ts` implements its own simplified bridge instead of using `bridgeTerminalSessionToSocket` from pve-client. All bridge compatibility features (ANSI reassembly, SS3 normalization, orphan repair, nav coalescing, prompt nudge) are **inactive** in the playground server path. Consider migrating to `openTerminalBridge`. |
| Text vs binary stdin | Low | Playground server sends text frames to `session.write()` rather than binary to `session.writeRaw()`. This converts all input to UTF-8 strings first, potentially losing control sequences. |
| API token auth unsupported | Medium | Terminal sessions require username/password login; API tokens are explicitly unsupported in the playground server. The pve-client library supports both via auth header vs cookie. |
| Resize convergence complexity | Low | The client-side resize system is the most complex subsystem (8 retry attempts, 7 convergence deadlines, fallback geometry, private xterm accessor). Works well but is fragile. |

### Up Next

See section 5.1 below (`## 5.1 Requirement: Multiple Concurrent Terminals per VM`) for the upcoming multi-serial-port feature.

---

## 5.1 Requirement: Multiple Concurrent Terminals per VM

**Status:** Proposed
**Date:** 2026-07-09

### Problem
Each Proxmox serial/port proxy (`termproxy`) supports only one active connection at a time. A VM with only `serial0` can therefore host only a single browser terminal session. Users cannot maintain parallel shell workflows (e.g., monitoring logs in one terminal while working in another) without using VNC or external SSH.

### Requirement
Support **up to 4 concurrent terminal sessions per QEMU VM**, each connected to a distinct serial port (`serial0` through `serial3`).

### API Surface
Proxmox's `POST /nodes/{node}/qemu/{vmid}/termproxy` endpoint accepts an optional `serial` body parameter:

```ts
$body: { serial?: "serial0" | "serial1" | "serial2" | "serial3" }
```

When omitted, Proxmox defaults to `serial0`. Passing a specific port connects to that serial port's console.

Each serial port is **independent and lock-free** — 4 configured serial ports = 4 simultaneous terminal sessions.

### Changes Required

#### pve-client (library)

**`Terminal` class** — add optional `serial` parameter to constructor/config:

```ts
// Current
new Terminal(vmid, client)  // always serial0 (default)

// New
new Terminal(vmid, client, { serial: "serial1" })  // explicit port
```

- `createTicket()` passes `$body: { serial }` when `serial` is provided
- `TerminalOpenOptions` gains optional `serial?: "serial0" | "serial1" | "serial2" | "serial3"` field

**`TerminalSession`** — no changes needed; already handles the socket/protocol agnostic to port selection.

**`terminal-bridge.ts`** — no changes needed; bridge operates on sessions, not ticket creation.

#### svelte-playground (application)

**`proxmoxTerminalWs.ts`** — accept `serial` query param, pass to terminal helper:

```ts
// Current: /proxmox/terminal/ws?vmid=1--??--?vmid=104&node=compute1-dev&type=vm
// New:    /proxmox/terminal/ws?vmid=104&node=compute1-dev&type=vm&serial=serial1
```

**`+page.server.ts`** — validate optional `serial` param (`serial0`–`serial3`, QEMU only)

**`+page.svelte`** — update terminal label to show which serial port is active (e.g., "Terminal 1", "Terminal 2")

**VM list page** — when a VM already has terminal tabs open, enable button/tab to open additional terminals (up to 4 for VMs, 1 for containers).

### LXC Containers (out of scope initially)

LXC termproxy API has no `serial` parameter — single TTY only. Multiple concurrent sessions not possible through termproxy. If needed, SSH is the alternative path.

### Most Common Scenario

Based on user feedback, the **most frequent case is 2 terminals** (e.g., one for active work, one for monitoring). 4-terminal max provides headroom for power users but should not require UI complexity proportional to 4.

### Prerequisites

- VM must have `serial0` through `serialN` configured as `socket` in Proxmox (e.g., `serial0: socket`, `serial1: socket`)
- Deploy code already adds all 4 serial ports during provisioning (`action-template-deployers.ts`)
- Manually added serial ports on existing VMs also work, as long as they're configured as `socket` type

---

## 6. File Map

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

---

## Applicable Policies (from POLICIES.md)

> The following are verbatim excerpts from `POLICIES.md`, the authoritative policy source.

### Architecture: pve-client + playground

- **Fix API-surface gaps in `pve-client` first**; avoid consumer-side cast workarounds.
- Server-side terminal/WebSocket responsibility lives in `pve-client`; playground wiring stays thin.
- ESM TS in `pve-client`: use explicit `.js` extensions for relative imports.

*(Terminal is the canonical example of this pattern: `Terminal`, `TerminalSession`, `TerminalRenderer`, bridge, utils, and prompt nudge all live in `pve-client`. Playground wiring is thin WS upgrade → auth → `Terminal.open` → `bridgeTerminalSessionToSocket`.)*

### P2: Quality and Refactoring

- Extract shared or utility code to dedicated modules — don't let architectural complexity block safe extractions. Prefer `*-utils.ts` files over leaving duplication.

*(Terminal was refactored from a single 750+ line file into `Terminal.ts` (core), `terminal-utils.ts` (pure helpers), `terminal-bridge.ts` (bridge), and `LocalPromptNudge.ts` (CLI).)*

### P2b: Consistent Patterns

- When a problem has a confirmed unified solution, apply it everywhere it's needed.
- Never leave ad-hoc or legacy patterns alongside the canonical one — consolidate them.
