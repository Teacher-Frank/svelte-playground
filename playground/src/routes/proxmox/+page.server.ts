import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import { Agent } from 'node:https';

type WorkloadKind = 'vm' | 'container';
type WorkloadAction = 'start' | 'stop' | 'restart';

type Workload = {
  id?: number | string;
  name?: string;
  node?: string;
  status?: string;
  uptime?: number;
};

type ProxmoxResults = {
  serverStatus: string;
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

const getNodeName = (): string => process.env.PVE_NODE ?? 'pve';

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
  const node = getNodeName();
  const nodeApi: any = client.api.nodes.get(node);

  const loadRecentTasks = async (): Promise<Array<Record<string, unknown>>> => {
    const query = { limit: 10, source: 'all' as const };

    if (nodeApi?.tasks?.list) {
      return (await nodeApi.tasks.list({ $path: { node }, $query: query })) as Array<Record<string, unknown>>;
    }

    if (nodeApi?.tasks && typeof nodeApi.tasks === 'function') {
      return (await nodeApi.tasks({ $path: { node }, $query: query })) as Array<Record<string, unknown>>;
    }

    const clusterApi: any = (client.api as any).cluster;
    if (clusterApi?.tasks) {
      const clusterTasks = await clusterApi.tasks();
      return Array.isArray(clusterTasks)
        ? (clusterTasks.filter((task: Record<string, unknown>) => task.node === node) as Array<Record<string, unknown>>)
        : [];
    }

    return [];
  };

  const [nodes, version, cluster, vms, containers, tasks] = await Promise.all([
    client.api.nodes.list(),
    client.api.version.version(),
    client.api.cluster.status(),
    nodeApi.qemu.list({ $path: { node } }),
    nodeApi.lxc.list({ $path: { node } }),
    loadRecentTasks(),
  ]);

  const currentNode = (nodes as Array<Record<string, unknown>>).find((entry) => entry.node === node);
  const serverStatus = typeof currentNode?.status === 'string' ? currentNode.status : 'unknown';

  return {
    serverStatus,
    nodes,
    version,
    cluster,
    vms: (vms as Array<Record<string, unknown>>).map((vm) => ({
      ...vm,
      node,
      id: vm.vmid as number | string | undefined
    })) as Workload[],
    containers: (containers as Array<Record<string, unknown>>).map((container) => ({
      ...container,
      node,
      id: container.vmid as number | string | undefined
    })) as Workload[],
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

const parseWorkloadSubmission = (formData: FormData): { type: WorkloadKind; id: number; name: string } => {
  const type = formData.get('type');
  const idValue = formData.get('id');
  const name = formData.get('name');

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

  return {
    type,
    id,
    name: typeof name === 'string' ? name : ''
  };
};

const executeWorkloadAction = async (type: WorkloadKind, id: number, action: WorkloadAction): Promise<string> => {
  const client = await createClient();
  const node = getNodeName();
  const nodeApi: any = client.api.nodes.get(node);
  const guestApi = type === 'vm' ? nodeApi.qemu.vmid(id) : nodeApi.lxc.id(id);

  switch (action) {
    case 'start':
      return guestApi.status.start();
    case 'stop':
      return guestApi.status.stop();
    case 'restart':
      return guestApi.status.reboot();
  }
};

const buildAction = (action: WorkloadAction) => {
  return async ({ request }: RequestEvent) => {
    let selectedWorkload:
      | {
          type: WorkloadKind;
          id: number;
          name?: string;
        }
      | undefined;

    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const upid = await executeWorkloadAction(selectedWorkload.type, selectedWorkload.id, action);
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
    return {
      results: await loadResults(),
      error: null
    };
  } catch (e) {
    return {
      results: null,
      error: e instanceof Error ? e.message : String(e)
    };
  }
};

export const actions: Actions = {
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart')
};
