/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { sveltekit } from '@sveltejs/kit/vite';
import mkcert from 'vite-plugin-mkcert';
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket as WsWebSocket, RawData } from 'ws';

// ---------------------------------------------------------------------------
// Proxmox terminal WebSocket proxy plugin (dev server only)
// ---------------------------------------------------------------------------
// Routes: GET /proxmox/terminal/ws?vmid=...&node=...&type=(vm|container)
// Bridges a browser WebSocket to a pve-client TerminalSession.
// pve-client handles termproxy creation, auth handshake, keepalive and framing.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
const dirname = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

// More info at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon

async function handleTerminalWs(browserWs: WsWebSocket, params: URLSearchParams): Promise<void> {
  const {
    Client
  } = await import('pve-client');
  const {
    Agent
  } = await import('node:https');
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
    const agent = insecureTls ? new Agent({
      rejectUnauthorized: false
    }) : undefined;
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

    // Simplest path: let the pve-client helper do all Proxmox terminal protocol work.
    const terminal = client.helpers.terminal(vmid);
    const session = await terminal.open({
      rejectUnauthorized: !insecureTls,
      reconnect: true,
      reconnectIntervalMs: 1500,
      reconnectMaxAttempts: Number.POSITIVE_INFINITY
    });
    session.on('data', data => {
      // Forward terminal stdout/stderr to the browser as raw bytes.
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(data);
      }
    });
    session.on('close', () => {
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.close(1001, 'Proxmox terminal closed');
      }
    });
    session.on('error', err => {
      console.error('[proxmox-terminal-ws] Terminal session error:', err);
      if (browserWs.readyState === browserWs.OPEN) {
        browserWs.send(Buffer.from(`\r\n\x1b[31mProxmox error: ${err.message}\x1b[0m\r\n`));
      }
    });
    browserWs.on('message', (raw: RawData) => {
      const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      if (text.startsWith('R:')) {
        // Browser resize frame: R:{cols}:{rows}
        const [cols, rows] = text.slice(2).split(':');
        const parsedCols = Number(cols);
        const parsedRows = Number(rows);
        if (Number.isInteger(parsedCols) && Number.isInteger(parsedRows) && parsedCols > 0 && parsedRows > 0) {
          // TerminalSession converts this event into Proxmox resize protocol messages.
          session.emit('resize', parsedCols, parsedRows);
        }
      } else {
        // Stdin data from browser terminal.
        session.write(text);
      }
    });
    browserWs.on('close', () => {
      session.close();
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
          const {
            WebSocketServer
          } = await import('ws');
          wss = new WebSocketServer({
            noServer: true
          });
        }
        return wss;
      };
      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!req.url) return;
        const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
        if (url.pathname !== '/proxmox/terminal/ws') return;
        void getWss().then(wssInstance => {
          wssInstance.handleUpgrade(req, socket, head, browserWs => {
            void handleTerminalWs(browserWs, url.searchParams);
          });
        });
      });
    }
  };
}
export default defineConfig({
  plugins: [sveltekit(), proxmoxTerminalPlugin(), mkcert()],
  server: {
    https: true,
    port: 8000
  },
  test: {
    expect: {
      requireAssertions: true
    },
    projects: [{
      extends: './vite.config.ts',
      test: {
        name: 'client',
        browser: {
          enabled: true,
          provider: playwright(),
          instances: [{
            browser: 'chromium',
            headless: true
          }]
        },
        include: ['tests/**/*.svelte.{test,spec}.{js,ts}'],
        exclude: ['src/lib/server/**']
      }
    }, {
      extends: './vite.config.ts',
      test: {
        name: 'server',
        environment: 'node',
        include: ['tests/**/*.{test,spec}.{js,ts}'],
        exclude: ['tests/**/*.svelte.{test,spec}.{js,ts}']
      }
    }, {
      extends: true,
      plugins: [
      // The plugin will run tests for the stories defined in your Storybook config
      // See options at: https://storybook.js.org/docs/next/writing-tests/integrations/vitest-addon#storybooktest
      storybookTest({
        configDir: path.join(dirname, '.storybook')
      })],
      test: {
        name: 'storybook',
        browser: {
          enabled: true,
          headless: true,
          provider: playwright({}),
          instances: [{
            browser: 'chromium'
          }]
        }
      }
    }]
  }
});