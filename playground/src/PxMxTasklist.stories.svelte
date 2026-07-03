<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import PxMxTasklist from './PxMxTasklist.svelte';

  const { Story } = defineMeta({
    title: 'Proxmox/PxMxTasklist',
    component: PxMxTasklist,
    tags: ['autodocs'],
  });

  const now = Math.floor(Date.now() / 1000);

  const sampleTasks = [
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
    {
      id: 'task-2',
      upid: 'UPID:pve1:002:qmstop:101:root@pam:',
      node: 'pve1',
      type: 'qmstop',
      user: 'root@pam',
      starttime: now - 300,
      endtime: now - 295,
      status: 'OK',
    },
    {
      id: 'task-3',
      upid: 'UPID:pve1:003:vzdump:102:root@pam:',
      node: 'pve1',
      type: 'vzdump',
      user: 'root@pam',
      starttime: now - 600,
      status: undefined,
    },
  ];
</script>

<Story name="With tasks" args={{ tasks: sampleTasks }} />

<Story name="Empty" args={{ tasks: [] }} />

<Story name="Running task" args={{ tasks: [sampleTasks[2]] }} />
