/**
 * Template deployment helpers — VM/LXC clone, rename, and deploy operations.
 *
 * Extracted from proxmox-actions.ts to keep that module under the 750-line threshold.
 */
import type { NodeScopedAPI } from 'pve-client';
import { createClient, pendingStaticConversion } from './helpers.js';

/**
 * Clones a QEMU VM template, applies cloud-init credentials, configures
 * guest agent and network, then starts the VM.
 */
export async function deployVmFromTemplate(
  templateId: number,
  templateNode: string,
  newName: string,
  ciUser: string,
  ciPassword: string,
): Promise<{ cloneUpid: string; startUpid: string }> {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const cloudInitStorage = process.env.PVE_VM_CLOUDINIT_STORAGE?.trim() || 'local-lvm';
  const snippetStorage = process.env.PVE_SNIPPET_STORAGE?.trim() || 'local';
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

    // Use cicustom cloud-init snippet to install qemu-guest-agent on first boot.
    // The snippet (install-agent.yaml) must be deployed to Proxmox host first:
    //   scripts/host/deploy-cloudinit-snippets.sh
    // See: featuredocs/feature-deploy.md for full investigation and design notes.
    configBody.cicustom = `user=${snippetStorage}:snippets/install-agent.yaml`;

    await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: templateNode, vmid: newid },
      $body: configBody,
    });

    const startUpid = (await nodeApi.qemu.vmid(newid).status.start()) as string;

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
}

/** Renames a QEMU template (or VM) by updating its config name. */
export async function renameVmTemplate(
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<string | unknown> {
  const client = await createClient();
  return await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { name: newName } as Record<string, unknown>,
  });
}

/** Detects Ubuntu 24.04 LXC container templates that require special handling. */
export function isUbuntu2404Template(templateVolid: string): boolean {
  return /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(templateVolid);
}

/** Deploys a new LXC container from a storage template. Returns the task UPID. */
export async function cloneLxcTemplate(
  templateVolid: string,
  templateNode: string,
  newName: string,
  rootPassword: string,
): Promise<string> {
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

  return await nodeApi.lxc.create({
    $body: createBody,
  });
}

/**
 * Clones a converted LXC guest template to a new container and starts it.
 * Returns both the clone and start task UPIDs.
 */
export async function cloneLxcGuestTemplate(
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<{ cloneUpid: string; startUpid: string }> {
  const client = await createClient();
  const newid = (await client.api.cluster.nextid()) as number;
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);
  const cloneUpid = (await nodeApi.lxc.id(templateId).clone({
    $body: { newid, hostname: newName, full: true },
  })) as string;

  await client.task.wait(cloneUpid);
  const startUpid = (await nodeApi.lxc.id(newid).status.start()) as string;

  return { cloneUpid, startUpid };
}

/** Renames a converted LXC guest template by updating hostname in config. */
export async function renameLxcGuestTemplate(
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<string | unknown> {
  const client = await createClient();
  // TODO(pve-client): 'hostname' is a valid LXC config field but missing from
  // the generated PUT body type. Fix in pve-client types; cast for now.
  return await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { hostname: newName } as Record<string, unknown>,
  });
}
