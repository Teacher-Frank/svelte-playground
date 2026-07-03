import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const interfaces = vi.fn();
  const displayConnectionInfo = vi.fn();
  const nodeGet = vi.fn(() => ({
    lxc: {
      id: vi.fn(() => ({
        interfaces,
      })),
    },
  }));

  return {
    interfaces,
    displayConnectionInfo,
    nodeGet,
  };
});

vi.mock('pve-client', () => ({
  Client: class {
    api = {
      nodes: {
        get: mocks.nodeGet,
      },
    };

    helpers = {
      display: vi.fn(() => ({
        getConnectionInfo: mocks.displayConnectionInfo,
      })),
    };

    login = vi.fn();

    constructor() {}
  },
}));

import { load } from '../../../src/routes/proxmox/vnc/+page.server.ts';

describe('proxmox vnc page bridge resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PVE_BASE_URL = 'https://pve.example.com:8006';
    process.env.PVE_API_TOKEN = 'root@pam!token=abc123';
    process.env.PVE_INSECURE_TLS = 'true';
    process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 = 'true';
    process.env.LXC_VNC_BRIDGE_WS_SCHEME = 'ws';
    process.env.LXC_VNC_BRIDGE_WS_PORT = '8001';
    process.env.LXC_VNC_BRIDGE_WS_PATH = '';
    delete process.env.LXC_VNC_BRIDGE_WS_URL;

    mocks.interfaces.mockResolvedValue([
      {
        name: 'eth0',
        inet: '10.0.0.21',
        'ip-addresses': [
          { 'ip-address-type': 'ipv4', 'ip-address': '10.0.0.21' },
        ],
      },
    ]);

    mocks.displayConnectionInfo.mockResolvedValue({
      websocketUrl: 'wss://pve.example.com:8006/api2/json/nodes/pve1/qemu/100/vncwebsocket',
      ticket: {
        password: 'pw',
        ticket: 'ticket',
        user: 'root@pam',
      },
    });
  });

  it('prefers query ip for container bridge URL and skips interfaces lookup', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=301&node=pve1&type=container&ip=10.9.8.7&name=ct301'),
    } as Parameters<typeof load>[0];

    const result = await load(event);

    expect(result.type).toBe('container');
    expect(result.upstreamWsUrl).toBe('ws://10.9.8.7:8001');
    expect(mocks.interfaces).not.toHaveBeenCalled();
  });

  it('falls back to interfaces lookup when query ip is missing', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=302&node=pve1&type=container&name=ct302'),
    } as Parameters<typeof load>[0];

    const result = await load(event);

    expect(result.type).toBe('container');
    expect(result.upstreamWsUrl).toBe('ws://10.0.0.21:8001');
    expect(mocks.interfaces).toHaveBeenCalledTimes(1);
  });

  it('returns 503 when no IPv4 can be resolved for the container', async () => {
    mocks.interfaces.mockResolvedValue([]);

    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=303&node=pve1&type=container&name=ct303'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 503 });
  });

  it('always uses native Proxmox VNC for VMs — ignores bridge config', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=101&node=pve1&type=vm&ip=10.9.8.7&name=vm101'),
    } as Parameters<typeof load>[0];

    const result = await load(event);

    expect(result.type).toBe('vm');
    expect(result.upstreamWsUrl).toBe('wss://pve.example.com:8006/api2/json/nodes/pve1/qemu/100/vncwebsocket');
    expect(result.vncUsername).toBe('root@pam');
    expect(result.vncPassword).toBe('pw');
    // display() was called (native path), not LXC interface lookup
    expect(mocks.displayConnectionInfo).toHaveBeenCalled();
  });

  it('uses native Proxmox VNC for VMs even when LXC_VNC_BRIDGE_DERIVE_FROM_IPV4 is true', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=102&node=pve1&type=vm&name=vm102'),
    } as Parameters<typeof load>[0];

    const result = await load(event);

    expect(result.type).toBe('vm');
    expect(result.upstreamWsUrl).toBe('wss://pve.example.com:8006/api2/json/nodes/pve1/qemu/100/vncwebsocket');
  });

  it('returns 400 when vmid is missing', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?node=pve1&type=vm'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 400 });
  });

  it('returns 400 when vmid is not a positive integer', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=abc&node=pve1&type=vm'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 400 });
  });

  it('returns 400 when node is missing', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=100&type=vm'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 400 });
  });

  it('returns 400 when type is invalid', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=100&node=pve1&type=invalid'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 400 });
  });

  it('returns 503 for containers when bridge mode is not configured', async () => {
    delete process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4;
    delete process.env.LXC_VNC_BRIDGE_WS_URL;

    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=304&node=pve1&type=container&name=ct304'),
    } as Parameters<typeof load>[0];

    await expect(load(event)).rejects.toMatchObject({ status: 503 });
  });

  it('uses LXC_VNC_BRIDGE_WS_URL template for containers when set', async () => {
    delete process.env.LXC_VNC_BRIDGE_DERIVE_FROM_IPV4;
    process.env.LXC_VNC_BRIDGE_WS_URL = 'ws://websockify.gateway:8001/{node}/{vmid}/vnc';

    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=305&node=pve1&type=container&ip=10.0.0.50&name=ct305'),
    } as Parameters<typeof load>[0];

    const result = await load(event);

    expect(result.type).toBe('container');
    expect(result.upstreamWsUrl).toBe('ws://websockify.gateway:8001/pve1/305/vnc');
  });

  it('skips loopback and link-local IPs from query param', async () => {
    const event = {
      url: new URL('http://localhost/proxmox/vnc?vmid=306&node=pve1&type=container&ip=127.0.0.1&name=ct306'),
    } as Parameters<typeof load>[0];

    // Will fall back to interfaces lookup since 127.0.0.1 was skipped
    const result = await load(event);

    expect(result.upstreamWsUrl).toBe('ws://10.0.0.21:8001');
    expect(mocks.interfaces).toHaveBeenCalledTimes(1);
  });
});
