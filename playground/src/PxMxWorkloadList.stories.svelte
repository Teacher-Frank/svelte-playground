<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxWorkloadList from './PxMxWorkloadList.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxWorkloadList',
    component: PxMxWorkloadList,
    tags: ['autodocs'],
    argTypes: {
      kind: { control: { type: 'radio' }, options: ['vm', 'container'] },
    },
  });

  const vms = [
    { id: 100, name: 'web-server', node: 'pve1', status: 'running', uptime: 86523 },
    { id: 101, name: 'db-server', node: 'pve1', status: 'running', uptime: 3723 },
    { id: 102, name: 'backup-vm', node: 'pve2', status: 'stopped', uptime: 0 },
  ];

  const containers = [
    { id: 200, name: 'nginx', node: 'pve1', status: 'running', uptime: 12345, primaryIp: '10.0.0.21' },
    { id: 201, name: 'postgres', node: 'pve1', status: 'running', uptime: 6789, primaryIp: '10.0.0.22' },
    { id: 202, name: 'redis', node: 'pve2', status: 'stopped', uptime: 0, primaryIp: '-' },
  ];
</script>

<Story name="VMs" args={{ kind: 'vm', workloads: vms }} />

<Story name="Containers" args={{ kind: 'container', workloads: containers }} />

<Story name="Empty VMs" args={{ kind: 'vm', workloads: [] }} />

<Story
  name="With success feedback"
  args={{
    kind: 'vm',
    workloads: vms,
    form: { message: 'VM started successfully', status: 'success', workloadType: 'vm' },
  }}
/>

<Story
  name="With error feedback"
  args={{
    kind: 'vm',
    workloads: vms,
    form: { message: 'Failed to start VM: timeout', status: 'error', workloadType: 'vm' },
  }}
/>
