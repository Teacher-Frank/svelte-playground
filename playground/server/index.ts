import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { env } from 'node:process';
import { handler } from '../build/handler.js';
import { attachProxmoxTerminalWsProxy } from './proxmoxTerminalWs.ts';
import { attachProxmoxVncWsProxy } from './proxmoxVncWs.ts';
import { handleProxmoxUpload } from './proxmoxTerminalUpload.ts';
import { handleProxmoxAgentStatus } from './proxmoxGuestAgentStatus.ts';

const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? '0.0.0.0';

// Custom HTTP handlers run _before_ SvelteKit, in order.
// Each returns `true` if it consumed the request, `false` to fall through.
// This avoids the race where `server.on('request', async ...)` listeners
// lose to SvelteKit's synchronous handler() call in createServer.
type HttpGuard = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

const httpGuards: HttpGuard[] = [
  async (req, res) => {
    if (req.method !== 'POST' || !req.url?.startsWith('/proxmox/upload')) return false;
    await handleProxmoxUpload(req, res);
    return true;
  },
  async (req, res) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/proxmox/agent-status')) return false;
    await handleProxmoxAgentStatus(req, res);
    return true;
  },
];

const server = createServer(async (req, res) => {
  for (const fn of httpGuards) {
    const consumed = await fn(req, res);
    if (consumed) return;
  }
  handler(req, res);
});

attachProxmoxTerminalWsProxy(server);
attachProxmoxVncWsProxy(server);

server.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
});
