import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket as WsWebSocket, WebSocketServer } from 'ws';

// Proxmox terminal proxy flow:
// 1) Intercept HTTP upgrade requests for /proxmox/terminal/ws.
// 2) Validate VM target and build an authenticated Proxmox client.
// 3) Open a terminal helper session and bridge browser WS <-> termproxy WS.
// 4) Apply bridge safety/normalization options used by runtime diagnostics.

async function handleTerminalWs(browserWs: WsWebSocket, params: URLSearchParams): Promise<void> {
  // Lazy imports keep SSR/startup lightweight and avoid loading terminal
  // dependencies until the upgrade route is actually used.
  const { Client, openTerminalBridge } = await import('pve-client');
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
    // Prefer token auth when configured; fall back to username/password login.
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
    if (apiToken) {
      client = new Client({
        baseUrl,
        apiToken,
        agent
      });
    } else if (username && password) {
      client = new Client({
        baseUrl,
        username,
        password,
        realm,
        agent
      });
      await client.login();
    } else {
      browserWs.close(1011, 'No Proxmox credentials configured');
      return;
    }

    const terminal = client.helpers.terminal(vmid);
    await openTerminalBridge(terminal, browserWs, {
      // Keep reconnecting so brief termproxy/socket interruptions recover automatically.
      rejectUnauthorized: !insecureTls,
      reconnect: true,
      reconnectIntervalMs: 1500,
      reconnectMaxAttempts: Number.POSITIVE_INFINITY
    }, {
      onErrorFrame: (err) => Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`),
      closeReasonOnSessionClose: 'Proxmox terminal closed',
      // Keep a one-time Enter nudge so shells like pwsh render prompt on open.
      enablePromptNudge: true,
      // Force stdin through binary lane so control sequences are preserved.
      allowTextInputFrames: false,
      // Keep a single stable raw-leaning bridge policy.
      enableInputRepairCompatibility: false,
      coalesceNavigationRepeats: false,
      normalizeSs3CursorKeys: false,
      simplifyModifiedCursorKeys: false,
      // Handy for debugging: uncomment to enable per-session bridge traces.
      // trace: traceTerminal,
      // traceLabel: `vmid:${vmid}`
    });
  } catch (err) {
    console.error('[proxmox-terminal-ws] Setup error:', err);
    if (browserWs.readyState === 1) {
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
