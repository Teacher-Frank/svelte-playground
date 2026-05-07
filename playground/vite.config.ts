import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket as WsWebSocket, RawData } from 'ws';

// ---------------------------------------------------------------------------
// Proxmox terminal WebSocket proxy plugin (dev server only)
// ---------------------------------------------------------------------------
// Routes: GET /proxmox/terminal/ws?vmid=...&node=...&type=(vm|container)
// Bridges a browser WebSocket to the Proxmox vncwebsocket endpoint.
//
// Server ↔ Browser protocol (our simplified layer):
//   Server→Browser : binary frames — raw terminal output bytes
//   Browser→Server : text frames
//     "R:{cols}:{rows}"  — resize
//     anything else      — stdin data
//
// Server ↔ Proxmox protocol (Proxmox termproxy framing):
//   On open : send "${user}:${ticket}\n" for auth
//   Recv    : first frame must start with "OK" (bytes 79,75)
//   Send    : "0:{len}:{data}"   — stdin
//   Send    : "1:{cols}:{rows}:" — resize
//   Send    : "2"                — keepalive (every 30 s)
//   Recv    : raw output bytes forwarded to browser

type TermproxyTicket = { port: number; ticket: string; upid: string; user: string };
type PveGuestType = 'qemu' | 'lxc';

async function handleTerminalWs(
  browserWs: WsWebSocket,
  params: URLSearchParams,
): Promise<void> {
  const { WebSocket: WS } = await import('ws');
  const { Client } = await import('pve-client');
  const { Agent } = await import('node:https');

  const vmidStr = params.get('vmid');
  const node = params.get('node');
  const typeParam = params.get('type');

  if (!vmidStr || !node || (typeParam !== 'vm' && typeParam !== 'container')) {
    browserWs.close(1008, 'Missing or invalid vmid, node, or type');
    return;
  }

  const vmid = parseInt(vmidStr, 10);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    browserWs.close(1008, 'vmid must be a positive integer');
    return;
  }

  const guestType: PveGuestType = typeParam === 'vm' ? 'qemu' : 'lxc';

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
      client = new Client({ baseUrl, apiToken, agent });
    } else if (username && password) {
      client = new Client({ baseUrl, username, password, realm, agent });
      await client.login();
    } else {
      browserWs.close(1011, 'No Proxmox credentials configured');
      return;
    }

    // POST termproxy — works with both auth methods.
    // The path is typed as a literal in the API, so cast through unknown to accept the dynamic string.
    type AnyRequest = (path: string, method: string, args: object) => Promise<unknown>;
    const ticket = await (client.request as unknown as AnyRequest)(
      `/nodes/{node}/${guestType}/{vmid}/termproxy`,
      'POST',
      { $path: { node, vmid } },
    ) as TermproxyTicket;

    // Build the vncwebsocket URL via client.url() so the base URL and apiPath are correct.
    const httpUrl = client.url(
      `/nodes/${encodeURIComponent(node)}/${guestType}/${encodeURIComponent(String(vmid))}/vncwebsocket`,
      { port: ticket.port, vncticket: ticket.ticket },
    );
    const wsUrl = new URL(httpUrl);
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';

    const originProto = wsUrl.protocol === 'wss:' ? 'https:' : 'http:';
    const pveHeaders: Record<string, string> = {
      Origin: `${originProto}//${wsUrl.host}`,
    };
    // Use the right auth header for the WS connection.
    const cookie = client.sessionCookie();
    const authHeader = client.tokenAuthorizationHeader();
    if (cookie) pveHeaders.Cookie = cookie;
    if (authHeader) pveHeaders.Authorization = authHeader;

    const pveWs = new WS(wsUrl.toString(), {
      headers: pveHeaders,
      rejectUnauthorized: !insecureTls,
    });

    let authenticated = false;
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

    const closeBoth = (code: number, reason: string) => {
      clearInterval(keepAliveTimer);
      if (pveWs.readyState === WS.OPEN || pveWs.readyState === WS.CONNECTING) pveWs.close();
      if (browserWs.readyState === WS.OPEN) browserWs.close(code, reason);
    };

    pveWs.on('open', () => {
      pveWs.send(`${ticket.user}:${ticket.ticket}\n`);
      keepAliveTimer = setInterval(() => {
        if (pveWs.readyState === WS.OPEN) pveWs.send('2');
      }, 30_000);
    });

    pveWs.on('message', (raw: RawData) => {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
      if (!authenticated) {
        // First frame must be "OK" (0x4F 0x4B).
        if (data.length >= 2 && data[0] === 79 && data[1] === 75) {
          authenticated = true;
          const rest = data.subarray(2);
          if (rest.length > 0 && browserWs.readyState === WS.OPEN) browserWs.send(rest);
        } else {
          closeBoth(1011, 'Proxmox authentication failed');
        }
        return;
      }
      if (browserWs.readyState === WS.OPEN) browserWs.send(data);
    });

    pveWs.on('error', (err: Error) => {
      console.error('[proxmox-terminal-ws] Proxmox WS error:', err);
      if (browserWs.readyState === WS.OPEN) {
        browserWs.send(Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`));
      }
      closeBoth(1011, 'Proxmox WebSocket error');
    });

    pveWs.on('close', () => {
      clearInterval(keepAliveTimer);
      if (browserWs.readyState === WS.OPEN) browserWs.close(1001, 'Proxmox connection closed');
    });

    browserWs.on('message', (raw: RawData) => {
      if (pveWs.readyState !== WS.OPEN) return;
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (text.startsWith('R:')) {
        // Resize: R:{cols}:{rows}
        const [cols, rows] = text.slice(2).split(':');
        if (cols && rows) pveWs.send(`1:${cols}:${rows}:`);
      } else {
        // Stdin data
        const byteLen = Buffer.byteLength(text, 'utf8');
        pveWs.send(`0:${byteLen}:${text}`);
      }
    });

    browserWs.on('close', () => {
      clearInterval(keepAliveTimer);
      if (pveWs.readyState === WS.OPEN || pveWs.readyState === WS.CONNECTING) pveWs.close();
    });

  } catch (err) {
    console.error('[proxmox-terminal-ws] Setup error:', err);
    if (browserWs.readyState === 1 /* OPEN */) {
      browserWs.send(Buffer.from(`\r\n\x1b[31mFailed to connect: ${String(err)}\x1b[0m\r\n`));
    }
    browserWs.close(1011, 'Internal error');
  }
}

function proxmoxTerminalPlugin(): Plugin {
  return {
    name: 'proxmox-terminal-ws',
    configureServer(server) {
      let wss: import('ws').WebSocketServer | undefined;

      const getWss = async () => {
        if (!wss) {
          const { WebSocketServer } = await import('ws');
          wss = new WebSocketServer({ noServer: true });
        }
        return wss;
      };

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!req.url) return;
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/proxmox/terminal/ws') return;

        void getWss().then((wssInstance) => {
          wssInstance.handleUpgrade(req, socket, head, (browserWs) => {
            void handleTerminalWs(browserWs, url.searchParams);
          });
        });
      });
    },
  };
}

export default defineConfig({
	plugins: [sveltekit(), proxmoxTerminalPlugin()],
	server: {
		port: 8000
	},
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['tests/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['tests/**/*.{test,spec}.{js,ts}'],
					exclude: ['tests/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
