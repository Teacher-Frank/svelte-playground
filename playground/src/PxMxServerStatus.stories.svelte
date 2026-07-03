<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxServerStatus from './PxMxServerStatus.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxServerStatus',
    component: PxMxServerStatus,
    tags: ['autodocs'],
  });

  const baseResults = {
    apiHost: 'https://pve.example.com:8006',
    configuredNode: 'pve1',
    configuredNodeExists: true,
    serverNode: 'pve1',
    serverStatus: 'online',
    lastSuccessfulRefresh: Date.now(),
  };
</script>

<Story name="Online" args={{ results: baseResults }} />

<Story
  name="Node missing"
  args={{
    results: {
      ...baseResults,
      configuredNodeExists: false,
      serverStatus: 'online',
    },
  }}
/>

<Story
  name="Offline"
  args={{
    results: {
      ...baseResults,
      serverStatus: 'offline',
      lastSuccessfulRefresh: null,
    },
  }}
/>

<Story
  name="No refresh yet"
  args={{
    results: {
      ...baseResults,
      lastSuccessfulRefresh: null,
    },
  }}
/>
