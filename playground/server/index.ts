import { createServer } from 'node:http';
import { env } from 'node:process';
import { handler } from '../build/handler.js';
import { attachProxmoxTerminalWsProxy } from './proxmoxTerminalWs.ts';
import { attachProxmoxVncWsProxy } from './proxmoxVncWs.ts';
import { attachProxmoxUploadHandler } from './proxmoxTerminalUpload.ts';
import { attachProxmoxAgentStatusHandler } from './proxmoxGuestAgentStatus.ts';

const port = Number(env.PORT ?? 3000);
const host = env.HOST ?? '0.0.0.0';

const server = createServer((req, res) => {
  handler(req, res);
});

attachProxmoxTerminalWsProxy(server);
attachProxmoxVncWsProxy(server);
attachProxmoxUploadHandler(server);
attachProxmoxAgentStatusHandler(server);

server.listen(port, host, () => {
  console.log(`[server] listening on http://${host}:${port}`);
});
