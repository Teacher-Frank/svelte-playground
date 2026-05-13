import { defineConfig } from 'vite';
import { sveltekit } from '@sveltejs/kit/vite';
import mkcert from 'vite-plugin-mkcert';
import type { Plugin } from 'vite';
import { attachProxmoxTerminalWsProxy } from './server/proxmoxTerminalWs.ts';

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
export default defineConfig({
  plugins: [sveltekit(), proxmoxTerminalPlugin(), mkcert()],
  server: {
    https: true,
    port: 8000
  }
});