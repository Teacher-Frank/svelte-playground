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

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'POST', {
      $path: { node: 'pve1', vmid: 110 },
      $body: { cores: 8, memory: '4096' },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Updated VM 110 (build-vm): cores=8, memory=4096 MiB');
  });

  it('cloneFromTemplate clones, applies cloud-init credentials, and starts the VM', async () => {
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
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-clone-task');

    // Cloud-init drive and credentials applied via PUT config
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
    expect(result.message).toContain('UPID:vm-clone-task');
    expect(result.message).toContain('UPID:vm-start-task');
    expect((result as { deployWorkloadName: string }).deployWorkloadName).toBe('my-vm');
    expect((result as { deployTaskNode: string }).deployTaskNode).toBe('pve1');
    expect((result as { deployTaskUpids: string[] }).deployTaskUpids).toEqual([
      'UPID:vm-clone-task',
      'UPID:vm-start-task',
    ]);
  });

  it('cloneFromTemplate attaches cloud-init drive using configured storage env var', async () => {
    process.env.PVE_VM_CLOUDINIT_STORAGE = 'ceph-fast';

    await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({
        ide2: 'ceph-fast:cloudinit',
      }),
    });
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

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: {
        ciuser: 'ubuntu',
        cipassword: 'StrongPassw0rd!',
        net0: 'virtio,bridge=vmbr0',
        ipconfig0: 'ip=dhcp',
      },
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

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: {
        ciuser: 'ubuntu',
        cipassword: 'StrongPassw0rd!',
      },
    });
  });

  it('cloneFromTemplate fails without retrying when cloud-init LV already exists', async () => {
    mocks.storageContentList.mockResolvedValueOnce([
      { volid: 'local-lvm:vm-200-cloudinit' },
    ]);
    mocks.nextid.mockResolvedValueOnce(200).mockResolvedValueOnce(201);
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

    const result = await actions.cloneFromTemplate(
      makeEvent({
        templateId: '900',
        templateNode: 'pve1',
        newName: 'my-vm',
        ciUser: 'ubuntu',
        ciPassword: 'StrongPassw0rd!',
      })
    );

    expect(mocks.qemuClone).toHaveBeenNthCalledWith(1, {
      $body: { newid: 200, name: 'my-vm', full: true },
    });
    expect(mocks.qemuDelete).not.toHaveBeenCalled();
    expect(mocks.qemuClone).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'PUT', {
      $path: { node: 'pve1', vmid: 200 },
      $body: expect.objectContaining({ ide2: 'local-lvm:cloudinit' }),
    });
    expect((result as { status: number }).status).toBe(500);
    expect((result as { data: { message: string } }).data.message).toContain('Cloud-init LV collision while deploying VM');
  });

  it('cloneFromTemplate does not classify template cloud-init volumes as a collision', async () => {
    mocks.storageContentList.mockResolvedValueOnce([
      { volid: 'local-lvm:vm-9000-cloudinit' },
      { volid: 'local-lvm:vm-9001-cloudinit' },
    ]);

    mocks.request.mockImplementation(async (path: string, method?: string) => {
      if (path === '/nodes/{node}/status') {
        return {
          cpuinfo: { cpus: 16 },
          memory: { total: 64 * 1024 * 1024 * 1024 },
        };
      }
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

    expect((result as { status: number }).status).toBe(500);
    expect((result as { data: { message: string } }).data.message).not.toContain('Cloud-init LV collision while deploying VM');
    expect((result as { data: { message: string } }).data.message).toContain('Logical Volume "vm-101-cloudinit" already exists');
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

    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/qemu/{vmid}/config', 'POST', {
      $path: { node: 'pve1', vmid: 900 },
      $body: { name: 'ubuntu-base' },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Renaming template 900 to "ubuntu-base"');
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

  it('destroy auto-stops a running VM before delete', async () => {
    const result = await actions.destroy(
      makeEvent({ type: 'vm', id: '101', node: 'pve1', name: 'ci-vm', status: 'running' })
    );

    expect(mocks.qemuStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-stop-task');
    expect(mocks.qemuDelete).toHaveBeenCalledWith({ $query: { purge: true } });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Stopped VM 101 (ci-vm)');
    expect(result.message).toContain('Destroyed VM 101 (ci-vm)');
  });

  it('destroy retries with stop when API reports running VM and status was not provided', async () => {
    mocks.qemuDelete
      .mockRejectedValueOnce(new Error('VM 101 is running - destroy failed\n'))
      .mockResolvedValueOnce('UPID:vm-destroy-task');

    const result = await actions.destroy(
      makeEvent({ type: 'vm', id: '101', node: 'pve1', name: 'ci-vm' })
    );

    expect(mocks.qemuStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:vm-stop-task');
    expect(mocks.qemuDelete).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('success');
    expect(result.message).toContain('Stopped VM 101 (ci-vm)');
    expect(result.message).toContain('Destroyed VM 101 (ci-vm)');
  });

  it('destroy auto-stops a running container before delete', async () => {
    const result = await actions.destroy(
      makeEvent({ type: 'container', id: '202', node: 'pve1', name: 'ci-ct', status: 'running' })
    );

    expect(mocks.lxcStop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:lxc-stop-task');
    expect(mocks.lxcDelete).toHaveBeenCalledWith({ $query: { purge: true, force: true } });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Stopped container 202 (ci-ct)');
    expect(result.message).toContain('Destroyed container 202 (ci-ct)');
  });
});
