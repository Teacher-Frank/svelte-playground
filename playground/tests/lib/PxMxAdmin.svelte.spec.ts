import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PxMxAdmin from '../../src/PxMxAdmin.svelte';

type Workload = {
  id: number;
  name: string;
  node: string;
  status: string;
  uptime: number;
  template?: number;
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
    serverStatus: 'online',
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
    containers: [] as Workload[],
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
  },
  error: null,
});

describe('PxMxAdmin tab form state', () => {
  it('clears LXC deploy inputs after switching tabs away and back', async () => {
    render(PxMxAdmin, { data: makeData() });

    await page.getByRole('tab', { name: 'LXC Containers' }).click();

    const containerNameInput = page.getByPlaceholder('Container name');
    const rootPasswordInput = page.getByPlaceholder('Root password');

    await containerNameInput.fill('my-lxc');
    await rootPasswordInput.fill('StrongPassw0rd!');

    await expect.element(containerNameInput).toHaveValue('my-lxc');
    await expect.element(rootPasswordInput).toHaveValue('StrongPassw0rd!');

    await page.getByRole('tab', { name: 'Virtual Machines' }).click();
    await page.getByRole('tab', { name: 'LXC Containers' }).click();

    await expect.element(page.getByPlaceholder('Container name')).toHaveValue('');
    await expect.element(page.getByPlaceholder('Root password')).toHaveValue('');
  });

  it('clears VM deploy name after switching tabs away and back', async () => {
    render(PxMxAdmin, { data: makeData() });

    await page.getByRole('tab', { name: 'Virtual Machines' }).click();

    const vmNameInput = page.getByPlaceholder('New VM name');
    await vmNameInput.fill('my-vm');
    await expect.element(vmNameInput).toHaveValue('my-vm');

    await page.getByRole('tab', { name: 'LXC Containers' }).click();
    await page.getByRole('tab', { name: 'Virtual Machines' }).click();

    await expect.element(page.getByPlaceholder('New VM name')).toHaveValue('');
  });
});