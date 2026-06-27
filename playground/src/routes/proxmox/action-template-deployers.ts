/**
 * Template deployment helpers — VM/LXC clone, rename, and deploy operations.
 *
 * Extracted from proxmox-actions.ts to keep that module under the 750-line threshold.
 */
import type { NodeScopedAPI } from 'pve-client';
import { createClient, pendingStaticConversion } from './helpers.js';

// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------

const cloudInitStorage =
  process.env.PVE_VM_CLOUDINIT_STORAGE?.trim() || 'local-lvm';
const snippetStorage =
  process.env.PVE_SNIPPET_STORAGE?.trim() || 'local';
const vmNetworkModel =
  process.env.PVE_VM_NETWORK_MODEL?.trim() || 'virtio';
const vmNetworkBridge =
  process.env.PVE_VM_NETWORK_BRIDGE?.trim() || 'vmbr0';

/**
 * Detects cloud-init logical volume collision errors from Proxmox.
 * These occur when a previous deployment attempt left behind a stale LV.
 */
async function isCloudInitCollisionError(
  vmid: number,
  error: unknown,
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`-${vmid}-`) && (message.includes('cloudinit') || message.includes('already exists'));
}

/**
 * Clones a QEMU VM template, applies cloud-init credentials, configures
 * guest agent and network, then starts the VM.
 *
 * Architecture: The clone task is started synchronously (fast ~100ms), then the
 * remaining work (wait for clone, apply config, start VM) runs asynchronously
 * so the HTTP response returns immediately.
 *
 * The deployer function returns { cloneUpid } for tracking. The startUpid is
 * only available after the async phase completes, tracked via Proxmox task logs.
 */
export async function deployVmFromTemplate(
  templateId: number,
  templateNode: string,
  newName: string,
  ciUser: string,
  ciPassword: string,
): Promise<{ cloneUpid: string; newid: number }> {
  const client = await createClient();
  const nodeApi: NodeScopedAPI = client.api.nodes.get(templateNode);

  const newid = (await client.api.cluster.nextid()) as number;

  // Phase 1: Start the clone task (returns immediately, ~100ms)
  const cloneUpid = (await nodeApi.qemu.vmid(templateId).clone({
    $body: { newid, name: newName, full: true },
  })) as string;

  // Phase 2: Wait for clone, apply config, start VM — runs in background.
  // Queue after current tick so the HTTP response can send first.
  setTimeout(() => {
    runPostCloneSteps(client, nodeApi, templateNode, newid, cloneUpid, {
      newName,
      ciUser,
      ciPassword,
    }).catch((error) => {
      console.error(
        `[proxmox] Background deploy failed for VM ${newid} "${newName}":`,
        error,
      );
    });
  }, 0);

  return { cloneUpid, newid };
}

/**
 * Destroys an orphan VM that was cloned but failed during config/start.
 * This is the cleanup path for `runPostCloneSteps` — the VM exists (the clone
 * task succeeded) but we failed before it could start cleanly.
 *
 * Strategy: stop first if running, then destroy. Both are fire-and-forget
 * we don't block waiting, since this is already an error path.
 */
async function destroyOrphanVm(
  nodeApi: NodeScopedAPI,
  node: string,
  vmid: number,
  name: string,
): Promise<void> {
  console.warn(
    `[proxmox] Cleaning up orphan VM ${vmid} "${name}" on ${node}`,
  );

  try {
    // Stop if the orphan somehow started (e.g., autostart or race)
    const stopUpid = (await nodeApi.qemu.vmid(vmid).status.stop()) as string;
    console.info(`[proxmox] Orphan VM ${vmid} stop task: ${stopUpid}`);
  } catch (stopError) {
    // Ignore stop errors — VM may not be running, or may already be stopped
    console.info(
      `[proxmox] Orphan VM ${vmid} stop skipped (not running or already stopped):`,
      stopError instanceof Error ? stopError.message : String(stopError),
    );
  }

  try {
    const destroyUpid = (await nodeApi.qemu.vmid(vmid).delete({
      $query: { purge: true },
    })) as string;
    console.info(`[proxmox] Orphan VM ${vmid} destroy task: ${destroyUpid}`);
  } catch (destroyError) {
    // If destroy fails the orphan survives — log for manual cleanup
    console.error(
      `[proxmox] FAILED to destroy orphan VM ${vmid}:`,
      destroyError instanceof Error ? destroyError.message : String(destroyError),
    );
  }
}

/**
 * Runs the post-clone work: wait for clone, apply config, start VM.
 * If any step fails after a successful clone, destroys the orphan VM.
 */
async function runPostCloneSteps(
  client: Awaited<ReturnType<typeof createClient>>,
  nodeApi: NodeScopedAPI,
  templateNode: string,
  newid: number,
  cloneUpid: string,
  params: {
    newName: string;
    ciUser: string;
    ciPassword: string;
  },
): Promise<{ cloneUpid: string; startUpid: string }> {
  const {
    newName,
    ciUser,
    ciPassword,
  } = params;

  // Track whether clone has completed — only attempt orphan cleanup after clone success
  let cloneCompleted = false;

  try {
    // Wait for the clone task to finish before we can configure the new VM
    await client.task.wait(cloneUpid);
    cloneCompleted = true;

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
    const existingSerial0 = clonedConfig['serial0'] as string | undefined;
    const hasUsableSerial =
      typeof existingSerial0 === 'string' &&
      existingSerial0.length > 0 &&
      existingSerial0.toLowerCase() !== 'none';
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
    if (!hasUsableSerial) {
      console.info(
        `[proxmox] Cloned VM ${newid} has no usable serial0 (current: "${existingSerial0 ?? 'undefined'}"); adding serial0=socket for terminal access.`
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
    if (!hasUsableSerial) {
      configBody['serial0'] = 'socket';
    }

    const existingAgent = clonedConfig.agent as string | undefined;
    if (!existingAgent?.includes('enabled=1')) {
      configBody.agent = 'enabled=1';
    }

    // Use cicustom cloud-init snippet to install qemu-guest-agent on first boot.
    // The snippet (install-agent.yaml) must be deployed to Proxmox host first:
    //   scripts/host/deploy-cloudinit-snippets.sh
    // See: featuredocs/feature-deploy.md for full investigation and design notes.
    //
    // IMPORTANT: Use `vendor=` NOT `user=` — Proxmox auto-generates the user-data
    // file from ciuser/cipassword parameters. Using `user=` would *replace* that
    // file, so the cloud-init credentials would never be written to the VM.
    // The vendor-data file is merged on top of user-data, keeping both the
    // password from Proxmox and the agent install commands from the snippet.
    configBody.cicustom = `vendor=${snippetStorage}:snippets/install-agent.yaml`;

    await client.request('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: templateNode, vmid: newid },
      $body: configBody,
    });

    const startUpid = (await nodeApi.qemu.vmid(newid).status.start()) as string;

    pendingStaticConversion.set(newid, { name: newName, node: templateNode });

    return { cloneUpid, startUpid };
  } catch (error) {
    // If the clone succeeded but config/start failed, destroy the orphan VM
    if (cloneCompleted) {
      await destroyOrphanVm(nodeApi, templateNode, newid, newName);
    }

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
