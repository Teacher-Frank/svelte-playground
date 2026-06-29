import { defineConfig, loadEnv } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import mkcert from 'vite-plugin-mkcert';
import type { Plugin } from 'vite';
import { attachProxmoxTerminalWsProxy } from './server/proxmoxTerminalWs.ts';
import { attachProxmoxVncWsProxy } from './server/proxmoxVncWs.ts';
import { handleProxmoxUpload } from './server/proxmoxTerminalUpload.ts';
import { handleProxmoxAgentStatus } from './server/proxmoxGuestAgentStatus.ts';

/** Dev-mode middleware plugin: POST /proxmox/upload */
function proxmoxUploadPlugin(): Plugin {
  return {
    name: 'proxmox-upload-http',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method === 'POST' && req.url?.startsWith('/proxmox/upload')) {
          await handleProxmoxUpload(req, res);
          return;
        }
        next();
      });
    },
  };
}

/** Dev-mode middleware plugin: GET /proxmox/agent-status */
function proxmoxAgentStatusPlugin(): Plugin {
  return {
    name: 'proxmox-agent-status-http',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.method === 'GET' && req.url?.startsWith('/proxmox/agent-status')) {
          await handleProxmoxAgentStatus(req, res);
          return;
        }
        next();
      });
    },
  };
}

function proxmoxTerminalPlugin(): Plugin {
  return {
    name: 'proxmox-terminal-ws',
    apply: 'serve',
    configureServer(server) {
      if (!server.httpServer) return;
      attachProxmoxTerminalWsProxy(server.httpServer);
    }
  };
}

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
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const useMkcert = command === 'serve' && env.PLAYGROUND_USE_MKCERT !== 'false';

  return {
    plugins: [
      sveltekit(),
      proxmoxTerminalPlugin(),
      proxmoxVncPlugin(),
      proxmoxUploadPlugin(),
      proxmoxAgentStatusPlugin(),
      ...(useMkcert ? [mkcert()] : []),
    ],
    server: {
      https: true,
      port: 8000
    }
  };
});