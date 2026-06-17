/**
 * Execute helpers — Proxmox API operations for workload actions.
 *
 * Extracted from proxmox-actions.ts to keep that module under the 750-line threshold.
 * Each function here performs a single Proxmox API operation (destroy, convert, power, configure).
 */
import type { NodeScopedAPI } from 'pve-client';
import type { WorkloadKind, WorkloadAction } from './types.js';
import {
  createClient,
  toNonNegativeNumber,
  toPositiveNumber,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Valid disk keys for the QEMU resize endpoint
// ---------------------------------------------------------------------------

const validResizeDisks = [
  'ide0', 'ide1', 'ide2', 'ide3',
  'scsi0', 'scsi1', 'scsi2', 'scsi3', 'scsi4', 'scsi5', 'scsi6', 'scsi7', 'scsi8', 'scsi9', 'scsi10',
  'scsi11', 'scsi12', 'scsi13', 'scsi14', 'scsi15', 'scsi16', 'scsi17', 'scsi18', 'scsi19', 'scsi20',
  'scsi21', 'scsi22', 'scsi23', 'scsi24', 'scsi25', 'scsi26', 'scsi27', 'scsi28', 'scsi29', 'scsi30',
  'virtio0', 'virtio1', 'virtio2', 'virtio3', 'virtio4', 'virtio5', 'virtio6', 'virtio7',
  'virtio8', 'virtio9', 'virtio10', 'virtio11', 'virtio12', 'virtio13', 'virtio14', 'virtio15',
  'sata0', 'sata1', 'sata2', 'sata3', 'sata4', 'sata5',
  'efidisk0', 'tpmstate0',
] as const;
type QemuResizeDisk = typeof validResizeDisks[number];

// ---------------------------------------------------------------------------
// Execute helpers
// ---------------------------------------------------------------------------

function isRunningDestroyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('running - destroy failed') || normalized.includes('is running');
}

/** Permanently destroys a VM or LXC container via the Proxmox API. Returns the task UPID. */
export async function executeDestroyAction(
  type: WorkloadKind,
  id: number,
  node: string,
  workloadStatus?: string,
): Promise<{ destroyUpid: string; stopUpid?: string }> {
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

/** Applies CPU/memory/storage/name configuration to a VM or container. */
export async function executeWorkloadConfigureAction(
  type: WorkloadKind,
  id: number,
  node: string,
  cpuSharePercent: number,
  memoryMiB: number,
  storageGiB?: number,
  currentName?: string,
  newName?: string,
): Promise<{
  upid?: string;
  appliedCpuLimit: number;
  appliedMemoryMiB: number;
  appliedCpuCores?: number;
  appliedStorageGiB?: number;
  storageTaskUpid?: string;
  renamed: boolean;
}> {
  const client = await createClient();

  const nodeStatus = (await client.request('/nodes/{node}/status', 'GET', {
    $path: { node },
  })) as Record<string, unknown>;

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
    throw new Error(
      `Memory must be between 16 and ${maxMemoryMiB} MiB (75% of host memory) (got ${memoryMiB} MiB).`
    );
  }

  const shouldResizeStorage =
    typeof storageGiB === 'number' && Number.isFinite(storageGiB) && storageGiB > 0;
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

  // Determine if a rename is needed (new name differs from current name)
  const shouldRename =
    typeof newName === 'string' &&
    newName.trim().length > 0 &&
    newName.trim() !== (currentName ?? '').trim();

  if (type === 'container') {
    const lxcBody: Record<string, unknown> = {
      cpulimit: appliedCpuLimit,
      memory: appliedMemoryMiB,
    };
    if (shouldRename) {
      lxcBody.name = newName!.trim();
    }
    const result = await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
      $path: { node, vmid: id },
      $body: lxcBody,
    });

    if (shouldResizeStorage) {
      const resizeResult = await client.request(
        '/nodes/{node}/lxc/{vmid}/resize',
        'PUT',
        {
          $path: { node, vmid: id },
          $body: {
            disk: 'rootfs',
            size: `+${Math.floor(storageGiB!)}G`,
          },
        },
      );

      storageTaskUpid = typeof resizeResult === 'string' ? resizeResult : undefined;
    }

    return {
      upid: typeof result === 'string' ? result : undefined,
      appliedCpuLimit,
      appliedMemoryMiB,
      appliedStorageGiB: shouldResizeStorage ? Math.floor(storageGiB!) : undefined,
      storageTaskUpid,
      renamed: shouldRename,
    };
  }

  // --- QEMU branch ---
  const appliedCpuCores = Math.max(1, Math.round((hostCpuCount * cpuSharePercent) / 100));
  const qemuBody: Record<string, unknown> = {
    cores: appliedCpuCores,
    memory: appliedMemoryMiB,
  };
  if (shouldRename) {
    qemuBody.name = newName!.trim();
  }
  const result = await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
    $path: { node, vmid: id },
    $body: qemuBody,
  });

  if (shouldResizeStorage) {
    const vmConfig = (await client.request('/nodes/{node}/qemu/{vmid}/config', 'GET', {
      $path: { node, vmid: id },
    })) as Record<string, unknown>;

    const vmDiskKey = Object.keys(vmConfig).find(
      (key) =>
        /^(scsi|virtio|sata|ide)\d+$/i.test(key) &&
        typeof vmConfig[key] === 'string' &&
        !String(vmConfig[key]).toLowerCase().includes('cloudinit')
    );

    if (!vmDiskKey) {
      throw new Error(
        `Unable to resolve a resizable VM disk for vmid ${id} on node ${node}.`
      );
    }

    if (!validResizeDisks.includes(vmDiskKey as QemuResizeDisk)) {
      throw new Error(`Invalid disk key '${vmDiskKey}' for vmid ${id} on node ${node}.`);
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
    renamed: shouldRename,
  };
}
