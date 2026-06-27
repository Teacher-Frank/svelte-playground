import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket as WsWebSocket } from 'ws';
import type { WebSocketServer } from 'ws';
import type { TerminalBrowserSocket } from 'pve-client';
import { openTerminalBridge } from 'pve-client';

// Proxmox terminal proxy flow:
// 1) Intercept HTTP upgrade requests for /proxmox/terminal/ws.
// 2) Validate VM target and build an authenticated Proxmox client.
// 3) Open a terminal session and bridge browser WS <-> termproxy WS using the
//    canonical `openTerminalBridge` from pve-client.
//
// Why openTerminalBridge instead of manual wiring:
// - Removes duplicate bridge logic (resize parsing, binary forwarding, error/close handling).
// - Activates all compatibility features: ANSI tail reassembly, SS3 normalization,
//   orphan fragment repair, navigation coalescing, and prompt nudge.
// - Follows POLICIES.md P2 ("extract shared code") and P2b ("no ad-hoc patterns alongside canonical").

/**
 * Wrap a `ws.WebSocket` in the `TerminalBrowserSocket` interface expected by
 * `openTerminalBridge`.
 *
 * Why: `TerminalBrowserSocket.OPEN` is an instance property, whereas
 * `ws.WebSocket.OPEN` is static. This adapter bridges the gap so the
 * canonical bridge can work with native `ws` sockets.
 */
function adaptWsToBrowserSocket(ws: WsWebSocket): TerminalBrowserSocket {
  return {
    OPEN: WsWebSocket.OPEN,
    get readyState() {
      return ws.readyState;
    },
    send(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code, reason);
    },
    on(event, listener) {
      ws.on(event, listener);
      return ws;
    },
  };
}

async function handleTerminalWs(browserWs: WsWebSocket, params: URLSearchParams): Promise<void> {
  // Lazy imports keep SSR/startup lightweight and avoid loading terminal
  // dependencies until the upgrade route is actually used.
  const { Client } = await import('pve-client');
  const { Agent } = await import('node:https');

  const vmidStr = params.get('vmid');
  if (!vmidStr) {
    browserWs.close(1008, 'Missing vmid');
    return;
  }

  const vmid = parseInt(vmidStr, 10);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    browserWs.close(1008, 'vmid must be a positive integer');
    return;
  }

  try {
    const baseUrl = process.env.PVE_BASE_URL;
    const apiToken = process.env.PVE_API_TOKEN?.trim() || undefined;
    const username = process.env.PVE_USERNAME?.trim() || undefined;
    const password = process.env.PVE_PASSWORD?.trim() || undefined;
    const realm = process.env.PVE_REALM?.trim() || 'pam';
    const insecureTls = process.env.PVE_INSECURE_TLS === 'true';
    // Handy for debugging terminal frame/order issues; keep disabled by default.
    // const traceTerminal = process.env.PVE_TERMINAL_TRACE === 'true';

    if (!baseUrl) {
      browserWs.close(1011, 'PVE_BASE_URL not configured');
      return;
    }

    // Match runtime TLS policy for both API and terminal websocket traffic.
    const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

    let client: InstanceType<typeof Client>;
    if (username && password) {
      client = new Client({
        baseUrl,
        username,
        password,
        realm,
        agent
      });
      await client.login();
    } else {
      const authMode = apiToken ? 'api-token' : 'none';
      browserWs.close(
        1011,
        `Unsupported terminal auth mode '${authMode}'. Configure PVE_USERNAME and PVE_PASSWORD.`
      );
      return;
    }

    if (apiToken) {
      console.warn('[proxmox-terminal-ws] PVE_API_TOKEN is set but ignored for terminal sessions. Using username/password login.');
    }

    const terminal = client.helpers.terminal(vmid);
    const browserSocket = adaptWsToBrowserSocket(browserWs);

    /*
     * Detect fatal Proxmox errors up-front so we can fail gracefully instead
     * of entering a reconnect loop. Returns a close string or undefined.
     *
     * Termproxy failures fall into two categories:
     * - Transient (network, timeout) — safe to reconnect.
     * - Fatal (provisioning: "serial", "termproxy", "not found") — should close
     *   immediately with a helpful message.
     */
    function isFatalProxmoxError(err: Error): string | undefined {
      const msg = err.message.toLowerCase();
      const adminEmail = process.env.PVE_ADMIN_CONTACT_EMAIL || 'the administrator';

      // VM missing a serial console: Proxmox termproxy can't open without one.
      if (/serial/i.test(msg)) {
        return `Terminal unavailable for VM ${vmid}: the VM does not have a serial console configured in Proxmox. Please contact ${adminEmail} to add a serial port (e.g. serial0 socket) to the VM configuration.`;
      }
      // VM/container does not exist or isn't running.
      if (/unable to find virtual machine/i.test(msg)) {
        return `Virtual machine ${vmid} not found. Please contact ${adminEmail} for assistance.`;
      }
      if (/not running/i.test(msg)) {
        return `Virtual machine ${vmid} is not running. Please contact ${adminEmail} for assistance.`;
      }
      return undefined;
    }

    // The bridge handles browserSocket.on('close') and browserSocket.on('message').
    // We attach a separate error handler so that uncaught ws errors (e.g., TLS failures,
    // malformed frames) are logged and gracefully close the connection, which then triggers
    // the bridge's close handler to clean up the Proxmox session (P4b compliance).
    browserWs.once('error', (err) => {
      console.error('[proxmox-terminal-ws] Browser socket error:', err);
      browserWs.close(1011, 'Browser socket error');
    });

    /*
     * Proactively check if a terminal ticket can be obtained before wiring the
     * bridge. `createTicket()` hits `/nodes/{node}/{type}/{vmid}/termproxy` — the
     * same endpoint that fails when a VM lacks a serial console.
     *
     * Why check early: `openTerminalBridge` + `TerminalSession` treat connection
     * errors as reconnectable. A "serial not configured" error is NOT transient —
     * it will never succeed. Catching it here lets us send a clean close to the
     * client with a helpful message instead of looping until reconnect exhaustion.
     */
    try {
      await terminal.createTicket();
    } catch (err) {
      const fatalMsg = isFatalProxmoxError(err instanceof Error ? err : new Error(String(err)));
      if (fatalMsg) {
        // Close with code 4001 (application-defined provisioning error).
        // The client detects this code and shows a friendly message.
        console.info('[proxmox-terminal-ws] Fatal provisioning error (vmid %d): %s', vmid, fatalMsg);
        browserWs.close(4001, fatalMsg);
        return;
      }
      // Non-fatal error: let the bridge handle it (will reconnect within 3 attempts).
      console.warn('[proxmox-terminal-ws] Transient ticket error (vmid %d): %s', vmid, (err as Error).message);
    }

    /*
     * Use the canonical bridge from pve-client instead of wiring events manually.
     *
     * This activates:
     * - Pre-ready input buffering (queues keystrokes until Proxmox session is ready)
     * - ANSI tail reassembly (handles ESC bytes split across WebSocket frames)
     * - SS3 → CSI normalization (fixes application cursor mode / vi fullscreen)
     * - Orphan fragment repair (fixes held-arrow-key corruption)
     * - Prompt nudge (sends \r if no output arrives within 400ms)
     * - Proper binary stdin forwarding via writeRaw (control-sequence fidelity)
     * - Error logging on browser socket close (P4b compliance)
     *
     * The client side sends JSON resize frames { type: "resize", cols, rows } —
     * parseBrowserFrame in the bridge handles these natively.
     */
    const _session = await openTerminalBridge(terminal, browserSocket, {
      // Keep reconnecting so brief termproxy/socket interruptions recover automatically.
      // Finite limit so fatal errors don't hang server-side forever.
      // A termproxy "serial not configured" error is terminal — after 3 retries
      // (total ~4.5s with default 1500ms interval) we give up.
      rejectUnauthorized: !insecureTls,
      reconnect: true,
      reconnectIntervalMs: 1500,
      reconnectMaxAttempts: 3,
    }, {
      // Format session errors as red ANSI lines for xterm.js display.
      onErrorFrame: (err: Error) =>
        Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`),
      closeCodeOnSessionClose: 1000,
      closeReasonOnSessionClose: 'Proxmox terminal closed',
    });
  } catch (err) {
    const fatalMsg = isFatalProxmoxError(err instanceof Error ? err : new Error(String(err)));
    if (fatalMsg) {
      console.info('[proxmox-terminal-ws] Fatal provisioning error (vmid %d): %s', vmid, fatalMsg);
      browserWs.close(4001, fatalMsg);
      return;
    }

    console.error('[proxmox-terminal-ws] Setup error:', err);
    if (browserWs.readyState === WsWebSocket.OPEN) {
      browserWs.send(Buffer.from(`\r\n\x1b[31mFailed to connect: ${String(err)}\x1b[0m\r\n`));
    }
    browserWs.close(1011, 'Internal error');
  }
}

export function attachProxmoxTerminalWsProxy(httpServer: HttpServer): void {
  let wss: WebSocketServer | undefined;

  const getWss = async () => {
    if (!wss) {
      const { WebSocketServer } = await import('ws');
      wss = new WebSocketServer({ noServer: true });
    }
    return wss;
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url) return;

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    // Scope upgrades explicitly so other websocket routes can coexist.
    if (url.pathname !== '/proxmox/terminal/ws') return;

    void getWss().then((wssInstance) => {
      wssInstance.handleUpgrade(req, socket, head, (upgradedWs) => {
        void handleTerminalWs(upgradedWs, url.searchParams);
      });
    });
  });
}
