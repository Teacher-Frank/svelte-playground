import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';

// Mock pve-client before importing the handler
vi.mock('pve-client', () => {
  const mockAgent = {
    network_interfaces: vi.fn().mockResolvedValue([{ name: 'eth0' }]),
    exec: vi.fn().mockResolvedValue({ pid: 42 }),
    exec_status: vi.fn().mockResolvedValue({
      exited: true,
      'out-data':
        'Filesystem      1K-blocks       Used Available Use% Mounted on\n/dev/sda1      104857600   10485760  89215988  11% /\n',
    }),
    file_write: vi.fn().mockResolvedValue(undefined),
  };

  const mockVmApi = {
    agent: mockAgent,
  };

  const mockExec = vi.fn().mockResolvedValue({ pid: 99 });
  const mockExecStatus = vi.fn().mockResolvedValue({
    exitcode: 0,
    'out-data':
      'Filesystem      1K-blocks       Used Available Use% Mounted on\n/dev/sda1       52428800    5242880  42012160  11% /\n',
  });

  const mockContainerApi = {
    exec: mockExec,
    exec_status: mockExecStatus,
    status: {
      current: vi.fn().mockResolvedValue({ status: 'running', vmid: 100 }),
    },
  };

  const mockLxcApi = {
    id: vi.fn().mockReturnValue(mockContainerApi),
  };

  const mockNodeApi = {
    qemu: {
      vmid: vi.fn().mockReturnValue(mockVmApi),
    },
    lxc: mockLxcApi,
  };

  const mockNodesApi = {
    get: vi.fn().mockReturnValue(mockNodeApi),
  };

  const mockApi = {
    nodes: mockNodesApi,
  };

  // Must be a class so `new Client(...)` works in the handler
  const MockClient = vi.fn().mockImplementation(
    function (this: unknown) {
      return {
        api: mockApi,
        login: vi.fn().mockResolvedValue(undefined),
      };
    },
  );
  MockClient.prototype = {};

  return {
    Client: MockClient,
  };
});

type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

describe('proxmoxGuestAgentStatus', () => {
  let resBody: string;
  let resStatus: number;

  beforeEach(() => {
    // Reset env
    process.env.PVE_BASE_URL = 'https://pve.example.com:8006';
    process.env.PVE_USERNAME = 'root';
    process.env.PVE_PASSWORD = 'secret';
    process.env.PVE_REALM = 'pam';
    process.env.PVE_INSECURE_TLS = 'true';
  });

  afterEach(() => {
    delete process.env.PVE_BASE_URL;
    delete process.env.PVE_USERNAME;
    delete process.env.PVE_PASSWORD;
    delete process.env.PVE_REALM;
    delete process.env.PVE_INSECURE_TLS;
  });

  function createMockReq(url: string): IncomingMessage {
    return {
      method: 'GET',
      url,
      headers: { host: 'localhost' },
    } as unknown as IncomingMessage;
  }

  function createMockRes(): ServerResponse {
    resBody = '';
    resStatus = 200;

    return {
      writeHead: vi.fn((status: number) => {
        resStatus = status;
      }),
      end: vi.fn((body?: string) => {
        resBody = body ?? '';
      }),
    } as unknown as ServerResponse;
  }

  it('returns 400 when vmid is missing', async () => {
    const { attachProxmoxAgentStatusHandler } = await import('../../../server/proxmoxGuestAgentStatus.ts');

    const mockServer = {
      on: vi.fn((event: string, handler: RequestHandler) => {
        if (event === 'request') {
          handler(createMockReq('/proxmox/agent-status?vmid=&node=pve1&type=vm'), createMockRes());
        }
      }),
    } as unknown as ServerResponse;

    attachProxmoxAgentStatusHandler(mockServer as never);
    expect(resStatus).toBe(400);
    expect(resBody).toContain('Missing');
  });

  it('returns 200 for VM with agent available', async () => {
    const { attachProxmoxAgentStatusHandler } = await import('../../../server/proxmoxGuestAgentStatus.ts');

    const mockServer = {
      on: vi.fn((event: string, handler: RequestHandler) => {
        if (event === 'request') {
          void handler(
            createMockReq('/proxmox/agent-status?vmid=100&node=pve1&type=vm'),
            createMockRes(),
          );
        }
      }),
    } as unknown as ServerResponse;

    attachProxmoxAgentStatusHandler(mockServer as never);

    // Wait for async handler to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(resStatus).toBe(200);
    const data = JSON.parse(resBody);
    expect(data.available).toBe(true);
    expect(data.availableSpace).toBeGreaterThan(0);
  });

  it('returns 200 for container with running status', async () => {
    const { attachProxmoxAgentStatusHandler } = await import('../../../server/proxmoxGuestAgentStatus.ts');

    const mockServer = {
      on: vi.fn((event: string, handler: RequestHandler) => {
        if (event === 'request') {
          void handler(
            createMockReq('/proxmox/agent-status?vmid=101&node=pve1&type=container'),
            createMockRes(),
          );
        }
      }),
    } as unknown as ServerResponse;

    attachProxmoxAgentStatusHandler(mockServer as never);

    // Wait for async handler to complete
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(resStatus).toBe(200);
    const data = JSON.parse(resBody);
    expect(data.available).toBe(true);
  });
});
