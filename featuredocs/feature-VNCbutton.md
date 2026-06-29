# VNC Button Feature — Implementation Notes

**Date:** 2026-06-25
**Scope:** End-to-end in-browser GUI (VNC) access for Proxmox VMs and LXC containers, spanning `pve-client` (library) and `svelte-playground` (application).

## Architecture Overview

The VNC subsystem is a browser-first GUI console that connects through a server-side WebSocket bridge:

```
Browser (noVNC RFB) → Browser WebSocket → Playground server bridge → Upstream (Proxmox vncproxy OR websockify bridge) → Guest VNC server → GUI display
```

```
┌─────────────────────────────────────────────────────────┐
│  pve-client (library)                                   │
│  Display.ts  →  Display, DisplaySession, DisplayTicket   │
│  helpers/display.ts  →  client.helpers.terminal(display)  │
└────────────────────────┬────────────────────────────────┘
                         │ Client.helpers.display(vmid)
                         ▼
┌─────────────────────────────────────────────────────────┐
│  svelte-playground (application)                        │
│  UI: PxMxWorkloadControls.svelte (VNC button + eligibility) │
│  Page: +page.svelte (noVNC RFB client + credential UI)    │
│  Load: +page.server.ts (mode resolution + ticket issuance) │
│  Bridge: proxmoxVncWs.ts (WS upgrade → security → relay)  │
└─────────────────────────────────────────────────────────┘
```

## Decision: Two connection modes

| Mode | When used | How it works |
|------|-----------|--------------|
| **Native Proxmox VNC** | Default; always available for running VMs and containers | Server calls `client.helpers.display().getConnectionInfo()` to get a Proxmox `vncproxy` ticket, returns WebSocket URL pointing to the Proxmox `vncwebsocket` endpoint |
| **Bridge mode** | When `LXC_VNC_BRIDGE_WS_URL` or `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4` is configured | Server resolves the guest's IPv4 address, constructs a websockify URL (e.g., `ws://<guest-ip>:8001`), returns that as the upstream target |

**Why bridge mode exists:** Desktop images (Ubuntu Desktop, Windows, etc.) often run their own VNC server (TigerVNC, x11vnc, etc.) on port `:5901` with websockify on `:8001`. Proxmox's `vncproxy` only sees the primary display the hypervisor exposes — which for many desktop images is a blank console. Bridge mode lets operators route through an operator-managed websockify endpoint inside the guest.

---

## 1. pve-client — Library Layer

### 1a. Display Module (`pve-client/src/helpers/Display.ts`)

~220 lines. Provides VNC session management for both QEMU VMs and LXC containers.

| Export | Kind | Purpose |
|--------|------|---------|
| `Display` | Class | High-level display helper. Resolves running VM from cluster resources, creates vncproxy tickets. Methods: `createTicket()`, `getConnectionInfo()`, `open()`, `get ticket()` |
| `DisplaySession` | Class | EventEmitter wrapping a WebSocket to the Proxmox `vncwebsocket` endpoint. Events: `ready`, `data`, `close`, `error`. Methods: `write()`, `close()`, `pipe()` |
| `DisplayTicket` | Type | `{ cert, port, ticket, upid, user, password? }` — short-lived ticket from Proxmox vncproxy |
| `DisplayConnectionInfo` | Type | `{ vmid, node, type, ticket, websocketUrl }` — full connection metadata |
| `DisplayPipe` | Type | Bidirectional pipe interface for wiring sessions to browser-like transports |
| `DisplayOpenOptions` | Type | `{ rejectUnauthorized?, pipeTo? }` — options for `open()` |

**Protocol wiring:**
- `Display(vmid, client)` constructor stores the VM ID and client reference
- `getRunningVm()` queries `/cluster/resources?type=vm` and finds the authoritative running guest — rejects stopped/missing VMs
- `createTicket()` POSTs to `/nodes/{node}/{type}/{vmid}/vncproxy` with `websocket: 1` — Proxmox returns a short-lived ticket with port and cert
- `getConnectionInfo()` composes the WebSocket URL from the ticket: `/nodes/{node}/{type}/{vmid}/vncwebsocket?port=...&vncticket=...`, converts HTTP(S) to WS(S)
- `open()` creates a `DisplaySession` with proper auth headers (Cookie for login sessions, Authorization for API token sessions)
- `DisplaySession.pipe()` wires bidirectional flow between the session and a `DisplayPipe` target

### 1b. Client Integration

`client.helpers.display(vmid)` returns a `Display` instance. This is consumed by the VNC page server load to obtain connection info.

---

## 2. svelte-playground — Application Layer

### 2a. VNC Button (`src/PxMxWorkloadControls.svelte`)

The VNC button sits in the workload controls toolbar alongside Terminal, Start, Stop, Restart, Configure, and Template.

**Eligibility logic (`vncEnabled`):**

```typescript
const vncEnabled = $derived(
  !controlsDisabled &&
  supportsGuiAccess &&
  hasResolvedWorkloadIp &&
  selectedWorkload?.status === 'running' &&
  selectedWorkload?.id != null &&
  selectedWorkload?.node != null
);
```

All conditions must be true:

| Condition | Source | Meaning |
|-----------|--------|---------|
| `!controlsDisabled` | props + status | Workload is not in "deploying" state and controls are not UI-disabled |
| `supportsGuiAccess` | workload type | VM (`type === 'vm'`) always supported; containers (`type === 'container'`) only if `containerGuiEnabled` prop is true |
| `hasResolvedWorkloadIp` | workload data | A resolved, non-empty `primaryIp` must exist — bridge mode needs an IP, and even native mode is more useful with one |
| `status === 'running'` | workload status | Guest must be running |
| `id != null && node != null` | workload data | Concrete workload must be selected |

**Contextual tooltips (`vncTooltip`):**

The tooltip changes based on why the button is disabled:

| Workload state | Tooltip text |
|----------------|--------------|
| Container without `containerGuiEnabled` | "GUI is not available for containers without an LXC VNC bridge" |
| Container without resolved IP | "Waiting for container IPv4 address before enabling GUI (VNC)" |
| VM without resolved IP | "Waiting for VM IPv4 address before enabling GUI (VNC)" |
| Fully enabled | "Open GUI (VNC)" |

**HREF construction:**

When enabled, the button opens `/proxmox/vnc` in a new tab with query params:

```
/proxmox/vnc?vmid=<id>&node=<node>&type=<vm|container>[&name=<name>][&ip=<ip>]
```

The `ip` parameter is included when `primaryIp` is available, allowing the server load to skip IP resolution.

### 2b. Server Load (`src/routes/proxmox/vnc/+page.server.ts`)

~230 lines. Resolves the upstream WebSocket URL and prepares credentials.

**Flow:**

1. **Validate URL params** — `vmid` (positive integer), `node` (non-empty), `type` (`vm` | `container`), optional `name` and `ip`
2. **Bridge mode check** — if `LXC_VNC_BRIDGE_WS_URL` or `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4` is configured:
   a. Resolve guest IPv4 (from `?ip` param, LXC `/interfaces` endpoint, or QEMU guest agent `network-get-interfaces`)
   b. If template mode (`LXC_VNC_BRIDGE_WS_URL`): substitute `{node}`, `{vmid}`, `{ip}/{ipv4}` placeholders
   c. If derived mode (`LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true`): construct `ws://<ipv4>:<port><path>` from env vars
   d. Return bridge URL with empty credentials (bridge auth is handled on the guest)
3. **Native mode fallback** — when bridge mode is not configured or fails:
   a. Create Proxmox client, call `client.helpers.display(vmid).getConnectionInfo()`
   b. Extract `vncPassword` from ticket (`info.ticket.password ?? info.ticket.ticket`)
   c. Return native WebSocket URL + ticket credentials

**IP resolution (bridge mode):**

| Source | VM path | Container path |
|--------|---------|----------------|
| `?ip=<known>` parameter | Used directly if valid IPv4 | Used directly if valid IPv4 |
| API fallback | `client.request('/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces')` — scans for first non-loopback/non-link-local IPv4 | `client.api.nodes.get(node).lxc.id(vmid).interfaces()` — extracts primary IPv4 from `ip-addresses` or `inet` field |

### 2c. WebSocket Bridge (`server/proxmoxVncWs.ts`)

~290 lines. WebSocket HTTP upgrade handler on `/proxmox/vnc/ws`.

**Security model:**

Three upstream types are allowed (all validated before any connection):

| Type | Validation |
|------|-----------|
| **Proxmox native** | Upstream host matches `PVE_BASE_URL`, path matches `^/api2/json/nodes/[^/]+/(qemu\|lxc)/\d+/vncwebsocket$`, URL includes `vncticket` query param |
| **Bridge allowlist** | Upstream host is in `LXC_VNC_BRIDGE_ALLOWED_HOSTS` or is the host of `LXC_VNC_BRIDGE_WS_URL` |
| **Derived IPv4** | `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4=true` AND upstream is a valid IPv4 address AND port matches `LXC_VNC_BRIDGE_WS_PORT` (default `8001`) |

**Auth handling:**

- For **Proxmox native** upstreams: creates or uses existing Proxmox client, attaches `Cookie` and `Authorization` headers to the upstream WebSocket
- For **bridge** upstreams: no Proxmox auth headers needed; the bridge endpoint (websockify) handles its own auth

**Bridge features:**

- Bidirectional binary relay between browser WebSocket and upstream WebSocket
- `4 MB` max payload (`maxPayload: 4 * 1024 * 1024`) — VNC frames can be large
- Race-safe close handling (prevents double-close errors during teardown)
- Close reason sanitization (RFC 6455: max 123 bytes, newline stripping)
- Server-side logging of detailed errors; sanitized messages to browser
- `insecureTls` support via `PVE_INSECURE_TLS`

### 2d. Client Page (`src/routes/proxmox/vnc/+page.svelte`)

~500 lines. Full-screen noVNC client with credential management and reconnect.

**Component architecture:**

| Region | Purpose |
|--------|---------|
| Script | State management (`$state`), `onMount` RFB initialization, `$effect` credential seeding, credential form handling |
| Template | Header bar (workload label + status text), VNC container with overlay (connecting/credentials/warning/error), credential form |
| Style | Full-page layout, overlay gradients, credential form styling, canvas sizing |

**RFB session lifecycle:**

1. `openRfbSession()` — lazy-loads `@novnc/novnc`, constructs WebSocket URL pointing to local bridge, creates `RFB` instance with `shared: true`
2. **Connect watchdog** — 8-second timeout fires if no `connect` event; shows error overlay
3. `connect` event — clears watchdog, sets `connected` state
4. `disconnect` event — shows warning or error based on clean/pending connection state
5. `credentialsrequired` event — auto-submits server-provided credentials if available; otherwise shows credential prompt
6. `securityfailure` event — shows appropriate message; for native mode, offers reconnect (to get fresh ticket)

**Auto-credential flow:**

On `credentialsrequired`, the page checks if server-provided `vncPassword` is available. If so, it auto-submits via `rfb.sendCredentials({ password: data.vncPassword, username: data.vncUsername })`. A single-pass flag (`autoCredentialsSubmitted`) prevents re-submission on subsequent prompts.

**Reconnect flow:**

The "Reconnect" button is shown on warning/error states when a session has previously connected. It calls `reconnectSession()` which:
1. Disconnects the previous `RFB` instance
2. Calls `openRfbSession()` again (which gets a fresh WebSocket but reuses the server-provided upstream URL)
3. For native mode: a reconnect from the browser does NOT get a new Proxmox ticket — the old ticket may have expired, so operators should refresh the page for a fresh ticket

**Credential form:**

Dynamic form that shows only the fields the RFB server requested (`username`, `password`, `target`). Submit handler sends via `rfbSession.sendCredentials()`.

**Clipboard support (bidirectional):**

Two-directional clipboard bridging between the browser and the guest VM:

| Direction | Mechanism | Implementation |
|-----------|-----------|----------------|
| **Browser → Guest (paste)** | `paste` event on the VNC container | Intercepts Ctrl+V/Cmd+V, reads `event.clipboardData.getData('text/plain')`, forwards to VM via `rfb.sendClipboard(text)` — no guest software required (RFB-level cut-text pseudo-encoding) |
| **Guest → Browser (copy)** | `clipboard` event from noVNC RFB library | When the guest pushes text via RFB clipboard pseudo-encoding, writes it to the browser's clipboard via `navigator.clipboard.writeText(text)` |

### 2e. Vite Plugin (`vite.config.ts`)

```typescript
function proxmoxVncPlugin(): Plugin {
  return {
    name: 'proxmox-vnc-ws',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer) return;
      attachProxmoxVncWsProxy(server.httpServer);
    }
  };
}
```

Registered in `vite.config.ts` alongside `sveltekit()` and the terminal plugin. Only applies during dev serve (`apply: 'serve'`).

---

## 3. Configuration

### Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PVE_BASE_URL` | *(required)* | Proxmox API base URL |
| `PVE_API_TOKEN` | — | Proxmox API token (preferred over username/password) |
| `PVE_USERNAME` | — | Proxmox username (for login sessions) |
| `PVE_PASSWORD` | — | Proxmox password |
| `PVE_REALM` | `pam` | Proxmox authentication realm |
| `PVE_INSECURE_TLS` | `false` | When `true`, skips TLS certificate validation |
| `LXC_VNC_BRIDGE_WS_URL` | — | Explicit websockify bridge URL template (supports `{node}`, `{vmid}`, `{ip}`, `{ipv4}` placeholders) |
| `LXC_VNC_BRIDGE_DERIVE_FROM_IPV4` | `false` | When `true`, derives bridge URLs from guest IPv4 addresses |
| `LXC_VNC_BRIDGE_WS_SCHEME` | `ws` | WebSocket scheme for derived mode (`ws` or `wss`) |
| `LXC_VNC_BRIDGE_WS_PORT` | `8001` | Bridge WebSocket port for derived mode |
| `LXC_VNC_BRIDGE_WS_PATH` | — | Optional URL path appended to derived bridge targets |
| `LXC_VNC_BRIDGE_ALLOWED_HOSTS` | — | Comma-separated host:port allowlist for explicit bridge URL mode |

### Route / Endpoint Summary

| Route | Type | Purpose |
|-------|------|---------|
| `/proxmox/vnc?vmid=&node=&type=&name=&ip=` | GET page | Loads VNC page with upstream WebSocket URL and credentials |
| `/proxmox/vnc/ws?upstream=&vmid=` | WebSocket upgrade | Bridges browser WebSocket to upstream VNC target |

---

## 4. Visual Design

### Button Styling (`src/PxMxStyle.css`)

| Property | Value | Purpose |
|----------|-------|---------|
| Background | `#dbeafe` | Blue tint — visually distinct from green terminal button |
| Border | `#60a5fa` | Blue border for quick scanning |
| Hover background | `#bfdbfe` | Slightly darker on hover |
| Hover border | `#3b82f6` | Blue emphasis |
| Active transform | `scale(0.95)` | Press feedback |
| Disabled opacity | `0.55` | Clear disabled state |
| Icon size | `1.1rem × 1.1rem` | Slightly larger than terminal icon |

Icon: `static/vnc.svg` — monitor/display icon for GUI distinction.

---

## 5. Key Files

| File | Purpose |
|------|---------|
| `playground/src/PxMxWorkloadControls.svelte` | VNC button eligibility logic, HREF construction, tooltips |
| `playground/src/routes/proxmox/vnc/+page.server.ts` | Server load — mode resolution, IP discovery, ticket issuance |
| `playground/src/routes/proxmox/vnc/+page.svelte` | Client — noVNC RFB lifecycle, credential management, reconnect |
| `playground/src/types/novnc.d.ts` | TypeScript declarations for `@novnc/novnc` |
| `playground/server/proxmoxVncWs.ts` | WebSocket bridge — upgrade handler, security validation, binary relay |
| `playground/vite.config.ts` | Vite plugin registration for WebSocket proxy |
| `playground/src/PxMxStyle.css` | Button styling, hover states, disabled appearance |
| `playground/static/vnc.svg` | VNC button icon |
| `playground/PxMx-Admin-For-Datalab-Guide.md` | Admin guide — bridge mode setup, environment variables |
| `pve-client/src/helpers/Display.ts` | Display helper — ticket creation, connection info, session management |

---

## 6. Browser Support

The VNC page uses:
- `@novnc/novnc` — industry-standard RFB client, supports RFB 3.8-3.8
- WebSocket API — required for the bridge connection
- `navigator.clipboard` API — used for bidirectional clipboard bridge (guest → browser)
- Modern ES modules — lazy-imported at runtime

---

## 7. Known Limitations

| Limitation | Detail |
|------------|--------|
| **Reconnect doesn't refresh tickets** | Native Proxmox VNC tickets are short-lived. The reconnect button re-uses the existing upstream URL. For expired tickets, operators should refresh the page. |
| **Bridge mode requires guest setup** | For bridge mode to work, the guest must have a VNC server (e.g., TigerVNC) and websockify running. See `PxMx-Admin-For-Datalab-Guide.md` §1.4 for setup instructions. |
| **Container GUI needs explicit enablement** | The VNC button is hidden for containers unless `containerGuiEnabled` is set — this is a safety gate since most containers don't have GUI installations. |
| **IPv4-only bridge resolution** | Bridge mode resolves and connects via IPv4 only. IPv6-only guests cannot use bridge mode. |
| **Paste works without guest agent; copy requires one** | Browser-to-guest paste uses the RFB protocol's cut-text pseudo-encoding and needs no guest software. Guest-to-browser copy requires the guest to push clipboard text — typically via a clipboard agent (e.g., `xfce4-clipman`, QEMU guest agent with spice-vdagent, or the VNC server's built-in clipboard sharing). Without a clipboard agent, paste-to-VM works but copy-from-VM does not. |
| **Browser clipboard write may be blocked** | `navigator.clipboard.writeText()` requires the tab to be in the foreground and the user to have granted clipboard permissions. In background tabs the write silently fails — the operator can recover by manually copying from the VNC window. |

---

## Applicable Policies (from POLICIES.md)

> The following are verbatim excerpts from `POLICIES.md`, the authoritative policy source.

### Architecture: pve-client + playground

- **Fix API-surface gaps in `pve-client` first**; avoid consumer-side cast workarounds.
- Server-side terminal/WebSocket responsibility lives in `pve-client`; playground wiring stays thin.

*(VNC follows the same pattern: `Display` class and `DisplaySession` live in `pve-client`, while the playground provides the UI, server load, and WebSocket bridge.)*

### P4a: Fail Fast

- Prefer early, detectable failures. A compile-time type error beats a runtime `undefined`.
- When a prerequisite is missing, fail with a clear, actionable message — never default to `undefined` or degraded behavior.

*(The VNC button uses `vncEnabled` with explicit eligibility checks — disabled with contextual tooltips rather than failing silently. `getRunningVm()` in `Display` rejects stopped/missing VMs with clear errors.)*

### P4b: Error Messages

- Wrong/rejected values: always include the actual value in the error message so the caller can identify it.
- Sensitive values (passwords, tokens, secrets) must never appear in error messages.
