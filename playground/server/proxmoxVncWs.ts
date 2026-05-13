import { Buffer } from 'node:buffer';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { RawData, WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import WS from 'ws';

const ALLOWED_VNC_PATH = /^\/api2\/json\/nodes\/[^/]+\/(qemu|lxc)\/\d+\/vncwebsocket$/;

function toBuffer(data: RawData): Buffer {
  if (typeof data === 'string') return Buffer.from(data);
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((part) => (Buffer.isBuffer(part) ? part : Buffer.from(part))));
  }
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function safeClose(ws: WsWebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    // Ignore close races; websocket may already be torn down.
  }
}

async function handleVncWs(browserWs: WsWebSocket, params: URLSearchParams): Promise<void> {
  const { Client } = await import('pve-client');
  const { Agent } = await import('node:https');

  const upstreamRaw = params.get('upstream');
  if (!upstreamRaw) {
    browserWs.close(1008, 'Missing upstream websocket URL');
    return;
  }

  let upstreamUrl: URL;
  try {
    upstreamUrl = new URL(upstreamRaw);
  } catch {
    browserWs.close(1008, 'Invalid upstream websocket URL');
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

    const baseHost = new URL(baseUrl).host;
    if ((upstreamUrl.protocol !== 'ws:' && upstreamUrl.protocol !== 'wss:') || upstreamUrl.host !== baseHost) {
      browserWs.close(1008, 'Upstream websocket host is not allowed');
      return;
    }

    // Restrict proxy targets to the expected Proxmox VNC websocket endpoint.
    if (!ALLOWED_VNC_PATH.test(upstreamUrl.pathname) || !upstreamUrl.searchParams.get('vncticket')) {
      browserWs.close(1008, 'Upstream websocket path is not allowed');
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

    const headers: Record<string, string> = {
      Origin: `${upstreamUrl.protocol === 'wss:' ? 'https:' : 'http:'}//${upstreamUrl.host}`,
    };

    const cookie = client.sessionCookie();
    if (cookie) headers.Cookie = cookie;

    const token = client.tokenAuthorizationHeader();
    if (token) headers.Authorization = token;

    if (!headers.Cookie && !headers.Authorization) {
      browserWs.close(1011, 'Missing websocket authentication headers');
      return;
    }

    const upstreamWs = new WS(upstreamUrl.toString(), {
      headers,
      rejectUnauthorized: !insecureTls,
    });

    // This proxy intentionally keeps auth server-side while preserving the raw
    // RFB stream. The browser still runs noVNC protocol logic end-to-end.
    upstreamWs.on('message', (data) => {
      if (browserWs.readyState === browserWs.OPEN) {
        try {
          browserWs.send(toBuffer(data));
        } catch {
          safeClose(browserWs, 1011, 'Proxy write failed');
        }
      }
    });

    upstreamWs.on('close', () => {
      safeClose(browserWs, 1001, 'Proxmox VNC session closed');
    });

    upstreamWs.on('error', (err) => {
      // Log detailed error server-side, but avoid leaking internals to clients.
      console.error('[proxmox-vnc-ws] Upstream websocket error:', err);
      safeClose(browserWs, 1011, 'Upstream VNC websocket failed');
    });

    browserWs.on('message', (data) => {
      if (upstreamWs.readyState === WS.OPEN) {
        try {
          upstreamWs.send(toBuffer(data));
        } catch {
          safeClose(browserWs, 1011, 'Proxy write failed');
          upstreamWs.close();
        }
      }
    });

    browserWs.on('close', () => {
      if (upstreamWs.readyState === WS.OPEN || upstreamWs.readyState === WS.CONNECTING) upstreamWs.close();
    });

    browserWs.on('error', () => {
      if (upstreamWs.readyState === WS.OPEN || upstreamWs.readyState === WS.CONNECTING) {
        upstreamWs.close();
      }
    });
  } catch (err) {
    console.error('[proxmox-vnc-ws] Setup error:', err);
    browserWs.close(1011, 'Internal error');
  }
}

export function attachProxmoxVncWsProxy(httpServer: HttpServer): void {
  let wss: WebSocketServer | undefined;

  const getWss = async () => {
    if (!wss) {
      const { WebSocketServer } = await import('ws');
      wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    }
    return wss;
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url) return;

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/proxmox/vnc/ws') return;

    void getWss()
      .then((wssInstance) => {
        wssInstance.handleUpgrade(req, socket, head, (upgradedWs) => {
          void handleVncWs(upgradedWs, url.searchParams);
        });
      })
      .catch((err) => {
        console.error('[proxmox-vnc-ws] Upgrade setup failed:', err);
        socket.destroy();
      });
  });
}
