<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import './PxMxStyle.css';
  import PxMxServerStatus from './PxMxServerStatus.svelte';
  import PxMxTasklist from './PxMxTasklist.svelte';
  import PxMxWorkloadList from './PxMxWorkloadList.svelte';

  let STATUS_REFRESH_SECONDS = $state(5);
  let REFRESH_ENABLED = $state(true);

  const REFRESH_INTERVAL_MS = $derived.by(() => {
    const seconds = Number(STATUS_REFRESH_SECONDS);
    return (Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 1) * 1000;
  });

  type Workload = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    uptime?: number;
  };

  type ProxmoxResults = {
    apiHost: string;
    configuredNode: string;
    configuredNodeExists: boolean;
    serverNode: string;
    serverStatus: string;
    lastSuccessfulRefresh: number | null;
    nodes: unknown;
    version: unknown;
    cluster: unknown;
    vms: Workload[];
    containers: Workload[];
    recentTasks: {
      id: string;
      node: string;
      starttime: number;
      endtime?: number;
      status?: string;
      type: string;
      user: string;
      upid: string;
    }[];
  };

  let {
    data,
    form
  }: {
    data: { results: ProxmoxResults | null; error: string | null };
    form?: {
      message?: string;
      status?: 'success' | 'error';
      workloadType?: 'vm' | 'container';
    } | null;
  } = $props();

  $effect(() => {
    if (!REFRESH_ENABLED) {
      return;
    }

    // Refreshes server status, VM/container status, and the task log together.
    const intervalId = setInterval(() => {
      void invalidateAll();
    }, REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  });
</script>

<main class="pxmx-admin">
  <h1>Proxmox VE Client</h1>
  {#if data.results}
    {#if data.error}
      <p class="load-error">{data.error}</p>
    {/if}

    <div class="refresh-control">
      <label for="status-refresh-seconds">Refresh every (seconds)</label>
      <input
        id="status-refresh-seconds"
        type="number"
        min="1"
        step="1"
        bind:value={STATUS_REFRESH_SECONDS}
      />
      <label class="refresh-toggle" for="refresh-enabled">
        <input
          id="refresh-enabled"
          type="checkbox"
          bind:checked={REFRESH_ENABLED}
        />
        Enable refresh
      </label>
    </div>

    <PxMxServerStatus results={data.results} />

    <PxMxWorkloadList kind="vm" workloads={data.results.vms} {form} />

    <PxMxWorkloadList kind="container" workloads={data.results.containers} {form} />

    <PxMxTasklist tasks={data.results.recentTasks} />
  {:else if data.error}
    <p class="load-error">{data.error}</p>
  {:else}
    <p>No Proxmox data available.</p>
  {/if}
</main>