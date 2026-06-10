import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket as WsWebSocket, WebSocketServer } from 'ws';

// Proxmox terminal proxy flow:
// 1) Intercept HTTP upgrade requests for /proxmox/terminal/ws.
// 2) Validate VM target and build an authenticated Proxmox client.
// 3) Open a terminal helper session and bridge browser WS <-> termproxy WS.
// 4) Apply bridge safety/normalization options used by runtime diagnostics.

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
    const session = await terminal.open({
      // Keep reconnecting so brief termproxy/socket interruptions recover automatically.
      rejectUnauthorized: !insecureTls,
      reconnect: true,
      reconnectIntervalMs: 1500,
      reconnectMaxAttempts: Number.POSITIVE_INFINITY
    });

    const decoder = new TextDecoder();

    const safeCloseBrowser = (code: number, reason: string): void => {
      if (browserWs.readyState === browserWs.OPEN || browserWs.readyState === browserWs.CONNECTING) {
        browserWs.close(code, reason);
      }
    };

    const tryParseResizeFrame = (text: string): { cols: number; rows: number } | undefined => {
      try {
        const parsed = JSON.parse(text) as { type?: string; cols?: unknown; rows?: unknown };
        const cols = Number(parsed.cols);
        const rows = Number(parsed.rows);
        if (parsed.type !== 'resize' || !Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
          return undefined;
        }
        return { cols, rows };
      } catch {
        return undefined;
      }
    };

    const toUtf8Text = (payload: RawData): string => {
      if (typeof payload === 'string') return payload;
      if (Buffer.isBuffer(payload)) return payload.toString('utf8');
      if (payload instanceof ArrayBuffer) return decoder.decode(new Uint8Array(payload));
      if (Array.isArray(payload)) return Buffer.concat(payload.map((part) => Buffer.from(part))).toString('utf8');
      return decoder.decode(payload);
    };

    session.on('data', (chunk) => {
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(chunk);
      }
    });

    session.on('error', (err) => {
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`));
      }
    });

    session.on('close', () => {
      safeCloseBrowser(1000, 'Proxmox terminal closed');
    });

    browserWs.on('message', (payload: RawData) => {
      const text = toUtf8Text(payload);
      const resize = tryParseResizeFrame(text);

      if (resize) {
        session.emit('resize', resize.cols, resize.rows);
        return;
      }

      session.write(text);
    });

    browserWs.on('close', () => {
      session.close();
    });

    browserWs.on('error', () => {
      session.close();
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
