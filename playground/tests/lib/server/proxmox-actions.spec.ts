import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const stop = vi.fn();
  const start = vi.fn();
  const lxcClone = vi.fn();
  const taskWait = vi.fn();
  const request = vi.fn();
  const nodeGet = vi.fn(() => ({
    lxc: {
      id: vi.fn(() => ({
        status: {
          stop,
          start,
        },
        clone: lxcClone,
      })),
    },
  }));

  const nextid = vi.fn();

  return { stop, start, lxcClone, taskWait, request, nodeGet, nextid };
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
    vi.clearAllMocks();
    process.env.PVE_BASE_URL = 'https://pve.example.com:8006';
    process.env.PVE_API_TOKEN = 'root@pam!token=abc123';

    mocks.stop.mockResolvedValue('UPID:stop-task');
    mocks.start.mockResolvedValue('UPID:start-task');
    mocks.lxcClone.mockResolvedValue('UPID:lxc-clone-task');
    mocks.taskWait.mockResolvedValue([]);
    mocks.nextid.mockResolvedValue(200);
    mocks.request.mockImplementation(async (path: string) => {
      if (path === '/nodes/{node}/lxc/{vmid}/template') return 'UPID:convert-task';
      if (path === '/nodes/{node}/qemu/{vmid}/config') return 'UPID:rename-task';
      return 'UPID:other-task';
    });
  });

  it('convertToTemplate stops running containers before conversion', async () => {
    const result = await actions.convertToTemplate(
      makeEvent({ type: 'container', id: '200', node: 'pve1', name: 'api-ct', status: 'running' })
    );

    expect(mocks.stop).toHaveBeenCalledTimes(1);
    expect(mocks.taskWait).toHaveBeenCalledWith('UPID:stop-task');
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

    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.taskWait).not.toHaveBeenCalled();
    expect(mocks.request).toHaveBeenCalledWith('/nodes/{node}/lxc/{vmid}/template', 'POST', {
      $path: { node: 'pve1', vmid: 201 },
    });

    expect(result.status).toBe('success');
    expect(result.message).toContain('Converting container 201 (db-ct) to template');
  });

  it('convertToTemplate returns validation failure for non-container workloads', async () => {
    const result = await actions.convertToTemplate(
      makeEvent({ type: 'vm', id: '100', node: 'pve1', name: 'web-vm', status: 'running' })
    );

    expect((result as { status: number }).status).toBe(400);
    expect((result as { data: { message: string } }).data.message).toContain('Only LXC containers can be converted to templates.');
    expect(mocks.request).not.toHaveBeenCalled();
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
});
