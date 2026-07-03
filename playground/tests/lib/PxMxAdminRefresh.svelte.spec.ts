import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from 'vitest-browser-svelte';

import PxMxAdmin from '../../src/PxMxAdmin.svelte';

type Workload = {
  id: number;
  name: string;
  node: string;
  status: string;
  uptime: number;
  template?: number;
  primaryIp?: string;
};

type LxcTemplate = {
  storage: string;
  volid: string;
  format: string;
  size: number;
  content: string;
};

const makeData = () => ({
  results: {
    apiHost: 'https://pve.example.com:8006',
    configuredNode: 'pve1',
    configuredNodeExists: true,
    serverNode: 'pve1',
    guestGuiBridgeSupported: false,
    serverStatus: 'online',
    refreshIntervalSeconds: 5,
    lastSuccessfulRefresh: Date.now(),
    nodes: [],
    version: {},
    cluster: {},
    vms: [
      {
        id: 900,
        name: 'ubuntu-template',
        node: 'pve1',
        status: 'stopped',
        uptime: 0,
        template: 1,
      },
    ] as Workload[],
    containers: [{ id: 301, name: 'runtime-container', node: 'pve1', status: 'stopped', uptime: 0 }] as Workload[],
    lxcTemplates: [
      {
        storage: 'local',
        volid: 'local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst',
        format: 'tgz',
        size: 134217728,
        content: 'vztmpl',
      },
    ] as LxcTemplate[],
    recentTasks: [],
    notifications: [],
  },
  error: null,
});

describe('PxMxAdmin container IP refresh scheduling', () => {
  let timeoutSpy: ReturnType<typeof vi.spyOn>;
  let intervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    timeoutSpy = vi.spyOn(window, 'setTimeout');
    intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(() => 1 as unknown as ReturnType<typeof setInterval>);
  });

  afterEach(() => {
    timeoutSpy.mockRestore();
    intervalSpy.mockRestore();
  });

  it('triggers staggered async refreshes after successful container start', async () => {
    render(PxMxAdmin, {
      data: makeData(),
      form: {
        status: 'success',
        message: 'Started container 301',
        workloadType: 'container',
        workloadAction: 'start',
        upid: 'UPID:start-task-301',
        formType: 'container',
      },
    });

    const scheduledDelays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === 'number');

    expect(scheduledDelays).toEqual(expect.arrayContaining([0, 1500, 4000, 8000]));
  });

  it('does not schedule container IP refreshes for VM actions', async () => {
    render(PxMxAdmin, {
      data: makeData(),
      form: {
        status: 'success',
        message: 'Started VM 100',
        workloadType: 'vm',
        workloadAction: 'start',
        upid: 'UPID:start-task-100',
        formType: 'vm',
      },
    });

    const scheduledDelays = timeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((delay): delay is number => typeof delay === 'number');

    expect(scheduledDelays).not.toEqual(expect.arrayContaining([0, 1500, 4000, 8000]));
  });
});
