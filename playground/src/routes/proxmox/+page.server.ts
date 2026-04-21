import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import { Agent } from 'node:https';

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

const compareByName = (left: Workload, right: Workload): number => {
  const leftName = (left.name ?? '').toString().toLowerCase();
  const rightName = (right.name ?? '').toString().toLowerCase();

  if (leftName === rightName) {
    return 0;
  }

  return leftName < rightName ? -1 : 1;
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

const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

const getConfiguredNodeName = (): string | undefined => {
  const node = process.env.PVE_NODE?.trim();
  return node ? node : undefined;
};

type ResolvedNodeContext = {
  configuredNodeExists: boolean;
  node: string;
};

const getApiHost = (): string => {
  const baseUrl = process.env.PVE_BASE_URL;
  if (!baseUrl) {
    return 'unknown';
  }

  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
};

const resolveNodeContext = (nodes: ClusterNode[], preferredNode?: string): ResolvedNodeContext => {
  const configuredNodeExists = !!preferredNode && nodes.some((entry) => entry.node === preferredNode);
  if (configuredNodeExists && preferredNode) {
    return { configuredNodeExists: true, node: preferredNode };
  }

  const firstNode = nodes.find((entry) => typeof entry.node === 'string')?.node;
  if (firstNode) {
    return { configuredNodeExists, node: firstNode };
  }

  throw new Error('Could not resolve any Proxmox node from the cluster node list.');
};

const createClient = async (): Promise<Client> => {
  const baseUrl = process.env.PVE_BASE_URL;
  const apiToken = process.env.PVE_API_TOKEN;
  const username = process.env.PVE_USERNAME;
  const password = process.env.PVE_PASSWORD;
  const realm = process.env.PVE_REALM ?? 'pam';
  const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

  if (!baseUrl) {
    throw new Error('Missing PVE_BASE_URL');
  }

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

const loadResults = async (): Promise<ProxmoxResults> => {
  const client = await createClient();
  const configuredNode = getConfiguredNodeName();

  const [nodes, version, cluster] = await Promise.all([
    client.api.nodes.list(),
    client.api.version.version(),
    client.api.cluster.status(),
  ]);

  const clusterNodes = (nodes as Array<Record<string, unknown>>).map((entry) => ({
    node: typeof entry.node === 'string' ? entry.node : undefined,
    status: typeof entry.status === 'string' ? entry.status : undefined,
  }));

  const { node, configuredNodeExists } = resolveNodeContext(clusterNodes, configuredNode);
  const nodeApi: unknown = client.api.nodes.get(node);

  console.info(
    `[proxmox] baseUrl=${process.env.PVE_BASE_URL ?? 'unset'} apiHost=${getApiHost()} configuredNode=${configuredNode ?? 'unset'} resolvedNode=${node}`
  );

  const loadRecentTasks = async (): Promise<Array<Record<string, unknown>>> => {
    const query = { limit: 10, source: 'all' as const };
    const typedApi = nodeApi as Record<string, unknown>;

    if ((typedApi.tasks as Record<string, unknown>)?.list) {
      return (await ((typedApi.tasks as Record<string, AnyFn>).list({ $path: { node }, $query: query }))) as Array<Record<string, unknown>>;
    }

    if (typedApi.tasks && typeof typedApi.tasks === 'function') {
      return (await ((typedApi.tasks as AnyFn)({ $path: { node }, $query: query }))) as Array<Record<string, unknown>>;
    }

    const clusterApiObj = (client.api as Record<string, unknown>).cluster as Record<string, unknown> | undefined;
    if (clusterApiObj && typeof clusterApiObj === 'object' && 'tasks' in clusterApiObj) {
      const tasks = (clusterApiObj.tasks as AnyFn);
      if (typeof tasks === 'function') {
        const clusterTasks = await (tasks() as Promise<unknown>);
        return Array.isArray(clusterTasks)
          ? (clusterTasks.filter((task: Record<string, unknown>) => task.node === node) as Array<Record<string, unknown>>)
          : [];
      }
    }

    return [];
  };

  const [vms, containers, tasks] = await Promise.all([
      ((nodeApi as Record<string, unknown>).qemu as Record<string, AnyFn>).list({ $path: { node } }) as unknown as Promise<Workload[]>,
      ((nodeApi as Record<string, unknown>).lxc as Record<string, AnyFn>).list({ $path: { node } }) as unknown as Promise<Workload[]>,
    loadRecentTasks(),
  ]);

  const currentNode = clusterNodes.find((entry) => entry.node === node);
  const serverStatus = typeof currentNode?.status === 'string' ? currentNode.status : 'unknown';

  return {
    apiHost: getApiHost(),
    configuredNode: configuredNode ?? 'unset',
    configuredNodeExists,
    serverNode: node,
    serverStatus,
    lastSuccessfulRefresh: Date.now(),
    nodes,
    version,
    cluster,
    vms: (vms as Array<Record<string, unknown>>)
      .map((vm) => ({
        ...vm,
        node: typeof vm.node === 'string' ? vm.node : node,
        id: vm.vmid as number | string | undefined
      }))
      .sort(compareByName) as Workload[],
    containers: (containers as Array<Record<string, unknown>>)
      .map((container) => ({
        ...container,
        node: typeof container.node === 'string' ? container.node : node,
        id: container.vmid as number | string | undefined
      }))
      .sort(compareByName) as Workload[],
    recentTasks: (tasks as Array<Record<string, unknown>>)
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
      .sort((a, b) => b.starttime - a.starttime)
      .slice(0, 10)
  };
};

const buildUnavailableResults = (): ProxmoxResults => {
  const configuredNode = getConfiguredNodeName();
  const fallbackNode = configuredNode ?? 'unknown';

  return {
    apiHost: getApiHost(),
    configuredNode: configuredNode ?? 'unset',
    configuredNodeExists: false,
    serverNode: fallbackNode,
    serverStatus: 'offline',
    lastSuccessfulRefresh: null,
    nodes: [],
    version: null,
    cluster: null,
    vms: [],
    containers: [],
    recentTasks: []
  };
};

const parseWorkloadSubmission = (formData: FormData): { type: WorkloadKind; id: number; name: string; node: string } => {
  const type = formData.get('type');
  const idValue = formData.get('id');
  const name = formData.get('name');
  const nodeValue = formData.get('node');

  if (type !== 'vm' && type !== 'container') {
    throw new Error('Select a virtual machine or container first.');
  }

  if (typeof idValue !== 'string' || idValue.length === 0) {
    throw new Error('Missing workload ID.');
  }

  const id = Number(idValue);
  if (!Number.isInteger(id)) {
    throw new Error('Invalid workload ID.');
  }

  if (typeof nodeValue !== 'string' || nodeValue.trim().length === 0) {
    throw new Error('Missing workload node.');
  }

  return {
    type,
    id,
    name: typeof name === 'string' ? name : '',
    node: nodeValue.trim()
  };
};

const executeWorkloadAction = async (type: WorkloadKind, id: number, node: string, action: WorkloadAction): Promise<string> => {
  const client = await createClient();
  const nodeApi: unknown = client.api.nodes.get(node);
  const typedNodeApi = nodeApi as Record<string, Record<string, unknown>>;
    const qemuApi = (typedNodeApi.qemu as Record<string, AnyFn>).vmid as (id: number) => Record<string, unknown>;
    const lxcApi = (typedNodeApi.lxc as Record<string, AnyFn>).id as (id: number) => Record<string, unknown>;
    const guestApi = type === 'vm' ? qemuApi(id) : lxcApi(id);
  const status = guestApi.status as Record<string, unknown>;

  switch (action) {
    case 'start':
      return await ((status.start as AnyFn)()) as string;
    case 'stop':
      return await ((status.stop as AnyFn)()) as string;
    case 'restart':
      return await ((status.reboot as AnyFn)()) as string;
  }
};

const buildAction = (action: WorkloadAction) => {
  return async ({ request }: RequestEvent) => {
    let selectedWorkload:
      | {
          type: WorkloadKind;
          id: number;
          name?: string;
          node: string;
        }
      | undefined;

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
        workloadType: selectedWorkload.type
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type
      });
    }
  };
};

export const load: PageServerLoad = async () => {
  try {
    const results = await withTimeout(
      loadResults(),
      PROXMOX_REQUEST_TIMEOUT_MS,
      `Timed out after ${PROXMOX_REQUEST_TIMEOUT_MS}ms while loading Proxmox data.`
    );

    return {
      results,
      error: null
    };
  } catch (e) {
    return {
      results: buildUnavailableResults(),
      error: e instanceof Error ? e.message : String(e)
    };
  }
};

export const actions: Actions = {
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart')
};
