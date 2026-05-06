import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import { Agent } from 'node:https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WorkloadKind = 'vm' | 'container';
type WorkloadAction = 'start' | 'stop' | 'restart';
type AnyFn = (...args: unknown[]) => unknown;

const PROXMOX_REQUEST_TIMEOUT_MS = 8000;

type Workload = {
  id?: number | string;
  name?: string;
  node?: string;
  status?: string;
  uptime?: number;
};

type ClusterNode = {
  node?: string;
  status?: string;
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

type LxcTemplate = {
  storage: string;
  volid: string;
  format: string;
  size: number;
  content: string;
  notes?: string;
  parent?: string;
  ctime?: number;
  used?: number;
  vmid?: number;
};

type ProxmoxResults = {
  apiHost: string;
  configuredNode: string;
  configuredNodeExists: boolean;
  serverNode: string;
  serverStatus: string;
  lastSuccessfulRefresh: number | null;
  nodes: unknown;
  version: unknown;
  cluster: unknown;
  vms: Workload[];
  containers: Workload[];
  lxcTemplates: LxcTemplate[];
  recentTasks: {
    id: string;
    node: string;
    starttime: number;
    endtime?: number;
    status?: string;
    type: string;
    user: string;
    upid: string;
  }[];
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

/** Extracts the hostname from PVE_BASE_URL for display purposes. */const getApiHost = (): string => {
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

  const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

  if (apiToken) {
    return new Client({ baseUrl, apiToken, agent });
  }

  if (username && password) {
    const client = new Client({ baseUrl, username, password, realm, agent });
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

// ---------------------------------------------------------------------------
// Page data loading
// ---------------------------------------------------------------------------

/** Returns a stub result used when the Proxmox API is unreachable. */
const buildUnavailableResults = (): ProxmoxResults => {
  const configuredNode = getConfiguredNodeName();
  return {
    apiHost: getApiHost(),
    configuredNode: configuredNode ?? 'unset',
    configuredNodeExists: false,
    serverNode: configuredNode ?? 'unknown',
    serverStatus: 'offline',
    lastSuccessfulRefresh: null,
    nodes: [],
    version: null,
    cluster: null,
    vms: [],
    containers: [],
    lxcTemplates: [],
    recentTasks: []
  };
};

/** Loads all Proxmox data needed by the page. Errors in individual sections are logged but do not abort the load. */
const loadResults = async (): Promise<ProxmoxResults> => {
  // --- Connect and fetch top-level cluster data ---
  let nodes, version, cluster;
  let client: Client;
  try {
    client = await createClient();
    [nodes, version, cluster] = await Promise.all([
      client.api.nodes.list(),
      client.api.version.version(),
      client.api.cluster.status(),
    ]);
  } catch (err) {
    console.error('[proxmox] Connection/auth error:', err);
    return buildUnavailableResults();
  }

  let clusterNodes: ClusterNode[];
  try {
    clusterNodes = (nodes as Array<Record<string, unknown>>).map((entry) => ({
      node: typeof entry.node === 'string' ? entry.node : undefined,
      status: typeof entry.status === 'string' ? entry.status : undefined,
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

  let nodeApi: unknown;
  try {
    // Reuse the existing authenticated client rather than creating a new one.
    nodeApi = client.api.nodes.get(node);
  } catch (err) {
    console.error('[proxmox] Failed to get node API:', err);
    return buildUnavailableResults();
  }

  console.info(
    `[proxmox] baseUrl=${process.env.PVE_BASE_URL ?? 'unset'} apiHost=${getApiHost()} ` +
    `configuredNode=${getConfiguredNodeName() ?? 'unset'} resolvedNode=${node}`
  );

  // --- Load node-level data (errors are logged but do not abort the load) ---
  let storages: Array<Record<string, unknown>> = [];
  const lxcTemplates: LxcTemplate[] = [];
  let vms: Workload[] = [];
  let containers: Workload[] = [];
  let tasks: Array<Record<string, unknown>> = [];

  // Enumerate LXC templates from all storages that expose vztmpl content
  const storageApiObj = (nodeApi as Record<string, unknown>).storage;
  if (!storageApiObj || typeof storageApiObj !== 'object') {
    console.error('[proxmox] nodeApi.storage is missing or not an object. Cannot enumerate storages or LXC templates.');
  } else {
    try {
      storages = await (storageApiObj as Record<string, AnyFn>).list({ $path: { node } }) as Array<Record<string, unknown>>;
    } catch (err) {
      console.error('[proxmox] Failed to list storages:', err);
    }

    for (const storage of storages) {
      if (typeof storage.storage !== 'string') continue;

      let storageApi: Record<string, unknown> | undefined;
      try {
        storageApi = (storageApiObj as Record<string, AnyFn>).get(storage.storage) as Record<string, unknown>;
      } catch (err) {
        console.error(`[proxmox] Failed to get storage API for ${storage.storage}:`, err);
        continue;
      }

      const contentApi = (storageApi?.content) as { list: AnyFn } | undefined;
      if (!contentApi || typeof contentApi.list !== 'function') continue;

      let contentList: unknown;
      try {
        contentList = await contentApi.list({ $path: { node, storage: storage.storage }, $query: { content: 'vztmpl' } });
      } catch (err) {
        console.error(`[proxmox] Failed to list content for storage ${storage.storage}:`, err);
        continue;
      }

      if (Array.isArray(contentList)) {
        for (const tmpl of contentList as Array<Record<string, unknown>>) {
          if (tmpl.content === 'vztmpl') {
            lxcTemplates.push({ ...tmpl, storage: storage.storage } as LxcTemplate);
          }
        }
      }
    }
  }
  try {
    vms = await ((nodeApi as Record<string, unknown>).qemu as Record<string, AnyFn>).list({ $path: { node } }) as Workload[];
  } catch (err) {
    console.error('[proxmox] Failed to list VMs:', err);
  }
  try {
    containers = await ((nodeApi as Record<string, unknown>).lxc as Record<string, AnyFn>).list({ $path: { node } }) as Workload[];
  } catch (err) {
    console.error('[proxmox] Failed to list containers:', err);
  }
  try {
    const typedNodeApi = nodeApi as { tasks: { list: (args: { $query?: { limit?: number; source?: 'archive' | 'active' | 'all' } }) => Promise<Array<Record<string, unknown>>> } };
    tasks = await typedNodeApi.tasks.list({ $query: { limit: 10, source: 'all' } });
  } catch (err) {
    console.error('[proxmox] Failed to list tasks:', err);
  }

  const currentNode = clusterNodes.find((entry) => entry.node === node);
  const serverStatus = typeof currentNode?.status === 'string' ? currentNode.status : 'unknown';

  return {
    apiHost: getApiHost(),
    configuredNode: getConfiguredNodeName() ?? 'unset',
    configuredNodeExists,
    serverNode: node,
    serverStatus,
    lastSuccessfulRefresh: Date.now(),
    nodes,
    version,
    cluster,
    vms: (vms as Array<Record<string, unknown>>)
      // Ensure each VM has a node field and an id mapped from vmid.
      .map((vm) => ({
        ...vm,
        node: typeof vm.node === 'string' ? vm.node : node,
        id: vm.vmid as number | string | undefined
      }))
      .sort(compareByName) as Workload[],
    containers: (containers as Array<Record<string, unknown>>)
      // Ensure each container has a node field and an id mapped from vmid.
      .map((container) => ({
        ...container,
        node: typeof container.node === 'string' ? container.node : node,
        id: container.vmid as number | string | undefined
      }))
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
      .slice(0, 10)
  };
};

// ---------------------------------------------------------------------------
// Form actions
// ---------------------------------------------------------------------------

/** Validates and parses a workload control form submission. */
const parseWorkloadSubmission = (formData: FormData): { type: WorkloadKind; id: number; name: string; node: string } => {
  const type = formData.get('type');
  const idValue = formData.get('id');
  const name = formData.get('name');
  const nodeValue = formData.get('node');

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
    node: nodeValue.trim()
  };
};

/** Sends a start/stop/restart command to a VM or container via the Proxmox API. */
const executeWorkloadAction = async (type: WorkloadKind, id: number, node: string, action: WorkloadAction): Promise<string> => {
  const client = await createClient();
  const typedNodeApi = client.api.nodes.get(node) as unknown as Record<string, Record<string, unknown>>;
  const qemuApi = (typedNodeApi.qemu as Record<string, AnyFn>).vmid as (id: number) => Record<string, unknown>;
  const lxcApi = (typedNodeApi.lxc as Record<string, AnyFn>).id as (id: number) => Record<string, unknown>;
  const guestApi = type === 'vm' ? qemuApi(id) : lxcApi(id);
  const status = guestApi.status as Record<string, unknown>;

  switch (action) {
    case 'start':   return await ((status.start as AnyFn)()) as string;
    case 'stop':    return await ((status.stop as AnyFn)()) as string;
    case 'restart': return await ((status.reboot as AnyFn)()) as string;
  }
};

/** Builds a SvelteKit form action handler for a given workload action. */
const buildAction = (action: WorkloadAction) => {
  // Returns a request handler that parses the form, runs the action, and
  // returns a success or error result for the UI to display.
  return async ({ request }: RequestEvent) => {
    let selectedWorkload: { type: WorkloadKind; id: number; name?: string; node: string } | undefined;

    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const upid = await executeWorkloadAction(selectedWorkload.type, selectedWorkload.id, selectedWorkload.node, action);
      const actionLabel = action === 'restart' ? 'Restarted' : `${action.charAt(0).toUpperCase()}${action.slice(1)}ed`;
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: `${actionLabel} ${kindLabel} ${selectedWorkload.id}${selectedWorkload.name ? ` (${selectedWorkload.name})` : ''}.`,
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
  };
};

/** Clones a QEMU VM template to a new VM. Returns the task UPID. */
const cloneVmFromTemplate = async (templateId: number, templateNode: string, newName: string): Promise<string> => {
  const client = await createClient();
  const newid = await (client.api.cluster as unknown as Record<string, AnyFn>).nextid({}) as number;
  const nodeApi = client.api.nodes.get(templateNode);
  const vmApi = (nodeApi as { qemu: { vmid: (id: number) => unknown } }).qemu.vmid(templateId);
  return await (vmApi as { clone: (args: Record<string, unknown>) => Promise<string> }).clone({
    $body: { newid, name: newName, full: 1 },
  });
};

/** Deploys a new LXC container from a storage template. Returns the task UPID. */
const cloneLxcTemplate = async (templateVolid: string, templateNode: string, newName: string): Promise<string> => {
  const client = await createClient();
  const newid = await client.api.cluster.nextid() as number;
  const nodeApi = client.api.nodes.get(templateNode);
  return await nodeApi.lxc.create(templateNode, {
    $path: { node: templateNode },
    $body: { vmid: newid, ostemplate: templateVolid, hostname: newName },
  }) as string;
};

// ---------------------------------------------------------------------------
// SvelteKit exports
// ---------------------------------------------------------------------------

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

export const actions: Actions = {
  // Workload power controls — all delegate to buildAction.
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart'),

  /** Clones a QEMU VM template into a new full VM. */
  cloneFromTemplate: async ({ request }: RequestEvent) => {
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
        return fail(400, { status: 'error' as const, message: 'Invalid template ID.' });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.' });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'New VM name is required.' });
      }

      const upid = await cloneVmFromTemplate(templateId, templateNode.trim(), newName.trim());

       return {
         status: 'success' as const,
         message: `Cloning template ${templateId} as "${newName.trim()}" — task ${upid}.`,
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

  /** Deploys a new LXC container from a storage template. */
  cloneLxcTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateVolid = formData.get('templateVolid');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateVolid !== 'string' || templateVolid.length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template volume ID.' , formType: 'lxc-template'});
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'Missing template node.' , formType: 'lxc-template'});
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, { status: 'error' as const, message: 'New container name is required.' , formType: 'lxc-template'});
      }

      const upid = await cloneLxcTemplate(templateVolid.trim(), templateNode.trim(), newName.trim());

      return {
        status: 'success' as const,
        message: `Deploying LXC template "${templateVolid}" as "${newName.trim()}" — task ${upid}.`,
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
};
