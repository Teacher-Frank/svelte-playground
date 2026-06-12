import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import type { NodeScopedAPI } from 'pve-client';
import { Agent } from 'node:https';

/** The kind of Proxmox guest workload: a QEMU virtual machine or an LXC container. */
export type WorkloadKind = 'vm' | 'container';
/** A power-control action that can be applied to a workload. */
export type WorkloadAction = 'start' | 'stop' | 'restart';

const PROXMOX_REQUEST_TIMEOUT_MS = 8000;
const PROFILE_PROXMOX_LOAD = process.env.PLAYGROUND_PROFILE_LOAD === 'true';
const VM_AGENT_RETRY_DELAY_MS = 60_000;

// Track transient VM guest-agent failures to avoid logging the same expected
// error on every refresh cycle.
const vmAgentRetryAfterById = new Map<number, number>();

// Track newly deployed VMs (deployed with DHCP) so we can convert their first
// discovered DHCP IP to a static IP on the next page load after guest agent reports it.
const pendingStaticConversion = new Map<number, { name: string; node: string }>();

const nowMs = (): number => Number(process.hrtime.bigint()) / 1_000_000;

const logLoadTiming = (stage: string, startedAt: number, details?: string): void => {
  if (!PROFILE_PROXMOX_LOAD) return;

  const elapsedMs = (nowMs() - startedAt).toFixed(1);
  console.info(`[proxmox][timing] ${stage}=${elapsedMs}ms${details ? ` ${details}` : ''}`);
};

const isGuestGuiBridgeConfigured = (): boolean =>
  Boolean(process.env.LXC_VNC_BRIDGE_WS_URL?.trim()) ||
  process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 === 'true';

/** A Proxmox guest workload (VM or LXC container) as returned by the API list endpoints. */
export type Workload = {
  /** Numeric or string VMID / container ID. */
  id?: number | string;
  /** Human-readable name of the workload. */
  name?: string;
  /** Name of the cluster node that owns this workload. */
  node?: string;
  /** Current power status (e.g. `"running"`, `"stopped"`). */
  status?: string;
  /** Seconds the workload has been running, or `0` when stopped. */
  uptime?: number;
  /** Primary IPv4 address discovered from guest interfaces, when available. */
  primaryIp?: string;
  /** Configured CPU limit for containers, when available from API payloads. */
  cpulimit?: number;
  /** Configured memory limit for containers, in bytes when available. */
  memorylimit?: number;
  /** Host CPU core count for the workload node. */
  hostMaxCpu?: number;
  /** Host memory capacity (bytes) for the workload node. */
  hostMaxMemory?: number;
  /** Host storage capacity (bytes) for the workload node. */
  hostMaxStorage?: number;
  /** Currently available host storage (bytes) for the workload node. */
  hostAvailableStorage?: number;
};

type LxcIpAddress = {
  'ip-address'?: string;
  'ip-address-type'?: string;
  prefix?: number;
};

type LxcInterface = {
  inet?: string;
  'ip-addresses'?: LxcIpAddress[];
  name?: string;
};

type VmAgentInterface = {
  name?: string;
  'ip-addresses'?: LxcIpAddress[];
};

/** A Proxmox cluster node as returned by the `/nodes` API endpoint. */
export type ClusterNode = {
  /** Node hostname. */
  node?: string;
  /** Node availability status (e.g. `"online"`, `"offline"`). */
  status?: string;
  /** Host CPU core count. */
  maxcpu?: number;
  /** Host memory capacity in bytes. */
  maxmem?: number;
  /** Host storage capacity in bytes. */
  maxdisk?: number;
  /** Host storage currently used in bytes. */
  disk?: number;
};

/** Case-insensitive alphabetical comparator for workloads, used when sorting VM/container lists. */
const compareByName = (left: Workload, right: Workload): number => {
  const leftName = (left.name ?? '').toString().toLowerCase();
  const rightName = (right.name ?? '').toString().toLowerCase();

  if (leftName === rightName) {
    return 0;
  }

  return leftName < rightName ? -1 : 1;
};

const toPositiveNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number(value.trim()) : NaN);

  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
};

const toNonNegativeNumber = (value: unknown): number | undefined => {
  const parsed =
    typeof value === 'number'
      ? value
      : (typeof value === 'string' ? Number(value.trim()) : NaN);

  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return parsed;
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

const extractPrimaryGuestIPv4WithPrefix = (
  interfaces: Array<{ inet?: string; 'ip-addresses'?: LxcIpAddress[] }>
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

const extractPrimaryGuestIPv4 = (
  interfaces: Array<{ inet?: string; 'ip-addresses'?: LxcIpAddress[] }>
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

const getErrorMessage = (err: unknown): string => {
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

const isGuestAgentUnavailableError = (err: unknown): boolean => {
  const message = getErrorMessage(err).toLowerCase();
  return /qemu guest agent is not running|guest agent is not running|qga command failed|http\s*500.*guest agent/i.test(message);
};

/** An LXC container template available in Proxmox storage. */
export type LxcTemplate = {
  /** Storage pool that holds the template. */
  storage: string;
  /** Full volume identifier (e.g. `local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`). */
  volid: string;
  /** Archive format of the template image. */
  format: string;
  /** Uncompressed template size in bytes. */
  size: number;
  /** Content type tag (typically `"vztmpl"`). */
  content: string;
  /** Optional human-readable notes stored with the template. */
  notes?: string;
  /** Parent snapshot identifier, if applicable. */
  parent?: string;
  /** Creation timestamp (Unix epoch seconds). */
  ctime?: number;
  /** Disk space currently used by the template in bytes. */
  used?: number;
  /** VMID of a running container derived from this template, if any. */
  vmid?: number;
};

/** A single entry from the Proxmox task log. */
export type RecentTask = {
  /** Short task identifier. */
  id: string;
  /** Node that executed the task. */
  node: string;
  /** Task start time (Unix epoch seconds). */
  starttime: number;
  /** Task end time (Unix epoch seconds), absent while the task is still running. */
  endtime?: number;
  /** Final status string (e.g. `"OK"`) once the task has finished. */
  status?: string;
  /** Task type key (e.g. `"qmstart"`, `"vzstop"`). */
  type: string;
  /** User that triggered the task. */
  user: string;
  /** Unique Process ID string used by Proxmox to track the task. */
  upid: string;
};

/**
 * Aggregated data returned by {@link load} to the SvelteKit page.
 * When the Proxmox API is unreachable, all list fields are empty and
 * `serverStatus` is `"unavailable"`.
 */
export type ProxmoxResults = {
  /** Hostname extracted from `PVE_BASE_URL` for display purposes. */
  apiHost: string;
  /** Value of the `PVE_NODE` environment variable (may be `"unknown"`). */
  configuredNode: string;
  /** `true` when `configuredNode` matches an online cluster node. */
  configuredNodeExists: boolean;
  /** Hostname of the cluster node actually used for API calls. */
  serverNode: string;
  /** Whether guest GUI/VNC access is configured via an external bridge (for containers and VMs). */
  guestGuiBridgeSupported: boolean;
  /** Human-readable server availability string (e.g. `"online"`, `"unavailable"`). */
  serverStatus: string;
  /** Default auto-refresh interval for the admin page (seconds). */
  refreshIntervalSeconds: number;
  /** Timestamp of the most recent successful data refresh, or `null` on first failure. */
  lastSuccessfulRefresh: number | null;
  /** Raw node list from the Proxmox `/nodes` endpoint. */
  nodes: unknown;
  /** Raw version object from the Proxmox `/version` endpoint. */
  version: unknown;
  /** Raw cluster status object from the Proxmox `/cluster/status` endpoint. */
  cluster: unknown;
  /** Sorted list of QEMU virtual machines across all nodes. */
  vms: Workload[];
  /** Sorted list of LXC containers across all nodes. */
  containers: Workload[];
  /** Available LXC container templates found in storage. */
  lxcTemplates: LxcTemplate[];
  /** Most-recent task log entries from the cluster. */
  recentTasks: RecentTask[];
  /** Server-generated notifications (e.g., DHCP→static IP conversions) for one-time display. */
  notifications: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Races a promise against a timeout, rejecting with `message` if exceeded. */
const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
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

/** Reads the preferred Proxmox node name from the PVE_NODE environment variable. */
const getConfiguredNodeName = (): string | undefined => {
  const node = process.env.PVE_NODE?.trim();
  return node ? node : undefined;
};

const getRefreshIntervalSeconds = (): number => {
  const raw = process.env.PLAYGROUND_REFRESH_INTERVAL_SECONDS?.trim();
  if (!raw) return 5;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return 5;

  const normalized = Math.floor(parsed);
  if (normalized < 1) return 1;
  if (normalized > 3600) return 3600;
  return normalized;
};

/**
 * Extracts the hostname from PVE_BASE_URL for display.
 * We keep this tolerant because operators often use non-URL placeholders in local dev.
 */
const getApiHost = (): string => {
  const baseUrl = process.env.PVE_BASE_URL;
  if (!baseUrl) return 'unknown';
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

// ---------------------------------------------------------------------------
// Proxmox client
// ---------------------------------------------------------------------------

/** Creates an authenticated pve-client instance from environment variables. */
const createClient = async (): Promise<Client> => {
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
// Node resolution
// ---------------------------------------------------------------------------

type ResolvedNodeContext = {
  configuredNodeExists: boolean;
  node: string;
};

/**
 * Resolves which cluster node to use. Prefers the configured node if it exists
 * in the cluster; falls back to the first node with a valid name.
 */
const resolveNodeContext = (nodes: ClusterNode[], preferredNode?: string): ResolvedNodeContext => {
  const configuredNodeExists = !!preferredNode && nodes.some((entry) => entry.node === preferredNode);
  if (configuredNodeExists && preferredNode) {
    return { configuredNodeExists: true, node: preferredNode };
  }

  const firstNode = nodes.find((entry) => typeof entry.node === 'string')?.node;
  if (firstNode) {
    return { configuredNodeExists, node: firstNode };
  }

  throw new Error(
    `Could not resolve any Proxmox node: found ${nodes.length} node(s) but none had a valid node name. ` +
    `First 3 nodes: ${JSON.stringify(nodes.slice(0, 3))}`
  );
};

let hasLoggedHost = false;

/** Returns a stub result used when the Proxmox API is unreachable. */
const buildUnavailableResults = (): ProxmoxResults => {
  const configuredNode = getConfiguredNodeName();
  return {
    apiHost: getApiHost(),
    configuredNode: configuredNode ?? 'unset',
    configuredNodeExists: false,
    serverNode: configuredNode ?? 'unknown',
    guestGuiBridgeSupported: isGuestGuiBridgeConfigured(),
    serverStatus: 'offline',
    refreshIntervalSeconds: getRefreshIntervalSeconds(),
    lastSuccessfulRefresh: null,
    nodes: [],
    version: null,
    cluster: null,
    vms: [],
    containers: [],
    lxcTemplates: [],
    recentTasks: [],
    notifications: []
  };
};

const listLxcTemplates = async (nodeApi: NodeScopedAPI): Promise<LxcTemplate[]> => {
  let storages: Array<Record<string, unknown>>;
  try {
    storages = await nodeApi.storage.list() as Array<Record<string, unknown>>;
  } catch (err) {
    console.error('[proxmox] Failed to list storages:', err);
    return [];
  }

  const storageNames = storages
    .map((storage) => (typeof storage.storage === 'string' ? storage.storage : undefined))
    .filter((storageName): storageName is string => Boolean(storageName));

  if (storageNames.length === 0) {
    return [];
  }

  const templateGroups = await Promise.all(
    storageNames.map(async (storageName): Promise<LxcTemplate[]> => {
      const contentApi = nodeApi.storage.get(storageName).content;
      if (!contentApi || typeof contentApi.list !== 'function') {
        return [];
      }

      try {
        const contentList = await contentApi.list({ $query: { content: 'vztmpl' } });
        if (!Array.isArray(contentList)) {
          return [];
        }

        return (contentList as unknown[]).flatMap((entry) => {
          if (!entry || typeof entry !== 'object') {
            return [];
          }

          const record = entry as Record<string, unknown>;
          if (record.content !== 'vztmpl') {
            return [];
          }

          return [{ ...record, storage: storageName } as LxcTemplate];
        });
      } catch (err) {
        console.error(`[proxmox] Failed to list content for storage ${storageName}:`, err);
        return [];
      }
    })
  );

  return templateGroups.flat();
};

/** Loads all Proxmox data needed by the page. Errors in individual sections are logged but do not abort the load. */
const loadResults = async (): Promise<ProxmoxResults> => {
  const loadStartedAt = nowMs();

  // --- Connect and fetch top-level cluster data ---
  let nodes, version, cluster;
  let client: Client;
  const connectStartedAt = nowMs();
  try {
    client = await createClient();
    [nodes, version, cluster] = await Promise.all([
      client.api.nodes.list(),
      client.api.version.version(),
      client.api.cluster.status(),
    ]);
    logLoadTiming('connect_and_cluster_fetch', connectStartedAt);
  } catch (err) {
    console.error('[proxmox] Connection/auth error:', err);
    return buildUnavailableResults();
  }

  let clusterNodes: ClusterNode[];
  try {
    clusterNodes = (nodes as Array<Record<string, unknown>>).map((entry) => ({
      node: typeof entry.node === 'string' ? entry.node : undefined,
      status: typeof entry.status === 'string' ? entry.status : undefined,
      maxcpu: toPositiveNumber(entry.maxcpu),
      maxmem: toPositiveNumber(entry.maxmem),
      maxdisk: toPositiveNumber(entry.maxdisk),
      disk: toNonNegativeNumber(entry.disk),
    }));
  } catch (err) {
    console.error('[proxmox] Failed to parse cluster nodes:', err);
    return buildUnavailableResults();
  }

  let node = '';
  let configuredNodeExists;
  try {
    const resolved = resolveNodeContext(clusterNodes, getConfiguredNodeName());
    node = resolved.node;
    configuredNodeExists = resolved.configuredNodeExists;
  } catch (err) {
    console.error('[proxmox] Failed to resolve node context:', err);
    return buildUnavailableResults();
  }

  let nodeApi: NodeScopedAPI;
  try {
    // Reuse the existing authenticated client rather than creating a new one.
    nodeApi = client.api.nodes.get(node);
  } catch (err) {
    console.error('[proxmox] Failed to get node API:', err);
    return buildUnavailableResults();
  }

  if (!hasLoggedHost) {
    hasLoggedHost = true;
    console.info(
      `[proxmox] baseUrl=${process.env.PVE_BASE_URL ?? 'unset'} apiHost=${getApiHost()} ` +
      `configuredNode=${getConfiguredNodeName() ?? 'unset'} resolvedNode=${node}`
    );
  }

  // --- Load node-level data (errors are logged but do not abort the load) ---
  const containerPrimaryIpById = new Map<number, string>();
  const vmPrimaryIpById = new Map<number, string>();
  const nodeDataStartedAt = nowMs();
  const [lxcTemplates, vmsRaw, containersRaw, tasksRaw] = await Promise.all([
    listLxcTemplates(nodeApi),
    nodeApi.qemu.list().catch((err: unknown) => {
      console.error('[proxmox] Failed to list VMs:', err);
      return [] as Workload[];
    }),
    nodeApi.lxc.list().catch((err: unknown) => {
      console.error('[proxmox] Failed to list containers:', err);
      return [] as Workload[];
    }),
    nodeApi.tasks.list({ $query: { limit: 10, source: 'all' } }).catch((err: unknown) => {
      console.error('[proxmox] Failed to list tasks:', err);
      return [] as Array<Record<string, unknown>>;
    }),
  ]);
  logLoadTiming('node_parallel_fetch', nodeDataStartedAt);

  const vms = vmsRaw as Workload[];
  const containers = containersRaw as Workload[];
  const tasks = tasksRaw as Array<Record<string, unknown>>;

  const runningContainerIds = (containers as Array<Record<string, unknown>>)
    .filter((container) => container.status === 'running')
    .map((container) => Number(container.vmid))
    .filter((vmid) => Number.isInteger(vmid) && vmid > 0);

  const runningVmIds = (vms as Array<Record<string, unknown>>)
    .filter((vm) => vm.status === 'running')
    .map((vm) => Number(vm.vmid))
    .filter((vmid) => Number.isInteger(vmid) && vmid > 0);

  if (runningContainerIds.length > 0) {
    const containerIpFetchStartedAt = nowMs();
    await Promise.all(
      runningContainerIds.map(async (vmid) => {
        try {
          const interfaces = await nodeApi.lxc.id(vmid).interfaces() as LxcInterface[];
          const primaryIp = extractPrimaryContainerIPv4(interfaces);
          if (primaryIp) {
            containerPrimaryIpById.set(vmid, primaryIp);
          }
        } catch (err) {
          console.warn(`[proxmox] Failed to query interfaces for container ${vmid}:`, err);
        }
      })
    );
    logLoadTiming('container_ip_fetch', containerIpFetchStartedAt, `count=${runningContainerIds.length}`);
  }

  // Placeholder for notifications generated during page load (e.g., IP converted to static).
  let notifications: string[] = [];

  if (runningVmIds.length > 0) {
    const vmIpFetchStartedAt = nowMs();
    await Promise.all(
      runningVmIds.map(async (vmid) => {
        const retryAfter = vmAgentRetryAfterById.get(vmid);
        if (typeof retryAfter === 'number' && retryAfter > Date.now()) {
          return;
        }

        try {
          const agentData = await client.request('/nodes/{node}/qemu/{vmid}/agent/network-get-interfaces', 'GET', {
            $path: { node, vmid },
          }) as { result?: VmAgentInterface[] } | VmAgentInterface[];

          const interfaces = Array.isArray(agentData)
            ? agentData
            : (Array.isArray(agentData.result) ? agentData.result : []);

          const primaryIp = extractPrimaryGuestIPv4(interfaces);
          if (primaryIp) {
            vmPrimaryIpById.set(vmid, primaryIp);
            vmAgentRetryAfterById.delete(vmid);

            // Auto-convert DHCP IP to static for newly deployed VMs.
            const pendingEntry = pendingStaticConversion.get(vmid);
            if (pendingEntry) {
              try {
                const ipInfo = extractPrimaryGuestIPv4WithPrefix(interfaces);
                if (ipInfo) {
                  const staticConfig = `ip=${ipInfo.ip}/${ipInfo.cidr}`;
                  await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
                    $path: { node: pendingEntry.node, vmid },
                    $body: { ipconfig0: staticConfig },
                  });
                  notifications.push(`Converted VM ${pendingEntry.name} (${ipInfo.ip}/${ipInfo.cidr}) to static IP`);
                  console.info(
                    `[proxmox] Converted VM ${vmid} (${pendingEntry.name}) from DHCP to static IP ${ipInfo.ip}/${ipInfo.cidr}.`
                  );
                }
              } catch (err) {
                console.warn(`[proxmox] Failed to convert VM ${vmid} to static IP:`, err);
              } finally {
                pendingStaticConversion.delete(vmid);
              }
            }
          }
        } catch (err) {
          // QEMU guest agent can be unavailable on some VMs; avoid spamming logs
          // every refresh and retry after a short cooldown.
          if (isGuestAgentUnavailableError(err)) {
            const retryAfter = Date.now() + VM_AGENT_RETRY_DELAY_MS;
            vmAgentRetryAfterById.set(vmid, retryAfter);
            console.info(
              `[proxmox] Guest agent unavailable for VM ${vmid}; suppressing repeated checks for ${Math.round(VM_AGENT_RETRY_DELAY_MS / 1000)}s.`
            );
            return;
          }

          console.warn(`[proxmox] Failed to query guest interfaces for VM ${vmid}:`, err);
        }
      })
    );
    logLoadTiming('vm_ip_fetch', vmIpFetchStartedAt, `count=${runningVmIds.length}`);
  }

  const currentNode = clusterNodes.find((entry) => entry.node === node);
  const nodeCapacityByName = new Map<string, { maxcpu?: number; maxmem?: number; maxdisk?: number; availableStorage?: number }>(
    clusterNodes
      .filter((entry): entry is ClusterNode & { node: string } => typeof entry.node === 'string')
      .map((entry) => {
        const availableStorage =
          typeof entry.maxdisk === 'number' && typeof entry.disk === 'number'
            ? Math.max(0, entry.maxdisk - entry.disk)
            : undefined;

        return [
          entry.node,
          {
            maxcpu: entry.maxcpu,
            maxmem: entry.maxmem,
            maxdisk: entry.maxdisk,
            availableStorage,
          },
        ];
      })
  );
  const serverStatus = typeof currentNode?.status === 'string' ? currentNode.status : 'unknown';

  logLoadTiming(
    'load_results_total',
    loadStartedAt,
    `vms=${vms.length} containers=${containers.length} templates=${lxcTemplates.length} tasks=${tasks.length}`
  );

  return {
    apiHost: getApiHost(),
    configuredNode: getConfiguredNodeName() ?? 'unset',
    configuredNodeExists,
    serverNode: node,
    guestGuiBridgeSupported: isGuestGuiBridgeConfigured(),
    serverStatus,
    refreshIntervalSeconds: getRefreshIntervalSeconds(),
    lastSuccessfulRefresh: Date.now(),
    nodes,
    version,
    cluster,
    vms: (vms as Array<Record<string, unknown>>)
      // Ensure each VM has a node field and an id mapped from vmid.
      .map((vm) => {
        const resolvedNode = typeof vm.node === 'string' ? vm.node : node;
        const hostCapacity = nodeCapacityByName.get(resolvedNode);
        return {
          ...vm,
          node: resolvedNode,
          id: vm.vmid as number | string | undefined,
          cpulimit:
            toPositiveNumber(vm.cpulimit) ??
            toPositiveNumber(vm.cpus) ??
            toPositiveNumber(vm.maxcpu),
          memorylimit:
            toPositiveNumber(vm.memory) ??
            toPositiveNumber(vm.maxmem),
          primaryIp: Number.isInteger(vm.vmid)
            ? vmPrimaryIpById.get(vm.vmid as number)
            : undefined,
          hostMaxCpu: hostCapacity?.maxcpu,
          hostMaxMemory: hostCapacity?.maxmem,
          hostMaxStorage: hostCapacity?.maxdisk,
          hostAvailableStorage: hostCapacity?.availableStorage,
        };
      })
      .sort(compareByName) as Workload[],
    containers: (containers as Array<Record<string, unknown>>)
      // Ensure each container has a node field and an id mapped from vmid.
      .map((container) => {
        const resolvedNode = typeof container.node === 'string' ? container.node : node;
        const hostCapacity = nodeCapacityByName.get(resolvedNode);
        return {
          ...container,
          node: resolvedNode,
          id: container.vmid as number | string | undefined,
          cpulimit:
            toPositiveNumber(container.cpulimit) ??
            toPositiveNumber(container.maxcpu) ??
            toPositiveNumber(container.cpus),
          memorylimit:
            toPositiveNumber(container.memory) ?? toPositiveNumber(container.maxmem),
          hostMaxCpu: hostCapacity?.maxcpu,
          hostMaxMemory: hostCapacity?.maxmem,
          hostMaxStorage: hostCapacity?.maxdisk,
          hostAvailableStorage: hostCapacity?.availableStorage,
          primaryIp: Number.isInteger(container.vmid)
            ? containerPrimaryIpById.get(container.vmid as number)
            : undefined,
        };
      })
      .sort(compareByName) as Workload[],
    lxcTemplates,
    recentTasks: (tasks as Array<Record<string, unknown>>)
      // Normalise the raw task objects into the typed recentTasks shape.
      .map((task) => ({
        id: String(task.id ?? ''),
        node: String(task.node ?? node),
        starttime: Number(task.starttime ?? 0),
        endtime: typeof task.endtime === 'number' ? task.endtime : undefined,
        status: typeof task.status === 'string' ? task.status : undefined,
        type: String(task.type ?? ''),
        user: String(task.user ?? ''),
        upid: String(task.upid ?? '')
      }))
      .sort((a, b) => b.starttime - a.starttime) // most-recent first
      .slice(0, 10),
    notifications
  };
};

// ---------------------------------------------------------------------------
// Form actions
// ---------------------------------------------------------------------------

/** Validates and parses a workload control form submission. */
const parseWorkloadSubmission = (formData: FormData): { type: WorkloadKind; id: number; name: string; node: string; status?: string } => {
  const type = formData.get('type');
  const idValue = formData.get('id');
  const name = formData.get('name');
  const nodeValue = formData.get('node');
  const status = formData.get('status');

  if (type !== 'vm' && type !== 'container') {
    throw new Error(`Select a virtual machine or container first. Got type=${JSON.stringify(type)}`);
  }

  if (typeof idValue !== 'string' || idValue.length === 0) {
    throw new Error(`Missing workload ID. Form data id=${JSON.stringify(idValue)}, type=${JSON.stringify(type)}`);
  }

  const id = Number(idValue);
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid workload ID: "${idValue}" is not an integer (parsed as ${id})`);
  }

  if (typeof nodeValue !== 'string' || nodeValue.trim().length === 0) {
    throw new Error(`Missing workload node: nodeValue=${JSON.stringify(nodeValue)}, type=${JSON.stringify(type)}, id=${idValue}`);
  }

  return {
    type,
    id,
    name: typeof name === 'string' ? name : '',
    node: nodeValue.trim(),
    status: typeof status === 'string' && status.trim().length > 0 ? status.trim() : undefined
  };
};

/** Permanently destroys a VM or LXC container via the Proxmox API. Returns the task UPID. */
const isRunningDestroyError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('running - destroy failed') || normalized.includes('is running');
};

const executeDestroyAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  workloadStatus?: string
): Promise<{ destroyUpid: string; stopUpid?: string }> => {
  const client = await createClient();
  const nodeApi = client.api.nodes.get(node);

  const shouldStop = workloadStatus === 'running';
  let stopUpid: string | undefined;

  const stopWorkload = async (): Promise<void> => {
    stopUpid = await (type === 'vm'
      ? nodeApi.qemu.vmid(id).status.stop()
      : nodeApi.lxc.id(id).status.stop()) as string;
    await client.task.wait(stopUpid);
  };

  if (shouldStop) {
    await stopWorkload();
  }

  const runDelete = async (): Promise<string> =>
    await (type === 'vm'
      ? nodeApi.qemu.vmid(id).delete({ $query: { purge: true } })
      : nodeApi.lxc.id(id).delete({ $query: { purge: true, force: true } })) as string;

  let destroyUpid: string;
  try {
    // Proxmox DELETE expects options in query params, not request body.
    destroyUpid = await runDelete();
  } catch (error) {
    if (!shouldStop && isRunningDestroyError(error)) {
      await stopWorkload();
      destroyUpid = await runDelete();
    } else {
      throw error;
    }
  }

  return { destroyUpid, stopUpid };
};

/**
 * Converts an LXC container into a template. If currently running, the
 * container is stopped first and the stop task is awaited.
 */
const executeConvertToTemplateAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  workloadStatus?: string
): Promise<{ convertUpid: string; stopUpid?: string }> => {
  const client = await createClient();
  const nodeApi = client.api.nodes.get(node);

  const shouldStop = workloadStatus === 'running';

  let stopUpid: string | undefined;
  if (shouldStop) {
    stopUpid = await (type === 'vm'
      ? nodeApi.qemu.vmid(id).status.stop()
      : nodeApi.lxc.id(id).status.stop()) as string;
    await client.task.wait(stopUpid);
  }

  const convertUpid = await client.request(
    type === 'vm' ? '/nodes/{node}/qemu/{vmid}/template' : '/nodes/{node}/lxc/{vmid}/template',
    'POST',
    {
      $path: { node, vmid: id },
    }
  ) as string;

  return { convertUpid, stopUpid };
};

/** Sends a start/stop/restart command to a VM or container via the Proxmox API. */
const executeWorkloadAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  action: WorkloadAction,
  workloadStatus?: string
): Promise<{ upid: string; effectiveAction: WorkloadAction | 'start' }> => {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(node);
  const status = type === 'vm'
    ? nodeApi.qemu.vmid(id).status
    : nodeApi.lxc.id(id).status;

  switch (action) {
    case 'start':
      return { upid: await status.start() as string, effectiveAction: 'start' };
    case 'stop':
      return { upid: await status.stop() as string, effectiveAction: 'stop' };
    case 'restart': {
      if (type === 'container' && workloadStatus !== 'running') {
        return { upid: await status.start() as string, effectiveAction: 'start' };
      }
      return { upid: await status.reboot() as string, effectiveAction: 'restart' };
    }
  }
};

const executeWorkloadConfigureAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  cpuSharePercent: number,
  memoryMiB: number,
  storageGiB?: number
): Promise<{ upid?: string; appliedCpuLimit: number; appliedMemoryMiB: number; appliedCpuCores?: number; appliedStorageGiB?: number; storageTaskUpid?: string }> => {
  const client = await createClient();

  const nodeStatus = await client.request('/nodes/{node}/status', 'GET', {
    $path: { node },
  }) as Record<string, unknown>;

  const cpuInfo = nodeStatus.cpuinfo as Record<string, unknown> | undefined;
  const hostCpuCount = toPositiveNumber(cpuInfo?.cpus);

  const memoryInfo = nodeStatus.memory as Record<string, unknown> | undefined;
  const hostMemoryBytes = toPositiveNumber(memoryInfo?.total);

  const rootfsInfo = nodeStatus.rootfs as Record<string, unknown> | undefined;
  const hostStorageTotalBytes = toPositiveNumber(rootfsInfo?.total);
  const hostStorageAvailableBytes = toNonNegativeNumber(rootfsInfo?.avail);

  if (!hostCpuCount || !hostMemoryBytes) {
    throw new Error(`Could not resolve host capacity for node ${node}.`);
  }

  if (!Number.isFinite(cpuSharePercent) || cpuSharePercent <= 0 || cpuSharePercent > 75) {
    throw new Error(`CPU share must be between 1 and 75 percent (got ${cpuSharePercent}).`);
  }

  const maxMemoryMiB = Math.floor((hostMemoryBytes * 0.75) / (1024 ** 2));
  if (!Number.isFinite(memoryMiB) || memoryMiB < 16 || memoryMiB > maxMemoryMiB) {
    throw new Error(`Memory must be between 16 and ${maxMemoryMiB} MiB (75% of host memory) (got ${memoryMiB} MiB).`);
  }

  const shouldResizeStorage = typeof storageGiB === 'number' && Number.isFinite(storageGiB) && storageGiB > 0;
  if (shouldResizeStorage) {
    if (!hostStorageTotalBytes || hostStorageAvailableBytes == null) {
      throw new Error(`Could not resolve host storage capacity for node ${node}.`);
    }

    const requestedStorageBytes = storageGiB * (1024 ** 3);
    if (requestedStorageBytes > hostStorageAvailableBytes) {
      const availableGiB = Math.floor(hostStorageAvailableBytes / (1024 ** 3));
      throw new Error(
        `Storage increase exceeds available node storage: requested +${storageGiB} GiB, available ${availableGiB} GiB on node ${node}.`
      );
    }
  }

  const appliedCpuLimit = Number(((hostCpuCount * cpuSharePercent) / 100).toFixed(2));
  const appliedMemoryMiB = Math.floor(memoryMiB);
  let storageTaskUpid: string | undefined;

  if (type === 'container') {
    const result = await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
      $path: { node, vmid: id },
      $body: {
        cpulimit: appliedCpuLimit,
        memory: appliedMemoryMiB,
      },
    });

    if (shouldResizeStorage) {
      const resizeResult = await client.request('/nodes/{node}/lxc/{vmid}/resize', 'PUT', {
        $path: { node, vmid: id },
        $body: {
          disk: 'rootfs',
          size: `+${Math.floor(storageGiB!)}G`,
        },
      });

      storageTaskUpid = typeof resizeResult === 'string' ? resizeResult : undefined;
    }

    return {
      upid: typeof result === 'string' ? result : undefined,
      appliedCpuLimit,
      appliedMemoryMiB,
      appliedStorageGiB: shouldResizeStorage ? Math.floor(storageGiB!) : undefined,
      storageTaskUpid,
    };
  }

  const appliedCpuCores = Math.max(1, Math.round((hostCpuCount * cpuSharePercent) / 100));
  const result = await client.request('/nodes/{node}/qemu/{vmid}/config', 'POST', {
    $path: { node, vmid: id },
    $body: {
      cores: appliedCpuCores,
      memory: String(appliedMemoryMiB),
    },
  });

  if (shouldResizeStorage) {
    const vmConfig = await client.request('/nodes/{node}/qemu/{vmid}/config', 'GET', {
      $path: { node, vmid: id },
    }) as Record<string, unknown>;

    const vmDiskKey = Object.keys(vmConfig)
      .find((key) => /^(scsi|virtio|sata|ide)\d+$/i.test(key) && typeof vmConfig[key] === 'string' && !String(vmConfig[key]).toLowerCase().includes('cloudinit'));

    if (!vmDiskKey) {
      throw new Error(`Unable to resolve a resizable VM disk for vmid ${id} on node ${node}.`);
    }

    const resizeResult = await client.request('/nodes/{node}/qemu/{vmid}/resize', 'PUT', {
      $path: { node, vmid: id },
      $body: {
        disk: vmDiskKey,
        size: `+${Math.floor(storageGiB!)}G`,
      },
    });

    storageTaskUpid = typeof resizeResult === 'string' ? resizeResult : undefined;
  }

  return {
    upid: typeof result === 'string' ? result : undefined,
    appliedCpuLimit,
    appliedMemoryMiB,
    appliedCpuCores,
    appliedStorageGiB: shouldResizeStorage ? Math.floor(storageGiB!) : undefined,
    storageTaskUpid,
  };
};

/** Builds a SvelteKit form action handler for a given workload action. */
const buildAction = (action: WorkloadAction) => {
  // Returns a request handler that parses the form, runs the action, and
  // returns a success or error result for the UI to display.
  return async ({ request }: RequestEvent) => {
    let selectedWorkload: { type: WorkloadKind; id: number; name?: string; node: string; status?: string } | undefined;

    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const { upid, effectiveAction } = await executeWorkloadAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        action,
        selectedWorkload.status
      );
      const actionLabel = effectiveAction === 'restart'
        ? 'Restarted'
        : effectiveAction === 'stop'
          ? 'Stopped'
          : 'Started';
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: `${actionLabel} ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''}.`,
        upid,
        workloadAction: effectiveAction,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type
      });
    }
  };
};

/**
 * Clones a QEMU VM template, applies cloud-init credentials, configures
 * guest agent installation on first boot, and starts the VM.
 */
const deployVmFromTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string,
  ciUser: string,
  ciPassword: string
): Promise<{ cloneUpid: string; startUpid: string }> => {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const cloudInitStorage = process.env.PVE_VM_CLOUDINIT_STORAGE?.trim() || 'local-lvm';
  const vmNetworkBridge = process.env.PVE_VM_NETWORK_BRIDGE?.trim() || 'vmbr0';
  const vmNetworkModel = process.env.PVE_VM_NETWORK_MODEL?.trim() || 'virtio';

  const hasTargetCloudInitVolume = async (vmid: number): Promise<boolean> => {
    try {
      const contentList = await nodeApi.storage.get(cloudInitStorage).content.list({
        $query: { vmid },
      }) as Array<{ volid?: string }>;

      return contentList.some((entry) => entry.volid === `${cloudInitStorage}:vm-${vmid}-cloudinit`);
    } catch (error) {
      console.warn(
        `[proxmox] Unable to verify cloud-init volume state for VM ${vmid} on storage ${cloudInitStorage}:`,
        error
      );
      return false;
    }
  };

  const isCloudInitCollisionError = async (vmid: number, error: unknown): Promise<boolean> => {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (!normalized.includes('lvcreate') || !normalized.includes('cloudinit') || !normalized.includes('already exists')) {
      return false;
    }

    return await hasTargetCloudInitVolume(vmid);
  };

  const newid = await client.api.cluster.nextid() as number;

  try {
    // Full clone — must complete before cloud-init config can be applied.
    const cloneUpid = await nodeApi.qemu.vmid(templateId).clone({
      $body: { newid, name: newName, full: true },
    }) as string;
    await client.task.wait(cloneUpid);

    const clonedConfig = await client.request('/nodes/{node}/qemu/{vmid}/config', 'GET', {
      $path: { node: templateNode, vmid: newid },
    }) as Record<string, unknown>;

    const diskKeyPattern = /^(ide|sata|scsi|virtio)\d+$/;
    const hasCloudInitDisk = Object.entries(clonedConfig).some(([key, value]) =>
      diskKeyPattern.test(key) && typeof value === 'string' && value.toLowerCase().includes('cloudinit')
    );
    const hasNetworkInterface = Object.entries(clonedConfig).some(([key, value]) =>
      /^net\d+$/.test(key) && typeof value === 'string' && value.trim().length > 0
    );
    const hasIpConfig0 = typeof clonedConfig.ipconfig0 === 'string' && clonedConfig.ipconfig0.trim().length > 0;
    if (hasCloudInitDisk) {
      console.info(
        `[proxmox] Cloned VM ${newid} already has a cloud-init disk; skipping ide2 reattach and only updating cloud-init credentials.`
      );
    }
    if (!hasNetworkInterface) {
      console.info(
        `[proxmox] Cloned VM ${newid} has no net* interface; adding net0=${vmNetworkModel},bridge=${vmNetworkBridge}.`
      );
    }
    if (!hasIpConfig0) {
      console.info(
        `[proxmox] Cloned VM ${newid} has no ipconfig0 cloud-init network setting; applying ipconfig0=ip=dhcp.`
      );
    }

    // Apply cloud-init user credentials to the cloned VM. Only attach ide2 when
    // the clone does not already contain a cloud-init disk from the template.
    const configBody: Record<string, unknown> = {
      ciuser: ciUser,
      cipassword: ciPassword,
    };
    if (!hasCloudInitDisk) {
      configBody.ide2 = `${cloudInitStorage}:cloudinit`;
    }
    if (!hasNetworkInterface) {
      configBody.net0 = `${vmNetworkModel},bridge=${vmNetworkBridge}`;
    }
    if (!hasIpConfig0) {
      configBody.ipconfig0 = 'ip=dhcp';
    }

    await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: templateNode, vmid: newid },
      $body: configBody,
    });

    // Configure cloud-init to install and enable the QEMU guest agent on first boot.
    // This ensures IP discovery, guest metrics, and graceful shutdown are available
    // without requiring a pre-configured template (Option A).
    await client.request('/nodes/{node}/qemu/{vmid}/cloudinit', 'PUT', {
      $path: { node: templateNode, vmid: newid },
      $body: {
        cicommand:
          'DEBIAN_FRONTEND=noninteractive apt-get update && apt-get install -y qemu-guest-agent && systemctl enable --now qemu-guest-agent',
      },
    });

    const startUpid = await nodeApi.qemu.vmid(newid).status.start() as string;

    // Queue this VM for DHCP → static conversion. The next pageServerLoad that
    // discovers a guest-agent IP will apply a static ipconfig0.
    pendingStaticConversion.set(newid, { name: newName, node: templateNode });

    return { cloneUpid, startUpid };
  } catch (error) {
    if (await isCloudInitCollisionError(newid, error)) {
      throw new Error(
        `Cloud-init LV collision while deploying VM (storage=${cloudInitStorage}, vmid=${newid}). ` +
        `The target cloud-init volume already exists for this VM ID. ` +
        `Please verify the cloud-init volume state with your administrator.`,
        { cause: error }
      );
    }

    throw error;
  }
};

/** Renames a QEMU template (or VM) by updating its config name. */
const renameVmTemplate = async (templateId: number, templateNode: string, newName: string): Promise<string | unknown> => {
  const client = await createClient();
  return await client.request('/nodes/{node}/qemu/{vmid}/config', 'POST', {
    $path: { node: templateNode, vmid: templateId },
    $body: { name: newName },
  });
};

/**
 * Returns an error message if the password is not strong enough, or `null` if it passes.
 * Rules: ≥12 chars, at least one uppercase, one lowercase, one digit, one special character.
 */
const validateStrongPassword = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length === 0) return 'Root password is required.';
  if (value.length < 12) return 'Root password must be at least 12 characters.';
  if (!/[A-Z]/.test(value)) return 'Root password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(value)) return 'Root password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(value)) return 'Root password must contain at least one digit.';
  if (!/[^A-Za-z0-9]/.test(value)) return 'Root password must contain at least one special character.';
  return null;
};

/**
 * Returns an error message if the name is not a valid Proxmox DNS name, or `null` if it passes.
 * Proxmox accepts labels (a-z, A-Z, 0-9, hyphens) separated by dots, each label ≤63 chars,
 * must start and end with alphanumeric, max 253 chars total.
 */
const validateProxmoxName = (value: string): string | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Name is required.';
  if (trimmed.length > 253) return `"${trimmed}" is too long (max 253 characters).`;
  const labelPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (!labelPattern.test(label)) {
      return `"${trimmed}" is not a valid name. Use only letters, digits, hyphens, and dots; each part must start and end with a letter or digit.`;
    }
  }
  return null;
};

/** Deploys a new LXC container from a storage template. Returns the task UPID. */
const isUbuntu2404Template = (templateVolid: string): boolean =>
  /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(templateVolid);

const cloneLxcTemplate = async (templateVolid: string, templateNode: string, newName: string, rootPassword: string): Promise<string> => {
  const client = await createClient();
  const newid = await client.api.cluster.nextid() as number;
  const nodeApi = client.api.nodes.get(templateNode);
  const lxcHookscriptVolid =
    process.env.PVE_LXC_HOOKSCRIPT_VOLID?.trim() ||
    'local:snippets/lxc-post-create-hook.sh';
  const lxcRootfsStorage = process.env.PVE_LXC_ROOTFS_STORAGE?.trim();

  // See IssueUbuntuTemplate.md for the Proxmox Ubuntu 24.04 console/network issue
  // and why this deployment path forces unprivileged+nested containers.
  // Proxmox expects hookscript in <storage>:snippets/<file> format, not an
  // absolute host path like /root/... .
  const createBody = {
    vmid: newid,
    ostemplate: templateVolid,
    hostname: newName,
    password: rootPassword,
    ...(lxcRootfsStorage ? { storage: lxcRootfsStorage } : {}),
    'net0': 'name=eth0,bridge=vmbr0,ip=dhcp,type=veth',
    hookscript: lxcHookscriptVolid,
    ...(isUbuntu2404Template(templateVolid)
      ? {
          unprivileged: true,
          features: 'nesting=1',
        }
      : {}),
  };

  return await nodeApi.lxc.create(templateNode, {
    $path: { node: templateNode },
    $body: createBody,
  }) as string;
};

/**
 * Clones a converted LXC guest template to a new container and starts it.
 * Returns both the clone and start task UPIDs.
 */
const cloneLxcGuestTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string
): Promise<{ cloneUpid: string; startUpid: string }> => {
  const client = await createClient();
  const newid = await client.api.cluster.nextid() as number;
  const nodeApi = client.api.nodes.get(templateNode);
  const cloneUpid = await nodeApi.lxc.id(templateId).clone({
    $body: { newid, hostname: newName, full: true },
  }) as string;

  await client.task.wait(cloneUpid);
  const startUpid = await nodeApi.lxc.id(newid).status.start() as string;

  return { cloneUpid, startUpid };
};

/** Renames a converted LXC guest template by updating hostname in config. */
const renameLxcGuestTemplate = async (templateId: number, templateNode: string, newName: string): Promise<string | unknown> => {
  const client = await createClient();
  return await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { hostname: newName },
  });
};

// ---------------------------------------------------------------------------
// SvelteKit exports
// ---------------------------------------------------------------------------

/**
 * SvelteKit page load function. Fetches all Proxmox data (nodes, VMs,
 * containers, LXC templates, recent tasks) and returns it to the page.
 * Times out after `PROXMOX_REQUEST_TIMEOUT_MS` ms. On error, returns an
 * offline stub so the page can render an unavailable state.
 *
 * @returns An object with a {@link ProxmoxResults} `results` field and an
 *   `error` string (or `null` when the load succeeded).
 */
export const load: PageServerLoad = async () => {
  try {
    const results = await withTimeout(
      loadResults(),
      PROXMOX_REQUEST_TIMEOUT_MS,
      `Timed out after ${PROXMOX_REQUEST_TIMEOUT_MS}ms while loading Proxmox data.`
    );
    return { results, error: null };
  } catch (e) {
    return {
      results: buildUnavailableResults(),
      error: e instanceof Error ? e.message : String(e)
    };
  }
};

/**
 * SvelteKit form actions for the Proxmox page.
 *
 * | Action | Form fields | Description |
 * |---|---|---|
 * | `start` | `type`, `id`, `node`, `name?`, `status?` | Powers on a VM or container. |
 * | `stop` | `type`, `id`, `node`, `name?`, `status?` | Powers off a VM or container. |
 * | `restart` | `type`, `id`, `node`, `name?`, `status?` | Reboots a VM or container. |
 * | `configureWorkload` | `type`, `id`, `node`, `cpuSharePercent`, `memoryMiB`, `storageGiB?` | Applies workload CPU/memory settings capped to 75% of host capacity and optionally grows guest storage. |
 * | `convertToTemplate` | `type`, `id`, `node`, `name?`, `status?` | Stops a running VM/LXC (if needed) and converts it into a template. |
 * | `cloneFromTemplate` | `templateId`, `templateNode`, `newName` | Clones a QEMU template to a new full VM. |
 * | `renameVmTemplate` | `templateId`, `templateNode`, `newName` | Renames a QEMU template. |
 * | `cloneLxcGuestTemplate` | `templateId`, `templateNode`, `newName` | Clones a converted LXC guest template to a new container. |
 * | `renameLxcGuestTemplate` | `templateId`, `templateNode`, `newName` | Renames a converted LXC guest template. |
 * | `cloneLxcTemplate` | `templateVolid`, `templateNode`, `newName`, `rootPassword` | Deploys a new LXC container from a storage template. |
 *
 * @returns A `{ status: 'success' | 'error', message?, upid? }` object, or a
 *   SvelteKit `fail` response on validation errors.
 */
export const actions: Actions = {
  // Workload power controls — all delegate to buildAction.
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart'),

  /** Updates VM/LXC CPU/memory limits while enforcing a 75% host-capacity ceiling, with optional storage expansion. */
  configureWorkload: async ({ request }: RequestEvent) => {
    let selectedWorkload: { type: WorkloadKind; id: number; name?: string; node: string; status?: string } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);

      const cpuShareRaw = formData.get('cpuSharePercent');
      const memoryRaw = formData.get('memoryMiB');
      const storageRaw = formData.get('storageGiB');

      if (typeof cpuShareRaw !== 'string' || cpuShareRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'CPU share is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type
        });
      }

      if (typeof memoryRaw !== 'string' || memoryRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Memory is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type
        });
      }

      const cpuSharePercent = Number(cpuShareRaw);
      const memoryMiB = Number(memoryRaw);
      const storageGiB = typeof storageRaw === 'string' && storageRaw.trim().length > 0
        ? Number(storageRaw)
        : undefined;

      if (storageGiB != null && (!Number.isFinite(storageGiB) || storageGiB < 1)) {
        return fail(400, {
          status: 'error' as const,
          message: `Storage increase must be at least 1 GiB (got ${JSON.stringify(storageRaw)}).`,
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type
        });
      }

      const { upid, appliedCpuLimit, appliedMemoryMiB, appliedCpuCores, appliedStorageGiB, storageTaskUpid } = await executeWorkloadConfigureAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        cpuSharePercent,
        memoryMiB,
        storageGiB
      );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const cpuSummary = selectedWorkload.type === 'vm'
        ? `cores=${appliedCpuCores ?? Math.max(1, Math.round(appliedCpuLimit))}`
        : `cpulimit=${appliedCpuLimit}`;
      const storageSummary = appliedStorageGiB ? `, storage=+${appliedStorageGiB} GiB` : '';
      const taskSummary = [upid, storageTaskUpid].filter((task): task is string => typeof task === 'string' && task.length > 0);

      return {
        status: 'success' as const,
        message: taskSummary.length > 0
          ? `Updated ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''}: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary} — task${taskSummary.length > 1 ? 's' : ''} ${taskSummary.join(', ')}.`
          : `Updated ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''}: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary}.`,
        upid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type
      });
    }
  },

  /** Stops a running VM/LXC (if needed) and converts it into a template. */
  convertToTemplate: async ({ request }: RequestEvent) => {
    let selectedWorkload: { type: WorkloadKind; id: number; name?: string; node: string; status?: string } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);

      const { convertUpid, stopUpid } = await executeConvertToTemplateAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status
      );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: stopUpid
          ? `Stopped ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''} and started template conversion — stop task ${stopUpid}, convert task ${convertUpid}.`
          : `Converting ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''} to template — task ${convertUpid}.`,
        upid: convertUpid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type
      });
    }
  },

  /** Clones a QEMU VM template into a new VM, applies cloud-init credentials, and starts it. */
  cloneFromTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const ciUser = formData.get('ciUser');
      const ciPassword = formData.get('ciPassword');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template ID.', formType: 'vm-template' });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, { status: 'error' as const, message: `Invalid template ID: "${templateIdValue}".`, formType: 'vm-template' });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.', formType: 'vm-template' });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'New VM name is required.', formType: 'vm-template' });
      }

      const nameError = validateProxmoxName(newName);
      if (nameError) {
        return fail(400, { status: 'error' as const, message: `VM name: ${nameError}`, formType: 'vm-template' });
      }

      if (typeof ciUser !== 'string' || ciUser.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Username is required for cloud-init.', formType: 'vm-template' });
      }

      const passwordError = validateStrongPassword(ciPassword);
      if (passwordError) {
        return fail(400, { status: 'error' as const, message: passwordError, formType: 'vm-template' });
      }

      const { cloneUpid, startUpid } = await deployVmFromTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
        ciUser.trim(),
        ciPassword as string
      );

      return {
        status: 'success' as const,
        message: `Cloned template ${templateId} as "${newName.trim()}" — clone task ${cloneUpid}. Started VM — start task ${startUpid}.`,
        formType: 'vm-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid, startUpid]
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template'
      });
    }
  },

  /** Renames a QEMU template using the entered newName value. */
  renameVmTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template ID.' });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, { status: 'error' as const, message: `Invalid template ID: "${templateIdValue}".` });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.' });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Template name is required.' });
      }

      const renameNameError = validateProxmoxName(newName);
      if (renameNameError) {
        return fail(400, { status: 'error' as const, message: `Template name: ${renameNameError}` });
      }

      const result = await renameVmTemplate(templateId, templateNode.trim(), newName.trim());
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed template ${templateId} to "${newName.trim()}".`,
        formType: 'vm-template'
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template'
      });
    }
  },

  /** Clones a converted LXC guest template into a new container. */
  cloneLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template ID.', formType: 'lxc-template' });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, { status: 'error' as const, message: `Invalid template ID: "${templateIdValue}".`, formType: 'lxc-template' });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.', formType: 'lxc-template' });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'New container name is required.', formType: 'lxc-template' });
      }

      const { cloneUpid, startUpid } = await cloneLxcGuestTemplate(
        templateId,
        templateNode.trim(),
        newName.trim()
      );

      return {
        status: 'success' as const,
        message:
          `Cloned guest template ${templateId} as "${newName.trim()}" — clone task ${cloneUpid}. ` +
          `Started container ${newName.trim()} — start task ${startUpid}.`,
        formType: 'lxc-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid, startUpid]
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template'
      });
    }
  },

  /** Renames a converted LXC guest template using the entered newName value. */
  renameLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template ID.', formType: 'lxc-template' });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, { status: 'error' as const, message: `Invalid template ID: "${templateIdValue}".`, formType: 'lxc-template' });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.', formType: 'lxc-template' });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Template name is required.', formType: 'lxc-template' });
      }

      const result = await renameLxcGuestTemplate(templateId, templateNode.trim(), newName.trim());
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming guest template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed guest template ${templateId} to "${newName.trim()}".`,
        formType: 'lxc-template'
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template'
      });
    }
  },

  /** Permanently destroys a VM or LXC container. */
  destroy: async ({ request }: RequestEvent) => {
    let selectedWorkload: { type: WorkloadKind; id: number; name?: string; node: string; status?: string } | undefined;
    try {
      const formData = await request.formData();
      // Reuse the same parser as power actions so all workload actions validate consistently.
      selectedWorkload = parseWorkloadSubmission(formData);
      const { destroyUpid, stopUpid } = await executeDestroyAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status
      );
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const stopPrefix = stopUpid
        ? `Stopped ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''} — task ${stopUpid}. `
        : '';
      return {
        status: 'success' as const,
        message: `${stopPrefix}Destroyed ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''} — task ${destroyUpid}.`,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type
      });
    }
  },

  /** Deploys a new LXC container from a storage template. */
  cloneLxcTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateVolid = formData.get('templateVolid');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const rootPassword = formData.get('rootPassword');

      if (typeof templateVolid !== 'string' || templateVolid.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template volume ID.' , formType: 'lxc-template'});
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.' , formType: 'lxc-template'});
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'New container name is required.' , formType: 'lxc-template'});
      }

      const passwordError = validateStrongPassword(rootPassword);
      if (passwordError) {
        return fail(400, { status: 'error' as const, message: passwordError, formType: 'lxc-template' });
      }

      const upid = await cloneLxcTemplate(templateVolid.trim(), templateNode.trim(), newName.trim(), rootPassword as string);

      return {
        status: 'success' as const,
        message: `Deploying LXC template "${templateVolid}" as "${newName.trim()}" — task ${upid}.`,
        formType: 'lxc-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [upid]
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template'
      });
    }
  },
};
