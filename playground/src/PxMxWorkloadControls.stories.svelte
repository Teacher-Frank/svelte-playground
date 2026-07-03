<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxWorkloadControls from './PxMxWorkloadControls.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxWorkloadControls',
    component: PxMxWorkloadControls,
    tags: ['autodocs'],
    argTypes: {
      compact: { control: 'boolean' },
      disabled: { control: 'boolean' },
    },
  });

  const runningVm = {
    type: 'vm',
    id: 100,
    name: 'web-server',
    node: 'pve1',
    status: 'running',
  };

  const stoppedContainer = {
    type: 'container',
    id: 200,
    name: 'db-container',
    node: 'pve1',
    status: 'stopped',
  };

  const runningContainer = {
    type: 'container',
    id: 201,
    name: 'api-container',
    node: 'pve1',
    status: 'running',
  };
</script>

<Story name="No selection" args={{ selectedWorkload: null, selectedLabel: 'No workload selected' }} />

<Story name="Running VM selected" args={{ selectedWorkload: runningVm, selectedLabel: 'web-server (VM 100)' }} />

<Story
  name="Stopped container selected"
  args={{ selectedWorkload: stoppedContainer, selectedLabel: 'db-container (CT 200)' }}
/>

<Story
  name="Running container selected"
  args={{ selectedWorkload: runningContainer, selectedLabel: 'api-container (CT 201)' }}
/>

<Story
  name="Compact — running VM"
  args={{ selectedWorkload: runningVm, selectedLabel: 'web-server', compact: true }}
/>

<Story name="Disabled" args={{ selectedWorkload: runningVm, disabled: true, selectedLabel: 'web-server' }} />
