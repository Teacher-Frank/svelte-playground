import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const lxcStop = vi.fn();
  const qemuStop = vi.fn();
  const lxcDelete = vi.fn();
  const qemuDelete = vi.fn();
  const qemuStart = vi.fn();
  const start = vi.fn();
  const lxcClone = vi.fn();
  const qemuClone = vi.fn();
  const taskWait = vi.fn();
  const request = vi.fn();
  const storageContentList = vi.fn();
  const storageGet = vi.fn(() => ({
    content: {
      list: storageContentList,
    },
  }));
  const nodeGet = vi.fn(() => ({
    storage: {
      get: storageGet,
    },
    qemu: {
      vmid: vi.fn(() => ({
        status: {
          stop: qemuStop,
          start: qemuStart,
        },
        delete: qemuDelete,
        clone: qemuClone,
      })),
    },
    lxc: {
      id: vi.fn(() => ({
        status: {
          stop: lxcStop,
          start,
        },
        delete: lxcDelete,
        clone: lxcClone,
      })),
    },
  }));

  const nextid = vi.fn();

  return {
    lxcStop,
    qemuStop,
    lxcDelete,
    qemuDelete,
    qemuStart,
    start,
    lxcClone,
    qemuClone,
    taskWait,
    request,
    storageContentList,
    storageGet,
    nodeGet,
    nextid
  };
});

vi.mock('pve-client', () => ({
  Client: class {
    api = {
      cluster: {
        nextid: mocks.nextid,
      },
      nodes: {
        get: mocks.nodeGet,
      },
    };

    task = {
      wait: mocks.taskWait,
    };

    request = mocks.request;

    login = vi.fn();

    constructor() {}
  },
}));

import { actions } from '../../../src/routes/proxmox/+page.server.ts';

/**
 * Flushes the setTimeout(..., 0) queue so that assertions can inspect
 * synchronous work dispatched by `deployVmFromTemplate`.
 * The deploy function starts a clone, then queues config + start in a
 * background callback — we need to wait for that callback before asserting
 * on config PUT, start, etc.
 */
const flushTimers = async () => new Promise((resolve) => setTimeout(resolve, 0));

const makeEvent = (fields: Record<string, string>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.set(key, value);
  }

  return {
    request: new Request('http://localhost/proxmox', {
      method: 'POST',
      body: formData,
    }),
  } as Parameters<NonNullable<typeof actions.convertToTemplate>>[0];
};

describe('proxmox page server actions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.PVE_BASE_URL = 'https://pve.example.com:8006';
    process.env.PVE_API_TOKEN = 'root@pam!token=abc123';
    process.env.PVE_ADMIN_CONTACT_EMAIL = 'infra-admin@example.com';
    delete process.env.PVE_VM_CLOUDINIT_STORAGE;

    mocks.lxcStop.mockResolvedValue('UPID:lxc-stop-task');
    mocks.qemuStop.mockResolvedValue('UPID:vm-stop-task');
    mocks.qemuStart.mockResolvedValue('UPID:vm-start-task');
    mocks.qemuDelete.mockResolvedValue('UPID:vm-destroy-task');
    mocks.lxcDelete.mockResolvedValue('UPID:lxc-destroy-task');
    mocks.qemuClone.mockResolvedValue('UPID:vm-clone-task');
    mocks.start.mockResolvedValue('UPID:start-task');
    mocks.lxcClone.mockResolvedValue('UPID:lxc-clone-task');
    mocks.taskWait.mockResolvedValue([]);
    mocks.nextid.mockResolvedValue(200);
    mocks.storageContentList.mockResolvedValue([]);
    mocks.request.mockImplementation(async (path: string, method?: string, payload?: Record<string, unknown>) => {
      if (path === '/nodes/{node}/status') {
        return {
          cpuinfo: { cpus: 16 },
          memory: { total: 64 * 1024 * 1024 * 1024 },
          rootfs: { total: 500 * 1024 * 1024 * 1024, avail: 200 * 1024 * 1024 * 1024 },
        };
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'GET') return {};
      if (path === '/nodes/{node}/lxc/{vmid}/template') return 'UPID:convert-task';
      if (path === '/nodes/{node}/qemu/{vmid}/template') return 'UPID:vm-convert-task';
      if (path === '/nodes/{node}/lxc/{vmid}/config' && payload?.$body) return 'UPID:lxc-config-task';
      // PUT is synchronous cloud-init config; POST is rename/configure
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'PUT') return null;
      if (path === '/nodes/{node}/qemu/{vmid}/config') return 'UPID:rename-task';
      return 'UPID:other-task';
    });
  });

  it('convertToTemplate stops running containers before conversion', async () => {
    const result = await actions.convertToTemplate(
      makeEvent({ type: 'container', id: '200', node: 'pve1', name: 'api-ct', status: 'running' })
    );

    expect(mocks.lxcStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:lxc-stop-task');
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/template', 'POST', {
      $path: { node: 'pve1', vmid: 200 },
    });

    expect(result.status).toBe('success');
    expect(result.upid).toBe('UPID:convert-task');
    expect(result.message).toContain('Stopped container 200 (api-ct)');
  });

  it('convertToTemplate skips stop for already stopped containers', async () => {
    const result = await actions.convertToTemplate(
      makeEvent({ type: 'container', id: '201', node: 'pve1', name: 'db-ct', status: 'stopped' })
    );

    expect(mocks.lxcStop).not.toHaveBeenCalled();
    expect(mocks.taskWait).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/template', 'POST', {
      $path: { node: 'pve1', vmid: 201 },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Converting container 201 (db-ct) to template');
  });

  it('convertToTemplate supports running VMs with stop then qemu template conversion', async () => {
    const result = await actions.convertToTemplate(
      makeEvent({ type: 'vm', id: '100', node: 'pve1', name: 'web-vm', status: 'running' })
    );

    expect(mocks.qemuStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-stop-task');
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/template', 'POST', {
      $path: { node: 'pve1', vmid: 100 },
    });

    expect(result.status).toBe('success');
    expect(result.upid).toBe('UPID:vm-convert-task');
    expect(result.message).toContain('Stopped VM 100 (web-vm)');
  });

  it('configureWorkload applies LXC cpulimit and memory settings', async () => {
    const result = await actions.configureWorkload(
      makeEvent({
        type: 'container',
        id: '202',
        node: 'pve1',
        name: 'api-ct',
        cpuSharePercent: '50',
        memoryMiB: '2048',
      })
    );

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/status', 'GET', {
      $path: { node: 'pve1' },
    });
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 202 },
      $body: { cpulimit: 8, memory: 2048 },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Updated container 202 (api-ct): cpulimit=8, memory=2048 MiB');
  });

  it('configureWorkload applies VM cores and memory settings', async () => {
    const result = await actions.configureWorkload(
      makeEvent({
        type: 'vm',
        id: '110',
        node: 'pve1',
        name: 'build-vm',
        cpuSharePercent: '50',
        memoryMiB: '4096',
      })
    );

    // QEMU config endpoint uses PUT (not POST) and expects memory as number (not string)
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 110 },
      $body: { cores: 8, memory: 4096 },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Updated VM 110 (build-vm): cores=8, memory=4096 MiB');
  });

  it('configureWorkload optionally expands container storage', async () => {
    const result = await actions.configureWorkload(
      makeEvent({
        type: 'container',
        id: '203',
        node: 'pve1',
        name: 'disk-ct',
        cpuSharePercent: '25',
        memoryMiB: '1024',
        storageGiB: '10',
      })
    );

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/resize', 'PUT', {
      $path: { node: 'pve1', vmid: 203 },
      $body: { disk: 'rootfs', size: '+10G' },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('storage=+10 GiB');
  });

  it('cloneFromTemplate clones, applies cloud-init credentials, configures guest agent, and starts the VM', async () => {
    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    // Clone is called and its task awaited before config is applied
    expect(mocks.qemuClone).toHaveBeenCalledWith({
      $body: { newid: 200, name: 'my-vm', full: true },
    });

    // Wait for background post-clone steps (config PUT, start) to run
    await flushTimers();

    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-clone-task');

    // Cloud-init drive, credentials, and guest agent config applied via PUT config
    // (cicommand intentionally absent — not a supported Proxmox API parameter, confirmed 2026-06-19)
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({
        ide2: 'local-lvm:cloudinit',
        ciuser: 'ubuntu',
        cipassword: 'StrongPassw0rd!',
      }),
    });

    // VM is started after config
    expect(mocks.qemuStart).toHaveBeenCalledTimes(1);

    expect(result.status).toBe('success');
    expect((result as { deployWorkloadName: string }).deployWorkloadName).toBe('my-vm');
    expect((result as { deployTaskNode: string }).deployTaskNode).toBe('pve1');
    // Non-blocking deploy returns only cloneUpid — start runs in background
    expect((result as { deployTaskUpids: string[] }).deployTaskUpids).toEqual([
      'UPID:vm-clone-task',
    ]);
  });

  it('cloneFromTemplate adds net0 and ipconfig0 when cloned VM has no network config', async () => {
    mocks.request.mockImplementation(async (path: string, method?: string, payload?: Record<string, unknown>) => {
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'GET') {
        return {
          ide2: 'local-lvm:cloudinit,media=cdrom',
        };
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'PUT') {
        return null;
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config') return 'UPID:rename-task';
      if (path === '/nodes/{node}/lxc/{vmid}/template') return 'UPID:convert-task';
      if (path === '/nodes/{node}/qemu/{vmid}/template') return 'UPID:vm-convert-task';
      if (path === '/nodes/{node}/lxc/{vmid}/config' && payload?.$body) return 'UPID:lxc-config-task';
      return 'UPID:other-task';
    });

    await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    // Wait for background post-clone steps
    await flushTimers();

    // QEMU config uses PUT with agent enabled (standard deployment behavior)
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({
        ciuser: 'ubuntu',
        cipassword: 'StrongPassw0rd!',
        agent: 'enabled=1',
        net0: 'virtio,bridge=vmbr0',
        ipconfig0: 'ip=dhcp',
      }),
    });
  });

  it('cloneFromTemplate does not reattach cloud-init when clone already has one', async () => {
    mocks.request.mockImplementation(async (path: string, method?: string, payload?: Record<string, unknown>) => {
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'GET') {
        return {
          ide2: 'local-lvm:cloudinit,media=cdrom',
          net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0',
          ipconfig0: 'ip=dhcp',
        };
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'PUT') {
        return null;
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config') return 'UPID:rename-task';
      if (path === '/nodes/{node}/lxc/{vmid}/template') return 'UPID:convert-task';
      if (path === '/nodes/{node}/qemu/{vmid}/template') return 'UPID:vm-convert-task';
      if (path === '/nodes/{node}/lxc/{vmid}/config' && payload?.$body) return 'UPID:lxc-config-task';
      return 'UPID:other-task';
    });

    await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    // Wait for background post-clone steps
    await flushTimers();

    // QEMU config uses PUT with agent enabled
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({
        ciuser: 'ubuntu',
        cipassword: 'StrongPassw0rd!',
        agent: 'enabled=1',
      }),
    });
  });

  it('cloneFromTemplate fails without retrying when cloud-init LV already exists', async () => {
    mocks.storageContentList.mockResolvedValueOnce([
      { volid: 'local-lvm:vm-200-cloudinit' },
    ]);
    mocks.nextid.mockResolvedValueOnce(200).mockResolvedValueOnce(201);
    // Orphan cleanup path: stop the cloned VM, then delete it
    mocks.qemuStop.mockResolvedValueOnce('UPID:orphan-stop');
    mocks.qemuDelete.mockResolvedValueOnce('UPID:orphan-delete');
    mocks.request.mockImplementation(async (path: string, method?: string, payload?: Record<string, unknown>) => {
      if (path === '/nodes/{node}/status') {
        return {
          cpuinfo: { cpus: 16 },
          memory: { total: 64 * 1024 * 1024 * 1024 },
        };
      }
      if (
        path === '/nodes/{node}/qemu/{vmid}/config' &&
        method === 'PUT' &&
        payload?.$path &&
        (payload.$path as { vmid?: number }).vmid === 200
      ) {
        throw new Error('lvcreate \'pve/vm-200-cloudinit\' error: Logical Volume "vm-200-cloudinit" already exists in volume group "pve"');
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'PUT') {
        return null;
      }
      if (path === '/nodes/{node}/qemu/{vmid}/config') return 'UPID:rename-task';
      if (path === '/nodes/{node}/lxc/{vmid}/template') return 'UPID:convert-task';
      if (path === '/nodes/{node}/qemu/{vmid}/template') return 'UPID:vm-convert-task';
      if (path === '/nodes/{node}/lxc/{vmid}/config' && payload?.$body) return 'UPID:lxc-config-task';
      return 'UPID:other-task';
    });

    await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    // Wait for background post-clone steps (this one will fail and trigger orphan cleanup)
    await flushTimers();

    expect(mocks.qemuClone).toHaveBeenNthCalledWith(1, {
      $body: { newid: 200, name: 'my-vm', full: true },
    });
    // Orphan cleanup runs after clone completes — the VM was cloned but config failed,
    // so the orphan is destroyed (stop first, then delete with purge).
    expect(mocks.qemuDelete).toHaveBeenCalledWith({ $query: { purge: true } });
    expect(mocks.qemuClone).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({ ide2: 'local-lvm:cloudinit' }),
    });
  });

  it('cloneFromTemplate does not classify template cloud-init volumes as a collision', async () => {
    mocks.storageContentList.mockResolvedValueOnce([
      { volid: 'local-lvm:vm-9000-cloudinit' },
      { volid: 'local-lvm:vm-9001-cloudinit' },
    ]);
    mocks.nextid.mockResolvedValueOnce(101);
    mocks.qemuStop.mockResolvedValueOnce('UPID:orphan-stop');
    mocks.qemuDelete.mockResolvedValueOnce('UPID:orphan-delete');
    // This test checks error messages for cloud-init collisions that are NOT
    // the deployment-target-VMID (i.e. the template volume error case).
    // The current action no longer retries on collision — it fails fast.
    // Because the config PUT fails during background execution, the error is
    // caught and logged; the action itself returns success (clone started).
    mocks.request.mockImplementation(async (path: string, method?: string, payload?: Record<string, unknown>) => {
      if (path === '/nodes/{node}/qemu/{vmid}/config' && method === 'PUT') {
        throw new Error('lvcreate \'pve/vm-101-cloudinit\' error: Logical Volume "vm-101-cloudinit" already exists in volume group "pve"');
      }
      return 'UPID:other-task';
    });

    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '9001',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    // Clone starts successfully; config/start runs in background and fails there.
    // The action returns {status: 'success'} because the clone task was accepted.
    expect(result.status).toBe('success');

    // Wait for background to complete so orphan cleanup runs
    await flushTimers();

    // Orphan VM should be cleaned up
    expect(mocks.qemuDelete).toHaveBeenCalledWith({ $query: { purge: true } });
  });

  it('cloneFromTemplate rejects a name that is not a valid Proxmox DNS name', async () => {
    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my vm with spaces!',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    expect((result as { status: number }).status).toBe(400);
    expect((result as { data: { message: string } }).data.message).toContain('my vm with spaces!');
    expect(mocks.qemuClone).not.toHaveBeenCalled();
  });

  it('cloneFromTemplate rejects a weak cloud-init password', async () => {
    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'weak',
      })
    );

    expect((result as { status: number }).status).toBe(400);
    expect(mocks.qemuClone).not.toHaveBeenCalled();
  });

  it('cloneFromTemplate rejects a missing username', async () => {
    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: '',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    expect((result as { status: number }).status).toBe(400);
    expect((result as { data: { message: string } }).data.message).toContain('Username is required');
    expect(mocks.qemuClone).not.toHaveBeenCalled();
  });

  it('renameVmTemplate updates template name through qemu config endpoint', async () => {
    const result = await actions.renameVmTemplate(
      makeEvent({ templateId: '900', templateNode: 'pve1', newName: 'ubuntu-base' })
    );

    // QEMU config endpoint uses PUT (not POST) with Record<string, unknown> cast for name field
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 900 },
      $body: { name: 'ubuntu-base' },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Renamed template 900 to "ubuntu-base"');
  });

  it('renameVmTemplate returns validation failure when newName is missing', async () => {
    const result = await actions.renameVmTemplate(
      makeEvent({ templateId: '900', templateNode: 'pve1', newName: '' })
    );

    expect((result as { status: number }).status).toBe(400);
    expect((result as { data: { message: string } }).data.message).toContain('Template name is required.');
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it('cloneLxcGuestTemplate clones and starts a converted guest template with a new hostname', async () => {
    const result = await actions.cloneLxcGuestTemplate(
      makeEvent({ templateId: '210', templateNode: 'pve1', newName: 'cloned-ct' })
    );

    expect(mocks.lxcClone).toHaveBeenCalledWith({
      $body: { newid: 200, hostname: 'cloned-ct', full: true },
    });
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:lxc-clone-task');
    expect(mocks.start).toHaveBeenCalledTimes(1);

    expect(result.status).toBe('success');
    expect(result.message).toContain('Cloned guest template 210 as "cloned-ct"');
    expect(result.message).toContain('Started container cloned-ct');
    expect((result as { deployWorkloadName: string }).deployWorkloadName).toBe('cloned-ct');
    expect((result as { deployTaskNode: string }).deployTaskNode).toBe('pve1');
    expect((result as { deployTaskUpids: string[] }).deployTaskUpids).toEqual([
      'UPID:lxc-clone-task',
      'UPID:start-task',
    ]);
  });

  it('renameLxcGuestTemplate updates guest template hostname', async () => {
    const result = await actions.renameLxcGuestTemplate(
      makeEvent({ templateId: '210', templateNode: 'pve1', newName: 'renamed-ct-template' })
    );

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 210 },
      $body: { hostname: 'renamed-ct-template' },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Renaming guest template 210 to "renamed-ct-template"');
  });

  it('destroy fires stop then queues delete in background (running VM)', async () => {
    const result = await actions.destroy(
      makeEvent({ type: 'vm', id: '101', node: 'pve1', name: 'ci-vm', status: 'running' })
    );

    expect(mocks.qemuStop).toHaveBeenCalledTimes(1);
    // Stop fires synchronously; delete is queued in setTimeout (not yet executed)
    expect(mocks.taskWait).not.toHaveBeenCalled();
    expect(mocks.qemuDelete).not.toHaveBeenCalled();

    expect(result.status).toBe('success');
    expect(result.message).toContain('Destroying VM 101 (ci-vm)');
    expect(result.message).toContain('stop task');
    expect(result.message).toContain('may take a moment');

    // Flush setTimeout so background destroy runs
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now the background task should have waited for stop then deleted
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-stop-task');
    expect(mocks.qemuDelete).toHaveBeenCalledWith({ $query: { purge: true } });
  });

  it('destroy queues delete only for stopped VM', async () => {
    const result = await actions.destroy(
      makeEvent({ type: 'vm', id: '101', node: 'pve1', name: 'ci-vm', status: 'stopped' })
    );

    expect(mocks.qemuStop).not.toHaveBeenCalled();
    expect(mocks.qemuDelete).not.toHaveBeenCalled();

    expect(result.status).toBe('success');
    expect(result.message).toContain('Destroying VM 101 (ci-vm)');

    // Flush setTimeout
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mocks.qemuDelete).toHaveBeenCalledWith({ $query: { purge: true } });
  });

  it('destroy still returns error when stop fails (running VM)', async () => {
    mocks.qemuStop.mockRejectedValueOnce(new Error('VM is locked'));

    mocks.qemuStop.mockRejectedValueOnce(new Error('VM is locked'));

    // Stop failure will be caught by the catch block in the action
    const result = await actions.destroy(
      makeEvent({ type: 'vm', id: '101', node: 'pve1', name: 'ci-vm', status: 'running' })
    );

    expect(mocks.qemuStop).toHaveBeenCalledTimes(1);
    expect((result as Record<string, unknown>).status).toBe(500);
    expect((result as Record<string, unknown>).data?.message).toContain('VM is locked');
  });

  it('destroy fires stop then queues delete in background (running container)', async () => {
    const result = await actions.destroy(
      makeEvent({ type: 'container', id: '202', node: 'pve1', name: 'ci-ct', status: 'running' })
    );

    expect(mocks.lxcStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).not.toHaveBeenCalled();
    expect(mocks.lxcDelete).not.toHaveBeenCalled();

    expect(result.status).toBe('success');
    expect(result.message).toContain('Destroying container 202 (ci-ct)');
    expect(result.message).toContain('stop task');
    expect(result.message).toContain('may take a moment');

    // Flush setTimeout
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:lxc-stop-task');
    expect(mocks.lxcDelete).toHaveBeenCalledWith({ $query: { purge: true, force: true } });
  });
});
