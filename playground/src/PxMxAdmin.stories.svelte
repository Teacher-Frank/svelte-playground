<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxAdmin from './PxMxAdmin.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxAdmin',
    component: PxMxAdmin,
    tags: ['autodocs'],
    parameters: {
      layout: 'fullscreen',
      sveltekit_experimental: {
        navigation: {
          invalidateAll: () => {},
        },
      },
    },
  });

  const now = Math.floor(Date.now() / 1000);

  const fullResults = {
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
      { id: 100, name: 'web-server', node: 'pve1', status: 'running', uptime: 86523 },
      { id: 101, name: 'db-server', node: 'pve1', status: 'running', uptime: 3723 },
      { id: 102, name: 'backup-vm', node: 'pve2', status: 'stopped', uptime: 0 },
    ],
    containers: [
      { id: 200, name: 'nginx', node: 'pve1', status: 'running', uptime: 12345 },
      { id: 201, name: 'postgres', node: 'pve1', status: 'running', uptime: 6789 },
    ],
    lxcTemplates: [
      {
        storage: 'local',
        volid: 'local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst',
        format: 'tgz',
        size: 134217728,
        content: 'vztmpl',
        notes: 'Ubuntu 22.04 LTS standard template',
        ctime: now - 86400,
      },
    ],
    recentTasks: [
      {
        id: 'task-1',
        upid: 'UPID:pve1:001:qmstart:100:root@pam:',
        node: 'pve1',
        type: 'qmstart',
        user: 'root@pam',
        starttime: now - 120,
        endtime: now - 110,
        status: 'OK',
      },
    ],
  };
</script>

<Story name="Loaded" args={{ data: { results: fullResults, error: null } }} />

<Story
  name="Error state"
  args={{ data: { results: null, error: 'Failed to connect to Proxmox API: ECONNREFUSED' } }}
/>

<Story name="Empty cluster" args={{ data: { results: { ...fullResults, vms: [], containers: [], lxcTemplates: [], recentTasks: [] }, error: null } }} />
