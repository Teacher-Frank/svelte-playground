<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxLxcTemplateList from './PxMxLxcTemplateList.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxLxcTemplateList',
    component: PxMxLxcTemplateList,
    tags: ['autodocs'],
  });

  const templates = [
    {
      storage: 'local',
      volid: 'local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst',
      format: 'tgz',
      size: 134217728,
      content: 'vztmpl',
      notes: 'Ubuntu 22.04 LTS standard template',
      ctime: 1700000000,
    },
    {
      storage: 'local',
      volid: 'local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst',
      format: 'tgz',
      size: 104857600,
      content: 'vztmpl',
    },
  ];

  const guestTemplates = [
    { id: 210, name: 'app-template', node: 'pve1', status: 'stopped', template: 1 },
  ];
</script>

<Story name="Templates" args={{ workloads: templates, containerTemplates: guestTemplates, serverNode: 'pve1' }} />

<Story name="Empty" args={{ workloads: [], serverNode: 'pve1' }} />

<Story
  name="With success feedback"
  args={{
    workloads: templates,
    containerTemplates: guestTemplates,
    serverNode: 'pve1',
    form: { message: 'Container created from template', status: 'success' },
  }}
/>

<Story
  name="With error feedback"
  args={{
    workloads: templates,
    containerTemplates: guestTemplates,
    serverNode: 'pve1',
    form: { message: 'Failed to create container: disk full', status: 'error' },
  }}
/>

<Story
  name="Rename unavailable"
  args={{
    workloads: templates,
    containerTemplates: guestTemplates,
    serverNode: 'pve1',
    form: { message: 'Rename is disabled for storage templates.', status: 'error' },
  }}
/>
