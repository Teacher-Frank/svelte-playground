import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import mkcert from 'vite-plugin-mkcert';
import type { Plugin } from 'vite';
import { attachProxmoxTerminalWsProxy } from './server/proxmoxTerminalWs.ts';
import { attachProxmoxVncWsProxy } from './server/proxmoxVncWs.ts';

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
export default defineConfig({
  plugins: [sveltekit(), proxmoxTerminalPlugin(), proxmoxVncPlugin(), mkcert()],
  server: {
    https: true,
    port: 8000
  }
});