import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket as WsWebSocket, WebSocketServer } from 'ws';

async function handleTerminalWs(browserWs: WsWebSocket, params: URLSearchParams): Promise<void> {
  const { Client } = await import('pve-client');
  const { Agent } = await import('node:https');

  let session: import('pve-client').TerminalSession | undefined;
  let sessionReady = false;
  let browserClosed = false;
  const pendingInputs: string[] = [];
  let sawTerminalOutput = false;
  let sawUserStdin = false;
  let promptNudgeTimer: ReturnType<typeof setTimeout> | undefined;

  const forwardBrowserInput = (text: string) => {
    if (!session || !sessionReady) {
      pendingInputs.push(text);
      return;
    }

    if (text.startsWith('R:')) {
      const [cols, rows] = text.slice(2).split(':');
      const parsedCols = Number(cols);
      const parsedRows = Number(rows);
      if (Number.isInteger(parsedCols) && Number.isInteger(parsedRows) && parsedCols > 0 && parsedRows > 0) {
        session.emit('resize', parsedCols, parsedRows);
      }
    } else {
      sawUserStdin = true;
      session.write(text);
    }
  };

  browserWs.on('message', (raw: RawData) => {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
    forwardBrowserInput(text);
  });

  browserWs.on('close', () => {
    browserClosed = true;
    if (promptNudgeTimer) {
      clearTimeout(promptNudgeTimer);
      promptNudgeTimer = undefined;
    }
    session?.close();
  });

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

    if (!baseUrl) {
      browserWs.close(1011, 'PVE_BASE_URL not configured');
      return;
    }

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
    session = await terminal.open({
      rejectUnauthorized: !insecureTls,
      reconnect: true,
      reconnectIntervalMs: 1500,
      reconnectMaxAttempts: Number.POSITIVE_INFINITY
    });

    if (browserClosed) {
      session.close();
      return;
    }

    session.on('data', (data) => {
      sawTerminalOutput = true;
      if (promptNudgeTimer) {
        clearTimeout(promptNudgeTimer);
        promptNudgeTimer = undefined;
      }

      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(data);
      }
    });

    session.on('close', () => {
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.close(1001, 'Proxmox terminal closed');
      }
    });

    session.on('error', (err) => {
      console.error('[proxmox-terminal-ws] Terminal session error:', err);
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`));
      }
    });

    session.once('ready', () => {
      sessionReady = true;

      for (const input of pendingInputs) {
        forwardBrowserInput(input);
      }
      pendingInputs.length = 0;

      // Some guests show the first prompt only after one key press.
      // Nudge once if no output and no user input arrived yet.
      promptNudgeTimer = setTimeout(() => {
        if (!session || !sessionReady || browserClosed || sawTerminalOutput || sawUserStdin) return;
        session.write('\r');
      }, 400);
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
    if (url.pathname !== '/proxmox/terminal/ws') return;

    void getWss().then((wssInstance) => {
      wssInstance.handleUpgrade(req, socket, head, (upgradedWs) => {
        void handleTerminalWs(upgradedWs, url.searchParams);
      });
    });
  });
}
