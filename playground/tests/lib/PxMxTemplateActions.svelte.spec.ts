import { page } from 'vitest/browser';
import { describe, expect, it } from 'vitest';
import { render } from 'vitest-browser-svelte';
import PxMxWorkloadControls from '../../src/PxMxWorkloadControls.svelte';
import PxMxVMTemplateList from '../../src/PxMxVMTemplateList.svelte';
import PxMxLxcTemplateList from '../../src/PxMxLxcTemplateList.svelte';

describe('template action controls', () => {
  it('shows one-click convert label for running containers', async () => {
    render(PxMxWorkloadControls, {
      selectedWorkload: {
        type: 'container',
        id: 301,
        name: 'api-ct',
        node: 'pve1',
        status: 'running',
      },
      selectedLabel: 'api-ct (CT 301)',
      compact: true,
    });

    const convertButton = page.getByRole('button', { name: 'Stop and convert to template' });
    await expect.element(convertButton).toBeVisible();
    await expect.element(convertButton).toBeEnabled();
  });

  it('shows normal convert label for stopped containers', async () => {
    render(PxMxWorkloadControls, {
      selectedWorkload: {
        type: 'container',
        id: 302,
        name: 'db-ct',
        node: 'pve1',
        status: 'stopped',
      },
      selectedLabel: 'db-ct (CT 302)',
      compact: true,
    });

    const convertButton = page.getByRole('button', { name: 'Convert to template' });
    await expect.element(convertButton).toBeVisible();
    await expect.element(convertButton).toBeEnabled();
  });

  it('disables VNC for containers when no LXC GUI bridge is configured', async () => {
    render(PxMxWorkloadControls, {
      selectedWorkload: {
        type: 'container',
        id: 303,
        name: 'gui-less-ct',
        node: 'pve1',
        status: 'running',
      },
      selectedLabel: 'gui-less-ct (CT 303)',
      compact: true,
      containerGuiEnabled: false,
    });

    const vncButton = page.getByLabelText(
      'GUI is not available for containers without an LXC VNC bridge'
    );

    await expect.element(vncButton).toBeVisible();
    await expect.element(vncButton).toHaveAttribute('aria-disabled', 'true');
  });

  it('keeps VNC disabled for running containers until primary IP is resolved', async () => {
    render(PxMxWorkloadControls, {
      selectedWorkload: {
        type: 'container',
        id: 304,
        name: 'resolving-ip-ct',
        node: 'pve1',
        status: 'running',
      },
      selectedLabel: 'resolving-ip-ct (CT 304)',
      compact: true,
      containerGuiEnabled: true,
    });

    const vncButton = page.getByLabelText(
      'Waiting for container IPv4 address before enabling GUI (VNC)'
    );

    await expect.element(vncButton).toBeVisible();
    await expect.element(vncButton).toHaveAttribute('aria-disabled', 'true');
  });

  it('enables VNC for running containers when primary IP is available', async () => {
    render(PxMxWorkloadControls, {
      selectedWorkload: {
        type: 'container',
        id: 305,
        name: 'ready-ip-ct',
        node: 'pve1',
        status: 'running',
        primaryIp: '10.0.0.55',
      },
      selectedLabel: 'ready-ip-ct (CT 305)',
      compact: true,
      containerGuiEnabled: true,
    });

    const vncButton = page.getByRole('link', { name: 'Open GUI (VNC)' });

    await expect.element(vncButton).toBeVisible();
    await expect.element(vncButton).toHaveAttribute('aria-disabled', 'false');
  });

  it('renders deploy and rename icon buttons for VM templates', async () => {
    render(PxMxVMTemplateList, {
      workloads: [
        { id: 900, name: 'ubuntu-template', node: 'pve1', status: 'stopped', template: 1 },
      ],
      form: null,
    });

    const deployButton = page.getByRole('button', { name: 'Deploy VM from template' });
    const renameButton = page.getByRole('button', { name: 'Rename template' });

    await expect.element(deployButton).toBeVisible();
    await expect.element(renameButton).toBeVisible();
    await expect.element(renameButton).toBeEnabled();
    await expect.element(page.getByPlaceholder('New VM name')).not.toBeInTheDocument();

    await deployButton.click();
    await expect.element(page.getByPlaceholder('New VM name')).toBeVisible();
  });

  it('renders disabled rename button for LXC storage templates', async () => {
    render(PxMxLxcTemplateList, {
      workloads: [
        {
          storage: 'local',
          volid: 'local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst',
          format: 'tgz',
          size: 134217728,
          content: 'vztmpl',
        },
      ],
      serverNode: 'pve1',
      form: null,
    });

    const deployButton = page.getByRole('button', { name: 'Deploy container from storage template' });
    const renameButton = page.getByRole('button', { name: 'Rename is not available for storage templates' });
    const typeCell = page.getByRole('cell', { name: /^storage$/ });

    await expect.element(deployButton).toBeVisible();
    await expect.element(renameButton).toBeVisible();
    await expect.element(renameButton).toBeDisabled();
    await expect.element(typeCell).toBeVisible();
    await expect.element(page.getByPlaceholder('Container name')).not.toBeInTheDocument();

    await deployButton.click();
    await expect.element(page.getByPlaceholder('Container name')).toBeVisible();
    await expect.element(page.getByPlaceholder('Root password')).toBeVisible();
  });
});
