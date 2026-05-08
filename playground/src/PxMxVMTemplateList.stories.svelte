<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxVMTemplateList from './PxMxVMTemplateList.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxVMTemplateList',
    component: PxMxVMTemplateList,
    tags: ['autodocs'],
  });

  const templates = [
    { id: 900, name: 'ubuntu-22-template', node: 'pve1', status: 'stopped', isTemplate: true },
    { id: 901, name: 'debian-12-template', node: 'pve1', status: 'stopped', template: 1 },
  ];

  const mixed = [
    ...templates,
    { id: 100, name: 'web-server', node: 'pve1', status: 'running', isTemplate: false },
  ];
</script>

<Story name="Templates only" args={{ workloads: templates }} />

<Story name="Mixed (templates filtered out from list)" args={{ workloads: mixed }} />

<Story name="Empty" args={{ workloads: [] }} />

<Story
  name="With success feedback"
  args={{
    workloads: templates,
    form: { message: 'VM cloned successfully', status: 'success' },
  }}
/>
