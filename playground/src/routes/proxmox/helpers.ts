/**
 * Utility helpers for the Proxmox admin page.
 *
 * Provides constants, timing helpers, value coercion, IPv4 address extraction,
 * guest-agent error detection, and environment-configuration readers.
 * Import-only types from `./types.js` and shared state (retry maps) used by
 * both `loadData.ts` and `actions.ts`.
 */

import type { LxcInterface, Workload } from './types.js';

// ---------------------------------------------------------------------------
// Constants & shared maps
// ---------------------------------------------------------------------------

export const PROXMOX_REQUEST_TIMEOUT_MS = 8000;
/**
 * Deployment lock — imported by both `proxmox-actions.ts` (acquire) and
 * `action-template-deployers.ts` (release).  Singleton across the server
 * process so concurrent form submissions hit the same gate.
 */
export const PROFILE_PROXMOX_LOAD = process.env.PLAYGROUND_PROFILE_LOAD === 'true';
export const VM_AGENT_RETRY_DELAY_MS = 60_000;

// Track transient VM guest-agent failures to avoid logging the same expected
// error on every refresh cycle.
export const vmAgentRetryAfterById = new Map<number, number>();

// Track newly deployed VMs (deployed with DHCP) so we can convert their first
// discovered DHCP IP to a static IP on the next page load after guest agent reports it.
export const pendingStaticConversion = new Map<number, { name: string; node: string }>();

// Track workloads currently being destroyed (stop+delete running in background).
// Each entry is tracked until the workload disappears from the Proxmox API.
// If the workload persists beyond DESTROY_STALE_THRESHOLD_MS, it is marked as failed.
export const DESTROY_STALE_THRESHOLD_MS = 60_000;
export const pendingDestroy = new Map<number, {
  type: 'vm' | 'container';
  name: string;
  node: string;
  startedAt: number;
  // UPID of the Proxmox delete task (set once the delete API call starts)
  destroyUpid?: string;
  // Actual error message if the background task fails
  error?: string;
  failedReason?: string;
}>();

/** Clears a failed destroy entry so the user can retry the operation. */
export function clearPendingDestroy(id: number): void {
  pendingDestroy.delete(id);
}

// ---------------------------------------------------------------------------
// Deploy concurrency guardrail
// ---------------------------------------------------------------------------

// Deploy concurrency guardrail — prevents simultaneous deployments that crash
// the dev server.  A singleton lock ensures only one deploy (VM or LXC) runs
// at a time across all server requests.

const DEPLOY_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — matches client hard cap

interface DeployLock {
  kind: 'vm' | 'lxc';
  name: string;
  startedAt: number;
}

let pendingDeployLock: DeployLock | null = null;

/**
 * Acquires the deployment lock. Returns `null` if deployment can proceed,
 * or an error message if a deploy is already in progress.
 */
export function acquireDeployLock(kind: 'vm' | 'lxc', name: string): string | null {
  if (pendingDeployLock !== null) {
    const elapsed = Date.now() - pendingDeployLock.startedAt;
    if (elapsed > DEPLOY_LOCK_TIMEOUT_MS) {
      // Lock expired — stale deploy, force-clear
      console.warn(
        `[proxmox] Deploy lock expired after ${(elapsed / 1000 / 60).toFixed(1)}m ` +
        `for ${pendingDeployLock.kind} "${pendingDeployLock.name}" — releasing`,
      );
      pendingDeployLock = null;
      return acquireDeployLock(kind, name); // retry
    }
    return `Deployment already in progress for "${pendingDeployLock.name}" (${pendingDeployLock.kind}). ` +
      `Please wait for it to complete before starting another.`;
  }
  pendingDeployLock = { kind, name, startedAt: Date.now() };
  return null;
}

/** Releases the deployment lock after deploy completes or fails. Idempotent. */
export function releaseDeployLock(kind: 'vm' | 'lxc', name: string): void {
  if (pendingDeployLock !== null && pendingDeployLock.kind === kind && pendingDeployLock.name === name) {
    const elapsed = Date.now() - pendingDeployLock.startedAt;
    console.info(
      `[proxmox] Deploy lock released for ${kind} "${name}" after ${(elapsed / 1000).toFixed(1)}s`,
    );
    pendingDeployLock = null;
  }
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** High-resolution monotonic clock in milliseconds (process.hrtime). */
export const nowMs = (): number => Number(process.hrtime.bigint()) / 1_000_000;

export const logLoadTiming = (stage: string, startedAt: number, details?: string): void => {
  if (!PROFILE_PROXMOX_LOAD) return;

  const elapsedMs = (nowMs() - startedAt).toFixed(1);
  console.info(`[proxmox][timing] ${stage}=${elapsedMs}ms${details ? ` ${details}` : ''}`);
};

export const isGuestGuiBridgeConfigured = (): boolean =>
  Boolean(process.env.LXC_VNC_BRIDGE_WS_URL?.trim()) ||
  process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 === 'true';

// ---------------------------------------------------------------------------
// Comparisons & coercion
// ---------------------------------------------------------------------------

/** Case-insensitive alphabetical comparator for workloads, used when sorting VM/container lists. */
export const compareByName = (left: Workload, right: Workload): number => {
  const leftName = (left.name ?? '').toString().toLowerCase();
  const rightName = (right.name ?? '').toString().toLowerCase();

  if (leftName === rightName) {
    return 0;
  }

  return leftName < rightName ? -1 : 1;
};

export const toPositiveNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number(value.trim()) : NaN);

  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

export const toNonNegativeNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number(value.trim()) : NaN);

  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
};

// ---------------------------------------------------------------------------
// IPv4 helpers
// ---------------------------------------------------------------------------

export const isIPv4Address = (value: string): boolean => {
  const parts = value.split('.');
  if (parts.length !== 4) return false;

  for (const part of parts) {
    if (!/^\d+$/.test(part)) return false;
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return false;
  }

  return true;
};

export const extractPrimaryContainerIPv4 = (interfaces: LxcInterface[]): string | undefined => {
  // Prefer explicit ip-addresses IPv4 entries, then inet fallback, while
  // skipping loopback and link-local addresses.
  for (const iface of interfaces) {
    const ipAddresses = Array.isArray(iface['ip-addresses']) ? iface['ip-addresses'] : [];
    for (const ipAddress of ipAddresses) {
      const value = ipAddress['ip-address'];
      if (typeof value !== 'string' || !isIPv4Address(value)) continue;
      if (value.startsWith('127.') || value.startsWith('169.254.')) continue;
      return value;
    }
  }

  for (const iface of interfaces) {
    const fallback = iface.inet;
    if (typeof fallback !== 'string' || !isIPv4Address(fallback)) continue;
    if (fallback.startsWith('127.') || fallback.startsWith('169.254.')) continue;
    return fallback;
  }

  return undefined;
};

export const extractPrimaryGuestIPv4WithPrefix = (
  interfaces: Array<{ inet?: string; 'ip-addresses'?: LxcInterface['ip-addresses'] }>
): { ip: string; cidr: string } | undefined => {
  for (const iface of interfaces) {
    const ipAddresses = Array.isArray(iface['ip-addresses']) ? iface['ip-addresses'] : [];
    for (const ipAddress of ipAddresses) {
      const value = ipAddress['ip-address'];
      if (typeof value !== 'string' || !isIPv4Address(value)) continue;
      if (value.startsWith('127.') || value.startsWith('169.254.')) continue;
      const prefix = ipAddress.prefix;
      const cidr = typeof prefix === 'number' ? String(prefix) : '24';
      return { ip: value, cidr };
    }
  }

  for (const iface of interfaces) {
    const fallback = iface.inet;
    if (typeof fallback !== 'string' || !isIPv4Address(fallback)) continue;
    if (fallback.startsWith('127.') || fallback.startsWith('169.254.')) continue;
    return { ip: fallback, cidr: '24' };
  }

  return undefined;
};

export const extractPrimaryGuestIPv4 = (
  interfaces: Array<{ inet?: string; 'ip-addresses'?: LxcInterface['ip-addresses'] }>
): string | undefined => {
  for (const iface of interfaces) {
    const ipAddresses = Array.isArray(iface['ip-addresses']) ? iface['ip-addresses'] : [];
    for (const ipAddress of ipAddresses) {
      const value = ipAddress['ip-address'];
      if (typeof value !== 'string' || !isIPv4Address(value)) continue;
      if (value.startsWith('127.') || value.startsWith('169.254.')) continue;
      return value;
    }
  }

  for (const iface of interfaces) {
    const fallback = iface.inet;
    if (typeof fallback !== 'string' || !isIPv4Address(fallback)) continue;
    if (fallback.startsWith('127.') || fallback.startsWith('169.254.')) continue;
    return fallback;
  }

  return undefined;
};

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) {
    const stack = typeof err.stack === 'string' ? err.stack : '';
    return `${err.message}\n${stack}`;
  }

  const asString = String(err);
  let serialized = '';
  try {
    serialized = JSON.stringify(err);
  } catch {
    // Ignore serialization errors and fall back to String(err).
  }

  return `${asString}\n${serialized}`;
};

export const isGuestAgentUnavailableError = (err: unknown): boolean => {
  const message = getErrorMessage(err).toLowerCase();
  return /qemu guest agent is not running|guest agent is not running|qga command failed|http\s*500.*guest agent/i.test(message);
};

// ---------------------------------------------------------------------------
// Promise helpers
// ---------------------------------------------------------------------------

/** Races a promise against a timeout, rejecting with `message` if exceeded. */
export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
};

// ---------------------------------------------------------------------------
// Environment configuration readers
// ---------------------------------------------------------------------------

/** Reads the preferred Proxmox node name from the PVE_NODE environment variable. */
export const getConfiguredNodeName = (): string | undefined => {
  const node = process.env.PVE_NODE?.trim();
  return node ? node : undefined;
};

export const getRefreshIntervalSeconds = (): number => {
  const raw = process.env.PLAYGROUND_REFRESH_INTERVAL_SECONDS?.trim();
  if (!raw) return 5;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 5;

  const normalized = Math.floor(parsed);
  if (normalized < 5) return 5;
  if (normalized > 3600) return 3600;
  return normalized;
};

/**
 * Extracts the hostname from PVE_BASE_URL for display.
 * We keep this tolerant because operators often use non-URL placeholders in local dev.
 */
export const getApiHost = (): string => {
  const baseUrl = process.env.PVE_BASE_URL;
  if (!baseUrl) return 'unknown';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

// ---------------------------------------------------------------------------
// pve-client factory
// ---------------------------------------------------------------------------

import { Client } from 'pve-client';
import { Agent } from 'node:https';

/** Creates an authenticated pve-client instance from environment variables. */
export const createClient = async (): Promise<Client> => {
  const baseUrl = process.env.PVE_BASE_URL;
  const apiToken = process.env.PVE_API_TOKEN;
  const username = process.env.PVE_USERNAME;
  const password = process.env.PVE_PASSWORD;
  const realm = process.env.PVE_REALM ?? 'pam';
  const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

  if (!baseUrl) throw new Error('Missing PVE_BASE_URL');

  const resolvedBaseUrl = baseUrl.trim();

  const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

  if (apiToken) {
    return new Client({ baseUrl: resolvedBaseUrl, apiToken, agent });
  }

  if (username && password) {
    const client = new Client({ baseUrl: resolvedBaseUrl, username, password, realm, agent });
    await client.login();
    return client;
  }

  throw new Error('Provide PVE_API_TOKEN or PVE_USERNAME and PVE_PASSWORD');
};

// ---------------------------------------------------------------------------
// VNC bridge URL builders
// ---------------------------------------------------------------------------

/**
 * Build a bridge websocket URL for LXC GUI sessions from an operator-provided
 * template. Supports {node}, {vmid}, and {ip}/{ipv4} placeholders.
 */
export const resolveLxcBridgeWsUrl = (
  template: string, node: string, vmid: number, ipv4?: string
): string => {
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

/** Build a bridge websocket URL from a resolved IPv4 address and env vars. */
export const buildBridgeWsUrlFromIpv4 = (ipv4: string): string => {
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
