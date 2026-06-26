/**
 * Proxmox data loading for the admin page.
 *
 * Handles client authentication, node resolution, and orchestration of all
 * parallel API fetches (cluster nodes, version, VMs, containers, LXC
 * templates, tasks, guest IPs).  Also owns the `loadResults` and
 * `buildUnavailableResults` helpers.
 *
 * Exports the SvelteKit `load: PageServerLoad` function.
 */

import type { NodeScopedAPI } from 'pve-client';
import { Client } from 'pve-client';
import type { PageServerLoad } from './$types.js';
import type { ClusterNode, LxcInterface, LxcTemplate, ProxmoxResults, VmAgentInterface, Workload } from './types.js';
import {
  DESTROY_STALE_THRESHOLD_MS,
  PROXMOX_REQUEST_TIMEOUT_MS,
  VM_AGENT_RETRY_DELAY_MS,
  createClient,
  extractPrimaryContainerIPv4,
  extractPrimaryGuestIPv4,
  extractPrimaryGuestIPv4WithPrefix,
  getConfiguredNodeName,
  getApiHost,
  getRefreshIntervalSeconds,
  isGuestAgentUnavailableError,
  isGuestGuiBridgeConfigured,
  logLoadTiming,
  nowMs,
  pendingStaticConversion,
  pendingDestroy,
  toNonNegativeNumber,
  toPositiveNumber,
  vmAgentRetryAfterById,
  withTimeout,
  compareByName,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Node resolution
// ---------------------------------------------------------------------------

type ResolvedNodeContext = {
  configuredNodeExists: boolean;
  node: string;
};

/**
 * Resolves which cluster node to use.  Prefers the configured node if it exists
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
export const buildUnavailableResults = (): ProxmoxResults => {
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

/** Loads all Proxmox data needed by the page.  Errors in individual sections are logged but do not abort the load. */
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
  const notifications: string[] = [];

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
                  // TODO(pve-client): ipconfig0 is a valid QEMU config field but missing from
                  // the generated PUT body type. Fix in pve-client types; cast via Record<string, unknown> for now.
                  await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
                    $path: { node: pendingEntry.node, vmid },
                    $body: { ipconfig0: staticConfig } as Record<string, unknown>,
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

  // Clean up pendingDestroy entries for workloads that no longer appear in the server list
  // (they have been successfully destroyed).
  // If a workload persists beyond the stale threshold, mark the entry as failed so the
  // user sees an error instead of a silent hang.
  for (const [vmid, entry] of pendingDestroy) {
    const vmExists = (vms as Array<Record<string, unknown>>).some((v) => Number(v.vmid) === vmid);
    const ctExists = (containers as Array<Record<string, unknown>>).some((c) => Number(c.vmid) === vmid);

    if (!vmExists && !ctExists) {
      pendingDestroy.delete(vmid);
      continue;
    }

    /* ── Task-based resolution (primary) ── */
    // If the background task already recorded an error, surface it
    if (entry.error && !entry.failedReason) {
      entry.failedReason = entry.error;
      continue;
    }

    // If we have a destroy UPID, poll Proxmox for the real task status
    if (entry.destroyUpid) {
      try {
        const taskStatus = await client.tasks.get(entry.destroyUpid);
        const status = typeof taskStatus === 'object' && taskStatus && 'status' in taskStatus
          ? (taskStatus as Record<string, unknown>).status
          : undefined;
        const normalizedStatus = typeof status === 'string' ? status.toLowerCase().trim() : '';

        if (normalizedStatus === 'ok' || normalizedStatus === 'stopped') {
          // Task succeeded — keep the entry only while the workload still shows in the list.
          // Clear any stale failure that was previously flagged.
          entry.failedReason = undefined;
          // Remove entry if the workload has disappeared since the last check
          if (!vmExists && !ctExists) {
            pendingDestroy.delete(vmid);
          }
          continue;
        }

        if (normalizedStatus === 'error' || normalizedStatus === 'warnings') {
          entry.failedReason = `Destroy task ended with status: ${status}`;
          console.warn(
            `[proxmox] Destroy task ${entry.destroyUpid} for ${entry.type} ${vmid} (${entry.name}) ended with status: ${status}`,
          );
          continue;
        }
        // Status is 'running'/null — task still in progress, skip stale check
        continue;
      } catch {
        // Task not found yet — it may still be running or not yet started.
        // Don't fall through to the stale check; the UPID is available, so the
        // policy says "never mark as failed purely on elapsed time."
        continue;
      }
    }

    /* ── Stale-timeout fallback (only when no UPID is available) ── */
    if (!entry.destroyUpid && !entry.failedReason && Date.now() - entry.startedAt > DESTROY_STALE_THRESHOLD_MS) {
      entry.failedReason = 'Destroy did not complete within 60s. The background task may have failed.';
      console.warn(
        `[proxmox] Destroy stale for ${entry.type} ${vmid} (${entry.name}) on ${entry.node} — marking as failed (stale check)`,
      );
    }
  }

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
        const vmid = vm.vmid as number | string | undefined;
        const vmidNum = typeof vmid === 'number' ? vmid : undefined;
        const pending = vmidNum != null ? pendingDestroy.get(vmidNum) : undefined;

        // If this VM is being destroyed, override status and clear the tracking entry
        // only once the VM disappears from the server list on a future refresh.
        return {
          ...vm,
          node: resolvedNode,
          id: vmid,
          status: pending?.failedReason ? 'destroyFailed' : pending ? 'destroying' : (vm.status as string | undefined),
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
      // Ensure each container has a node field and an id mapped from vmid.
      .map((container) => {
        const resolvedNode = typeof container.node === 'string' ? container.node : node;
        const hostCapacity = nodeCapacityByName.get(resolvedNode);
        const vmid = container.vmid as number | string | undefined;
        const vmidNum = typeof vmid === 'number' ? vmid : undefined;
        const pending = vmidNum != null ? pendingDestroy.get(vmidNum) : undefined;

        // If this container is being destroyed, override status
        return {
          ...container,
          node: resolvedNode,
          id: vmid,
          status: pending?.failedReason ? 'destroyFailed' : pending ? 'destroying' : (container.status as string | undefined),
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
// SvelteKit export
// ---------------------------------------------------------------------------

/**
 * SvelteKit page load function.  Fetches all Proxmox data (nodes, VMs,
 * containers, LXC templates, recent tasks) and returns it to the page.
 * Times out after `PROXMOX_REQUEST_TIMEOUT_MS` ms.  On error, returns an
 * offline stub so the page can render an unavailable state. */
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
