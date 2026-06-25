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
  it('clears LXC deploy inputs after switching tabs away and back', { timeout: 30_000 }, async () => {
    render(PxMxAdmin, { data: makeData() });

    await page.getByRole('tab', { name: 'LXC Containers' }).click();
    await page.getByRole('button', { name: 'Deploy container from storage template' }).click();

    const containerNameInput = page.getByPlaceholder('Container name');
    const rootPasswordInput = page.getByPlaceholder('Root password');

    await containerNameInput.fill('my-lxc');
    await rootPasswordInput.fill('StrongPassw0rd!');

    await expect.element(containerNameInput).toHaveValue('my-lxc');
    await expect.element(rootPasswordInput).toHaveValue('StrongPassw0rd!');

    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('tab', { name: 'Virtual Machines' }).click();
    await page.getByRole('tab', { name: 'LXC Containers' }).click();
    await page.getByRole('button', { name: 'Deploy container from storage template' }).click();

    await expect.element(page.getByPlaceholder('Container name')).toHaveValue('');
    await expect.element(page.getByPlaceholder('Root password')).toHaveValue('');
  });

  it('clears VM deploy name after switching tabs away and back', { timeout: 30_000 }, async () => {
    render(PxMxAdmin, { data: makeData() });

    await page.getByRole('tab', { name: 'Virtual Machines' }).click();
    await page.getByRole('button', { name: 'Deploy VM from template' }).click();

    const vmNameInput = page.getByPlaceholder('New VM name');
    await vmNameInput.fill('my-vm');
    await expect.element(vmNameInput).toHaveValue('my-vm');

    await page.getByRole('button', { name: 'Cancel' }).click();

    await page.getByRole('tab', { name: 'LXC Containers' }).click();
    await page.getByRole('tab', { name: 'Virtual Machines' }).click();
    await page.getByRole('button', { name: 'Deploy VM from template' }).click();

    await expect.element(page.getByPlaceholder('New VM name')).toHaveValue('');
  });

  it('shows converted container templates in templates area and excludes them from container workload list', async () => {
    const data = makeData();
    data.results.containers = [
      { id: 300, name: 'converted-template', node: 'pve1', status: 'stopped', uptime: 0, template: 1 },
      { id: 301, name: 'runtime-container', node: 'pve1', status: 'running', uptime: 120, primaryIp: '10.0.0.51' },
    ] as Workload[];

    render(PxMxAdmin, { data });

    await page.getByRole('tab', { name: 'LXC Containers' }).click();

    await expect.element(page.getByRole('cell', { name: 'converted-template' })).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'runtime-container' })).toBeVisible();
    await expect.element(page.getByText('10.0.0.51')).toBeVisible();
    await expect.element(page.getByRole('button', { name: 'converted-template' })).not.toBeInTheDocument();
  });

  it.skip('shows a transient deploying VM row after deployment submit starts', { timeout: 30_000 }, async () => {
    // SKIP: This test requires server-side SvelteKit form actions at runtime.
    // The deploy dialog submits via POST to +page.server.ts, which returns 405 in
    // Vitest browser mode (no server actions at /). To properly test this flow,
    // the test would need to either:
    //   1. Pass a mock `form` prop simulating the server response, OR
    //   2. Use an end-to-end test framework that includes the SvelteKit server.
    render(PxMxAdmin, { data: makeData() });

    await page.getByRole('tab', { name: 'Virtual Machines' }).click();
    await page.getByRole('button', { name: 'Deploy VM from template' }).click();

    await page.getByPlaceholder('New VM name').fill('vm-deploying-test');
    await page.getByPlaceholder('e.g. ubuntu, debian').fill('ubuntu');
    await page.getByPlaceholder('Cloud-init password').fill('StrongPassw0rd!');
    await page.getByRole('button', { name: 'Deploy', exact: true }).click();

    await expect.element(page.getByRole('button', { name: 'vm-deploying-test' })).toBeVisible();
  });
});