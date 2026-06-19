/**
 * GET /proxmox/agent-status — Check if guest agent is available and get disk space.
 *
 * Query params: vmid (number), node (string), type ('vm' | 'container')
 * Response: { available: boolean; availableSpace: number | null; reason?: string }
 *
 * For VMs: tries agent/network-get-interfaces, then exec `df -B1` if agent is up
 * For containers: checks running status via LXC status, then execs `df -B1`
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Agent } from 'node:https';
import { Client } from 'pve-client';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function createClient(baseUrl: string, username: string, password: string, realm: string, agent: Agent | undefined): Client {
  return new Client({
    baseUrl,
    username,
    password,
    realm,
    agent,
  });
}

async function parseDfOutput(output: string): Promise<number | null> {
  const lines = output.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Filesystem') || !trimmed) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 4) continue;

    const avail = Number(parts[3]);
    if (Number.isFinite(avail) && avail > 0) {
      return avail;
    }
  }
  return null;
}

async function getVmAgentStatus(
  client: Client,
  node: string,
  vmid: number,
): Promise<{ available: boolean; availableSpace: number | null; reason?: string }> {
  try {
    await client.api.nodes.get(node).qemu.vmid(vmid).agent.network_interfaces();
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    return {
      available: false,
      availableSpace: null,
      reason: /qga command failed|no guest agent/.test(msg)
        ? 'QEMU guest agent is not running'
        : `Agent check failed: ${msg}`,
    };
  }

  let availableSpace: number | null = null;
  try {
    const execResult = await client.api.nodes.get(node).qemu.vmid(vmid).agent.exec({
      command: ['df', '-B1', '/'],
    });
    const pid = execResult.pid;

    for (let i = 0; i < 10; i++) {
      const status = await client.api.nodes.get(node).qemu.vmid(vmid).agent.exec_status({
        $query: { pid },
      });

      if (status.exited) {
        if (typeof status['out-data'] === 'string') {
          availableSpace = await parseDfOutput(status['out-data']);
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  } catch {
    // Disk space is optional — don't fail the whole check if df fails
  }

  return { available: true, availableSpace };
}

async function getContainerAgentStatus(
  client: Client,
  node: string,
  vmid: number,
): Promise<{ available: boolean; availableSpace: number | null; reason?: string }> {
  try {
    const status = await client.api.nodes.get(node).lxc.id(vmid).status.current();
    if (status.status !== 'running') {
      return {
        available: false,
        availableSpace: null,
        reason: `Container is not running (status: ${status.status})`,
      };
    }
  } catch (err: unknown) {
    return {
      available: false,
      availableSpace: null,
      reason: `Container status check failed: ${(err as Error).message}`,
    };
  }

  let availableSpace: number | null = null;
  try {
    const execResult = await client.api.nodes.get(node).lxc.id(vmid).exec({
      cmd: ['df', '-B1', '/'],
      timeout: 10,
    });
    const pid = execResult.pid;

    const status = await client.api.nodes.get(node).lxc.id(vmid).exec_status({
      $query: { pid },
    });

    if (typeof status['out-data'] === 'string') {
      availableSpace = await parseDfOutput(status['out-data']);
    }
  } catch {
    // Disk space is optional — don't fail the whole check if df fails
  }

  return { available: true, availableSpace };
}

export function attachProxmoxAgentStatusHandler(httpServer: import('node:http').Server): void {
  httpServer.on('request', async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'GET' || !req.url?.startsWith('/proxmox/agent-status')) return;

    const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
    const vmidStr = url.searchParams.get('vmid');
    const node = url.searchParams.get('node');
    const type = url.searchParams.get('type');

    if (!vmidStr || !node || !type) {
      sendJson(res, 400, { error: 'Missing vmid, node, or type query params' });
      return;
    }

    const vmid = parseInt(vmidStr, 10);
    if (!Number.isInteger(vmid) || vmid <= 0) {
      sendJson(res, 400, { error: 'vmid must be a positive integer' });
      return;
    }

    if (type !== 'vm' && type !== 'container') {
      sendJson(res, 400, { error: `Invalid type: ${type}` });
      return;
    }

    try {
      const baseUrl = process.env.PVE_BASE_URL;
      const username = process.env.PVE_USERNAME?.trim() || undefined;
      const password = process.env.PVE_PASSWORD?.trim() || undefined;
      const realm = process.env.PVE_REALM?.trim() || 'pam';
      const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

      if (!baseUrl) {
        sendJson(res, 500, { error: 'PVE_BASE_URL not configured' });
        return;
      }

      if (!username || !password) {
        sendJson(res, 500, { error: 'PVE_USERNAME and PVE_PASSWORD required' });
        return;
      }

      const { Agent } = await import('node:https');
      const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

      const client = createClient(baseUrl, username, password, realm, agent);
      await client.login();

      const result = type === 'vm'
        ? await getVmAgentStatus(client, node, vmid)
        : await getContainerAgentStatus(client, node, vmid);

      sendJson(res, 200, result);
    } catch (err: unknown) {
      sendJson(res, 500, {
        error: `Agent status check failed: ${(err as Error).message}`,
        available: false,
        availableSpace: null,
      });
    }
  });
}
