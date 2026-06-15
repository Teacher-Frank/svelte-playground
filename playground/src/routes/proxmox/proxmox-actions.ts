/**
 * Proxmox form actions for the admin page.
 *
 * Handles all SvelteKit form submissions including workload power controls,
 * configuration changes, template deployment, deletion, and conversion.
 * Uses typed node APIs (`nodeApi.qemu.vmid()`, `nodeApi.lxc.id()`) for
 * standard operations and `client.request()` for raw endpoint access
 * where the typed surface is incomplete.
 *
 * Exports the SvelteKit `actions: Actions` object.
 */

import { fail } from '@sveltejs/kit';
import type { RequestEvent } from '@sveltejs/kit';
import type { NodeScopedAPI } from 'pve-client';
import type { Actions } from './$types.js';
import type { WorkloadKind, WorkloadAction } from './types.js';
import {
  createClient,
  pendingStaticConversion,
  toNonNegativeNumber,
  toPositiveNumber,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Valid disk keys for the QEMU resize endpoint
// ---------------------------------------------------------------------------

/** Valid disk keys for the QEMU resize endpoint. */
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
/** Type of valid disk keys for QEMU resize operations. */
type QemuResizeDisk = typeof validResizeDisks[number];

// ---------------------------------------------------------------------------
// Parsers & validators
// ---------------------------------------------------------------------------

/** Validates and parses a workload control form submission. */
const parseWorkloadSubmission = (
  formData: FormData
): { type: WorkloadKind; id: number; name: string; node: string; status?: string } => {
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
    throw new Error(
      `Missing workload node: nodeValue=${JSON.stringify(nodeValue)}, type=${JSON.stringify(type)}, id=${idValue}`
    );
  }

  return {
    type,
    id,
    name: typeof name === 'string' ? name : '',
    node: nodeValue.trim(),
    status: typeof status === 'string' && status.trim().length > 0 ? status.trim() : undefined,
  };
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
  if (!/[^A-Za-z0-9]/.test(value))
    return 'Root password must contain at least one special character.';
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

// ---------------------------------------------------------------------------
// Execute helpers
// ---------------------------------------------------------------------------

/** Detects "workload is still running" errors from Proxmox delete calls. */
const isRunningDestroyError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return normalized.includes('running - destroy failed') || normalized.includes('is running');
};

/** Permanently destroys a VM or LXC container via the Proxmox API. Returns the task UPID. */
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
 * Converts a VM or LXC container into a template. If currently running, the
 * workload is stopped first and the stop task is awaited.
 */
const executeConvertToTemplateAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  workloadStatus?: string
): Promise<{ convertUpid: string; stopUpid?: string }> => {
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

/** Applies CPU/memory/storage configuration to a VM or container. */
const executeWorkloadConfigureAction = async (
  type: WorkloadKind,
  id: number,
  node: string,
  cpuSharePercent: number,
  memoryMiB: number,
  storageGiB?: number
): Promise<{
  upid?: string;
  appliedCpuLimit: number;
  appliedMemoryMiB: number;
  appliedCpuCores?: number;
  appliedStorageGiB?: number;
  storageTaskUpid?: string;
}> => {
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

  if (type === 'container') {
    const result = await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
      $path: { node, vmid: id },
      $body: {
        cpulimit: appliedCpuLimit,
        memory: appliedMemoryMiB,
      },
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
    };
  }

  // --- QEMU branch ---
  const appliedCpuCores = Math.max(1, Math.round((hostCpuCount * cpuSharePercent) / 100));
  const result = await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
    $path: { node, vmid: id },
    $body: {
      cores: appliedCpuCores,
      memory: appliedMemoryMiB,
    },
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
    appliedCpuCores,
    appliedStorageGiB: shouldResizeStorage ? Math.floor(storageGiB!) : undefined,
    storageTaskUpid,
  };
};

// ---------------------------------------------------------------------------
// Template helpers
// ---------------------------------------------------------------------------

/**
 * Clones a QEMU VM template, applies cloud-init credentials, configures
 * guest agent and network, then starts the VM.
 */
const deployVmFromTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string,
  ciUser: string,
  ciPassword: string,
): Promise<{ cloneUpid: string; startUpid: string }> => {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const cloudInitStorage = process.env.PVE_VM_CLOUDINIT_STORAGE?.trim() || 'local-lvm';
  const vmNetworkBridge = process.env.PVE_VM_NETWORK_BRIDGE?.trim() || 'vmbr0';
  const vmNetworkModel = process.env.PVE_VM_NETWORK_MODEL?.trim() || 'virtio';

  const hasTargetCloudInitVolume = async (vmid: number): Promise<boolean> => {
    try {
      const contentList = (await nodeApi.storage.get(cloudInitStorage).content.list({
        $query: { vmid },
      })) as Array<{ volid?: string }>;

      return contentList.some(
        (entry) => entry.volid === `${cloudInitStorage}:vm-${vmid}-cloudinit`
      );
    } catch (error) {
      console.warn(
        `[proxmox] Unable to verify cloud-init volume state for VM ${vmid} on storage ${cloudInitStorage}:`,
        error,
      );
      return false;
    }
  };

  const isCloudInitCollisionError = async (
    vmid: number,
    error: unknown,
  ): Promise<boolean> => {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    if (
      !normalized.includes('lvcreate') ||
      !normalized.includes('cloudinit') ||
      !normalized.includes('already exists')
    ) {
      return false;
    }

    return await hasTargetCloudInitVolume(vmid);
  };

  const newid = (await client.api.cluster.nextid()) as number;

  try {
    // Full clone — must complete before cloud-init config can be applied.
    const cloneUpid = (await nodeApi.qemu.vmid(templateId).clone({
      $body: { newid, name: newName, full: true },
    })) as string;
    await client.task.wait(cloneUpid);

    const clonedConfig = (await client.request(
      '/nodes/{node}/qemu/{vmid}/config',
      'GET',
      {
        $path: { node: templateNode, vmid: newid },
      },
    )) as Record<string, unknown>;

    const diskKeyPattern = /^(ide|sata|scsi|virtio)\d+$/;
    const hasCloudInitDisk = Object.entries(clonedConfig).some(
      ([key, value]) =>
        diskKeyPattern.test(key) &&
        typeof value === 'string' &&
        value.toLowerCase().includes('cloudinit')
    );
    const hasNetworkInterface = Object.entries(clonedConfig).some(
      ([key, value]) =>
        /^net\d+$/.test(key) && typeof value === 'string' && value.trim().length > 0
    );
    const hasIpConfig0 =
      typeof clonedConfig.ipconfig0 === 'string' &&
      clonedConfig.ipconfig0.trim().length > 0;
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

    // Apply cloud-init credentials, network, and guest agent configuration.
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

    const existingAgent = clonedConfig.agent as string | undefined;
    if (!existingAgent?.includes('enabled=1')) {
      configBody.agent = 'enabled=1';
    }

    await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: templateNode, vmid: newid },
      $body: configBody,
    });

    const startUpid = (await nodeApi.qemu.vmid(newid).status.start()) as string;

    // Queue for DHCP → static conversion on next page load.
    pendingStaticConversion.set(newid, { name: newName, node: templateNode });

    return { cloneUpid, startUpid };
  } catch (error) {
    if (await isCloudInitCollisionError(newid, error)) {
      throw new Error(
        `Cloud-init LV collision while deploying VM (storage=${cloudInitStorage}, vmid=${newid}). ` +
          `The target cloud-init volume already exists for this VM ID. ` +
          `Please verify the cloud-init volume state with your administrator.`,
        { cause: error },
      );
    }

    throw error;
  }
};

/** Renames a QEMU template (or VM) by updating its config name. */
const renameVmTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<string | unknown> => {
  const client = await createClient();
  // TODO(pve-client): 'name' is a valid QEMU config field but missing from
  // the generated PUT body type. Fix in pve-client types; cast via
  // Record<string, unknown> for now.
  return await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { name: newName } as Record<string, unknown>,
  });
};

/** Detects Ubuntu 24.04 LXC container templates that require special handling. */
const isUbuntu2404Template = (templateVolid: string): boolean =>
  /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(templateVolid);

/** Deploys a new LXC container from a storage template. Returns the task UPID. */
const cloneLxcTemplate = async (
  templateVolid: string,
  templateNode: string,
  newName: string,
  rootPassword: string,
): Promise<string> => {
  const client = await createClient();
  const newid = (await client.api.cluster.nextid()) as number;
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const lxcHookscriptVolid =
    process.env.PVE_LXC_HOOKSCRIPT_VOLID?.trim() ||
    'local:snippets/lxc-post-create-hook.sh';
  const lxcRootfsStorage = process.env.PVE_LXC_ROOTFS_STORAGE?.trim();

  // See IssueUbuntuTemplate.md for why this path forces unprivileged+nested containers.
  const createBody = {
    vmid: newid,
    ostemplate: templateVolid,
    hostname: newName,
    password: rootPassword,
    ...(lxcRootfsStorage ? { storage: lxcRootfsStorage } : {}),
    net0: 'name=eth0,bridge=vmbr0,ip=dhcp,type=veth',
    hookscript: lxcHookscriptVolid,
    ...(isUbuntu2404Template(templateVolid)
      ? {
          unprivileged: true,
          features: 'nesting=1',
        }
      : {}),
  };

  return (await nodeApi.lxc.create(templateNode, {
    $path: { node: templateNode },
    $body: createBody,
  })) as string;
};

/**
 * Clones a converted LXC guest template to a new container and starts it.
 * Returns both the clone and start task UPIDs.
 */
const cloneLxcGuestTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<{ cloneUpid: string; startUpid: string }> => {
  const client = await createClient();
  const newid = (await client.api.cluster.nextid()) as number;
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const cloneUpid = (await nodeApi.lxc.id(templateId).clone({
    $body: { newid, hostname: newName, full: true },
  })) as string;

  await client.task.wait(cloneUpid);
  const startUpid = (await nodeApi.lxc.id(newid).status.start()) as string;

  return { cloneUpid, startUpid };
};

/** Renames a converted LXC guest template by updating hostname in config. */
const renameLxcGuestTemplate = async (
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<string | unknown> => {
  const client = await createClient();
  return await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { hostname: newName },
  });
};

// ---------------------------------------------------------------------------
// Action builder
// ---------------------------------------------------------------------------

/** Builds a SvelteKit form action handler for a given workload power action. */
const buildAction = (action: WorkloadAction) => {
  return async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;

    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const { upid, effectiveAction } = await executeWorkloadAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        action,
        selectedWorkload.status,
      );
      const actionLabel =
        effectiveAction === 'restart'
          ? 'Restarted'
          : effectiveAction === 'stop'
          ? 'Stopped'
          : 'Started';
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: `${actionLabel} ${kindLabel} ${selectedWorkload.id}${
          selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
        }.`,
        upid,
        workloadAction: effectiveAction,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  };
};

// ---------------------------------------------------------------------------
// SvelteKit form actions export
// ---------------------------------------------------------------------------

export const actions: Actions = {
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart'),

  configureWorkload: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
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
          formType: selectedWorkload.type,
        });
      }

      if (typeof memoryRaw !== 'string' || memoryRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Memory is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const cpuSharePercent = Number(cpuShareRaw);
      const memoryMiB = Number(memoryRaw);
      const storageGiB =
        typeof storageRaw === 'string' && storageRaw.trim().length > 0
          ? Number(storageRaw)
          : undefined;

      if (storageGiB != null && (!Number.isFinite(storageGiB) || storageGiB < 1)) {
        return fail(400, {
          status: 'error' as const,
          message: `Storage increase must be at least 1 GiB (got ${JSON.stringify(storageRaw)}).`,
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const { upid, appliedCpuLimit, appliedMemoryMiB, appliedCpuCores, appliedStorageGiB, storageTaskUpid } =
        await executeWorkloadConfigureAction(
          selectedWorkload.type,
          selectedWorkload.id,
          selectedWorkload.node,
          cpuSharePercent,
          memoryMiB,
          storageGiB,
        );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const cpuSummary =
        selectedWorkload.type === 'vm'
          ? `cores=${appliedCpuCores ?? Math.max(1, Math.round(appliedCpuLimit))}`
          : `cpulimit=${appliedCpuLimit}`;
      const storageSummary = appliedStorageGiB
        ? `, storage=+${appliedStorageGiB} GiB`
        : '';
      const taskSummary = [upid, storageTaskUpid].filter(
        (task): task is string => typeof task === 'string' && task.length > 0,
      );

      return {
        status: 'success' as const,
        message:
          taskSummary.length > 0
            ? `Updated ${kindLabel} ${selectedWorkload.id}${
                selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
              }: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary} — task${
                taskSummary.length > 1 ? 's' : ''
              } ${taskSummary.join(', ')}.`
            : `Updated ${kindLabel} ${selectedWorkload.id}${
                selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
              }: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary}.`,
        upid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  convertToTemplate: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);

      const { convertUpid, stopUpid } = await executeConvertToTemplateAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status,
      );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: stopUpid
          ? `Stopped ${kindLabel} ${selectedWorkload.id}${
              selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
            } and started template conversion — stop task ${stopUpid}, convert task ${convertUpid}.`
          : `Converting ${kindLabel} ${selectedWorkload.id}${
              selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
            } to template — task ${convertUpid}.`,
        upid: convertUpid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  cloneFromTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const ciUser = formData.get('ciUser');
      const ciPassword = formData.get('ciPassword');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'vm-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'vm-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'vm-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New VM name is required.',
          formType: 'vm-template',
        });
      }

      const nameError = validateProxmoxName(newName);
      if (nameError) {
        return fail(400, {
          status: 'error' as const,
          message: `VM name: ${nameError}`,
          formType: 'vm-template',
        });
      }

      if (typeof ciUser !== 'string' || ciUser.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Username is required for cloud-init.',
          formType: 'vm-template',
        });
      }

      const passwordError = validateStrongPassword(ciPassword);
      if (passwordError) {
        return fail(400, {
          status: 'error' as const,
          message: passwordError,
          formType: 'vm-template',
        });
      }

      const { cloneUpid, startUpid } = await deployVmFromTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
        ciUser.trim(),
        ciPassword as string,
      );

      return {
        status: 'success' as const,
        message: `Deploying "${newName.trim()}" — cloned VM is starting now.`,
        formType: 'vm-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid, startUpid],
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template',
      });
    }
  },

  renameVmTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Template name is required.',
        });
      }

      const renameNameError = validateProxmoxName(newName);
      if (renameNameError) {
        return fail(400, {
          status: 'error' as const,
          message: `Template name: ${renameNameError}`,
        });
      }

      const result = await renameVmTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
      );
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed template ${templateId} to "${newName.trim()}".`,
        formType: 'vm-template',
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template',
      });
    }
  },

  cloneLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'lxc-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New container name is required.',
          formType: 'lxc-template',
        });
      }

      const { cloneUpid, startUpid } = await cloneLxcGuestTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
      );

      return {
        status: 'success' as const,
        message:
          `Cloned guest template ${templateId} as "${newName.trim()}" — clone task ${cloneUpid}. ` +
          `Started container ${newName.trim()} — start task ${startUpid}.`,
        formType: 'lxc-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid, startUpid],
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },

  renameLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'lxc-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Template name is required.',
          formType: 'lxc-template',
        });
      }

      const result = await renameLxcGuestTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
      );
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming guest template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed guest template ${templateId} to "${newName.trim()}".`,
        formType: 'lxc-template',
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },

  destroy: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const { destroyUpid, stopUpid } = await executeDestroyAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status,
      );
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const stopPrefix = stopUpid
        ? `Stopped ${kindLabel} ${selectedWorkload.id}${
            selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
          } — task ${stopUpid}. `
        : '';
      return {
        status: 'success' as const,
        message: `${stopPrefix}Destroyed ${kindLabel} ${selectedWorkload.id}${
          selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
        } — task ${destroyUpid}.`,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  cloneLxcTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateVolid = formData.get('templateVolid');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const rootPassword = formData.get('rootPassword');

      if (typeof templateVolid !== 'string' || templateVolid.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template volume ID.',
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New container name is required.',
          formType: 'lxc-template',
        });
      }

      const passwordError = validateStrongPassword(rootPassword);
      if (passwordError) {
        return fail(400, {
          status: 'error' as const,
          message: passwordError,
          formType: 'lxc-template',
        });
      }

      const upid = await cloneLxcTemplate(
        templateVolid.trim(),
        templateNode.trim(),
        newName.trim(),
        rootPassword as string,
      );

      return {
        status: 'success' as const,
        message: `Deploying LXC template "${templateVolid}" as "${newName.trim()}" — task ${upid}.`,
        formType: 'lxc-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [upid],
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },
};
