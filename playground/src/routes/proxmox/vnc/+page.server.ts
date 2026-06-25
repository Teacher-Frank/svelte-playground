import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import { Agent } from 'node:https';

type LxcInterface = {
  inet?: string;
  'ip-addresses'?: Array<{
    'ip-address'?: string;
    'ip-address-type'?: string;
  }>;
};

const isIPv4Address = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }

  return true;
};

const extractPrimaryContainerIPv4 = (interfaces: LxcInterface[]): string | undefined => {
  for (const iface of interfaces) {
    const ipAddresses = Array.isArray(iface['ip-addresses']) ? iface['ip-addresses'] : [];
    for (const ipAddress of ipAddresses) {
      if (ipAddress['ip-address-type'] !== 'ipv4') continue;
      const value = ipAddress['ip-address'];
      if (typeof value !== 'string' || !isIPv4Address(value)) continue;
      if (value.startsWith('127.') || value.startsWith('169.254.')) continue;
      return value;
    }
  }

  for (const iface of interfaces) {
    const inet = iface.inet;
    if (typeof inet !== 'string' || !isIPv4Address(inet)) continue;
    if (inet.startsWith('127.') || inet.startsWith('169.254.')) continue;
    return inet;
  }

  return undefined;
};

// Build a bridge websocket URL for LXC sessions from an operator-provided
// template. We support {node}, {vmid}, and {ip}/{ipv4} placeholders for
// flexible routing.
const resolveLxcBridgeWsUrl = (template: string, node: string, vmid: number, ipv4?: string): string => {
  const replaced = template
    .replaceAll('{node}', encodeURIComponent(node))
    .replaceAll('{vmid}', encodeURIComponent(vmid.toString()))
    .replaceAll('{ip}', encodeURIComponent(ipv4 ?? ''))
    .replaceAll('{ipv4}', encodeURIComponent(ipv4 ?? ''));
  const parsed = new URL(replaced);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('LXC_VNC_BRIDGE_WS_URL must use ws:// or wss:// protocol');
  }
  return parsed.toString();
};

const buildBridgeWsUrlFromIpv4 = (ipv4: string): string => {
  const scheme = (process.env.LXC_VNC_BRIDGE_WS_SCHEME?.trim() || 'ws').toLowerCase();
  const port = process.env.LXC_VNC_BRIDGE_WS_PORT?.trim() || '8001';
  const rawPath = process.env.LXC_VNC_BRIDGE_WS_PATH?.trim() || '';

  if (scheme !== 'ws' && scheme !== 'wss') {
    throw new Error('LXC_VNC_BRIDGE_WS_SCHEME must be ws or wss');
  }

  if (!/^\d+$/.test(port)) {
    throw new Error('LXC_VNC_BRIDGE_WS_PORT must be numeric');
  }

  const path = rawPath.length > 0 ? (rawPath.startsWith('/') ? rawPath : `/${rawPath}`) : '';
  return `${scheme}://${ipv4}:${port}${path}`;
};

const summarizeError = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  return String(err);
};

const createClient = async (): Promise<Client> => {
  const baseUrl = process.env.PVE_BASE_URL;
  const apiToken = process.env.PVE_API_TOKEN?.trim() || undefined;
  const username = process.env.PVE_USERNAME?.trim() || undefined;
  const password = process.env.PVE_PASSWORD?.trim() || undefined;
  const realm = process.env.PVE_REALM?.trim() || 'pam';
  const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

  if (!baseUrl) throw new Error('PVE_BASE_URL not configured');

  const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

  if (apiToken) {
    return new Client({ baseUrl, apiToken, agent });
  }

  if (username && password) {
    const client = new Client({ baseUrl, username, password, realm, agent });
    await client.login();
    return client;
  }

  throw new Error('No Proxmox credentials configured');
};

export const load: PageServerLoad = async ({ url }) => {
  const vmidStr = url.searchParams.get('vmid');
  const node = url.searchParams.get('node');
  const type = url.searchParams.get('type');
  const name = url.searchParams.get('name');
  const knownIp = url.searchParams.get('ip')?.trim();

  if (!vmidStr || !node || (type !== 'vm' && type !== 'container')) {
    error(400, 'Missing or invalid vmid, node, or type query parameters');
  }

  const vmid = parseInt(vmidStr, 10);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    error(400, `Invalid vmid: ${JSON.stringify(vmidStr)}`);
  }

  const bridgeTemplate = process.env.LXC_VNC_BRIDGE_WS_URL?.trim();
  const deriveBridgeFromIpv4 = process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 === 'true';

  // VMs always use native Proxmox VNC (vncproxy). Containers always use bridge
  // mode (websockify on the guest). There is no cross-fallback between modes.
  if (type === 'vm') {
    return await nativeProxmoxVnc(vmid, node, name, type);
  }

  // Container (LXC) — bridge mode only
  if (!bridgeTemplate && !deriveBridgeFromIpv4) {
    error(
      503,
      `Bridge mode is not configured for container VNC (set LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 or LXC_VNC_BRIDGE_WS_URL).`
    );
  }

  return await lxcBridgeVnc(vmid, node, name, type, knownIp, bridgeTemplate, deriveBridgeFromIpv4);

  // -- helpers --

  async function nativeProxmoxVnc(
    vmid: number, node: string, name: string | null | undefined, type: string
  ): Promise<ReturnType<typeof load>> {
    let info: Awaited<ReturnType<ReturnType<Client['helpers']['display']>['getConnectionInfo']>>;
  try {
    // noVNC must answer the RFB password challenge with the temporary ticket
    // password generated by Proxmox vncproxy, not the account/root password.
    const client = await createClient();
    const display = client.helpers.display(vmid);
    info = await display.getConnectionInfo();
  } catch (err) {
    console.error('[vnc-page] Failed to prepare VNC connection info:', err);
    error(503, 'Unable to prepare VNC session. Please verify VM state and Proxmox credentials.');
  }

  const vncPassword = info.ticket.password ?? info.ticket.ticket;

  return {
    vmid,
    node,
    type,
    name: name?.trim() || null,
    upstreamWsUrl: info.websocketUrl,
    vncPassword,
    vncUsername: info.ticket.user,
  };
};
