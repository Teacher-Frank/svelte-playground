/**
 * Execute helpers — Proxmox API operations for workload actions.
 *
 * Extracted from proxmox-actions.ts to keep that module under the 750-line threshold.
 * Each function here performs a single Proxmox API operation (destroy, convert, power, rename).
 */
import type { NodeScopedAPI } from 'pve-client';
import type { WorkloadKind, WorkloadAction } from './types.js';
import { createClient } from './helpers.server.js';

// ---------------------------------------------------------------------------
// Execute helpers
// ---------------------------------------------------------------------------

import { pendingDestroy } from './helpers.server.js';

/**
 * Permanently destroys a VM or LXC container via the Proxmox API.
 *
 * Strategy (matches deploy flow):
 * 1. Fire stop (if running) — fast (~100ms)
 * 2. Queue stop-wait + delete in `setTimeout` background task
 * 3. Return immediately so the HTTP response is fast
 *
 * The client tracks progress via `pendingDestroy` — the workload shows a
 * "destroying" status until the periodic refresh confirms it's gone.
 */
export async function executeDestroyAction(
  type: WorkloadKind,
  id: number,
  node: string,
  name: string,
  workloadStatus?: string,
): Promise<{ stopUpid?: string }> {
  const client = await createClient();
  const nodeApi = client.api.nodes.get(node);

  // For destroyFailed: UI status is stale — query actual Proxmox status
  let actualStatus = workloadStatus;
  if (workloadStatus === 'destroyFailed') {
    const statusResult = await (type === 'vm'
      ? nodeApi.qemu.vmid(id).status.current()
      : nodeApi.lxc.id(id).status.current());
    // current() returns { status: 'running' | 'stopped' | ... }
    actualStatus = statusResult?.status ?? 'running';
  }

  // Phase 1: fire stop (if running) — fast
  let stopUpid: string | undefined;
  if (actualStatus === 'running') {
    stopUpid = (await (type === 'vm'
      ? nodeApi.qemu.vmid(id).status.stop()
      : nodeApi.lxc.id(id).status.stop())) as string;
  }

  // Phase 2: wait for stop (if needed) + delete — runs in background
  const clientRef = client;
  const nodeApiRef = nodeApi;
  const stopUpidRef = stopUpid;
  setTimeout(async () => {
    try {
      if (stopUpidRef) {
        await clientRef.task.wait(stopUpidRef);
      }

      const destroyUpid = (await (type === 'vm'
        ? nodeApiRef.qemu.vmid(id).delete({ $query: { purge: true } })
        : nodeApiRef.lxc.id(id).delete({ $query: { purge: true, force: true } }))) as string;

      // Store the destroy UPID so loadData.ts can poll for completion
      const entry = pendingDestroy.get(id);
      if (entry) {
        entry.destroyUpid = destroyUpid;
      }

      console.info(`[proxmox] Destroyed ${type} ${id} on ${node} — task ${destroyUpid}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(
        `[proxmox] Destroy failed for ${type} ${id} on ${node}:`,
        errorMsg,
      );
      // Store the error in pendingDestroy so loadData.ts can surface it
      const entry = pendingDestroy.get(id);
      if (entry) {
        entry.error = errorMsg;
        entry.failedReason = errorMsg;
      }
    }
  }, 0);

  // Track in pendingDestroy so the workload shows a "destroying" status
  // The periodic refresh in loadData.ts will clear this entry when the workload disappears,
  // or mark it as failed if it persists beyond the stale threshold.
  pendingDestroy.set(id, { type, name, node, startedAt: Date.now() });

  return { stopUpid };
}

/**
 * Converts a VM or LXC container into a template. If currently running, the
 * workload is stopped first and the stop task is awaited.
 */
export async function executeConvertToTemplateAction(
  type: WorkloadKind,
  id: number,
  node: string,
  workloadStatus?: string,
): Promise<{ convertUpid: string; stopUpid?: string }> {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(node);

  const shouldStop = workloadStatus === 'running';

  let stopUpid: string | undefined;
  if (shouldStop) {
    stopUpid = await (type === 'vm'
      ? nodeApi.qemu.vmid(id).status.stop()
      : nodeApi.lxc.id(id).status.stop()) as string;
    await client.task.wait(stopUpid);
  }

  const convertUpid = await client.request(
    type === 'vm'
      ? '/nodes/{node}/qemu/{vmid}/template'
      : '/nodes/{node}/lxc/{vmid}/template',
    'POST',
    {
      $path: { node, vmid: id },
    },
  ) as string;

  return { convertUpid, stopUpid };
}

/** Sends a start/stop/restart command to a VM or container via the Proxmox API. */
export async function executeWorkloadAction(
  type: WorkloadKind,
  id: number,
  node: string,
  action: WorkloadAction,
  workloadStatus?: string,
): Promise<{ upid: string; effectiveAction: WorkloadAction | 'start' }> {
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
}

/** Renames a VM or LXC container via the Proxmox config API. */
export async function executeWorkloadRenameAction(
  type: WorkloadKind,
  id: number,
  node: string,
  _currentName?: string,
  newName?: string,
): Promise<{ upid?: string }> {
  const client = await createClient();

  const configName = typeof newName === 'string' ? newName.trim() : '';

  const result = await client.request(
    type === 'container'
      ? '/nodes/{node}/lxc/{vmid}/config'
      : '/nodes/{node}/qemu/{vmid}/config',
    'PUT',
    {
      $path: { node, vmid: id },
      $body: { name: configName },
    },
  );

  return {
    upid: typeof result === 'string' ? result : undefined,
  };
}
