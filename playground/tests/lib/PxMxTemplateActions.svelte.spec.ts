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

  it('renders deploy and rename icon buttons for VM templates', async () => {
    render(PxMxVMTemplateList, {
      workloads: [
        { id: 900, name: 'ubuntu-template', node: 'pve1', status: 'stopped', template: 1 },
      ],
      form: null,
    });

    const deployButton = page.getByRole('button', { name: 'Deploy VM from template' });
    const renameButton = page.getByRole('button', { name: 'Rename template to input name' });

    await expect.element(deployButton).toBeVisible();
    await expect.element(renameButton).toBeVisible();
    await expect.element(renameButton).toBeEnabled();
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

    const deployButton = page.getByRole('button', { name: 'Deploy container from template' });
    const renameButton = page.getByRole('button', { name: 'Rename is not available for storage templates' });

    await expect.element(deployButton).toBeVisible();
    await expect.element(renameButton).toBeVisible();
    await expect.element(renameButton).toBeDisabled();
  });
});
