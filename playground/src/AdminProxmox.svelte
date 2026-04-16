<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { onMount } from 'svelte';
  import VMContainerControls from './VMContainerControls.svelte';

  const SERVER_STATUS_REFRESH_SECONDS = 5;
  const SERVER_STATUS_REFRESH_INTERVAL_MS = SERVER_STATUS_REFRESH_SECONDS * 1000;

  type Workload = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    uptime?: number;
  };

  type ProxmoxResults = {
    serverStatus: string;
    nodes: unknown;
    version: unknown;
    cluster: unknown;
    vms: Workload[];
    containers: Workload[];
  };

  let {
    data
  }: {
    data: { results: ProxmoxResults | null; error: string | null };
  } = $props();

  const toWorkloads = (value: unknown): Workload[] => {
    return Array.isArray(value) ? (value as Workload[]) : [];
  };

  const formatUptime = (uptime?: number): string => {
    if (uptime == null || uptime < 0) {
      return '-';
    }

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);

    if (days > 0) {
      return `${days}d ${hours}h`;
    }

    if (hours > 0) {
      return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
  };

  onMount(() => {
    const intervalId = setInterval(() => {
      void invalidateAll();
    }, SERVER_STATUS_REFRESH_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  });
</script>

<main>
  <h1>Proxmox VE Client</h1>
  {#if data.error}
    <p>{data.error}</p>
  {:else if data.results}
    <p class="server-status">Server status: {data.results.serverStatus}</p>

    <section>
      <h2>Virtual Machines</h2>
      {#if toWorkloads(data.results.vms).length > 0}
        <div class="vm-header-row">
          <div class="workload-header">
            <span>ID</span>
            <span>Name</span>
            <span>Status</span>
            <span>Node</span>
            <span>Uptime</span>
          </div>
          <span class="actions-header">Actions</span>
        </div>
        <ul class="workload-list">
          {#each toWorkloads(data.results.vms) as vm}
            <li class="vm-row">
              <button
                class="workload-row-button"
                type="button"
              >
                <span>{vm.id ?? 'Unknown'}</span>
                <span>{vm.name ?? 'Unnamed VM'}</span>
                <span>{vm.status ?? '-'}</span>
                <span>{vm.node ?? '-'}</span>
                <span>{formatUptime(vm.uptime)}</span>
              </button>

              <VMContainerControls
                compact={true}
                disabled={vm.id == null}
                selectedWorkload={{ type: 'vm', id: vm.id, name: vm.name }}
              />
            </li>
          {/each}
        </ul>
      {:else}
        <p>No virtual machines found.</p>
      {/if}
    </section>

    <section>
      <h2>Containers</h2>
      {#if toWorkloads(data.results.containers).length > 0}
        <div class="vm-header-row">
          <div class="workload-header">
            <span>ID</span>
            <span>Name</span>
            <span>Status</span>
            <span>Node</span>
            <span>Uptime</span>
          </div>
          <span class="actions-header">Actions</span>
        </div>
        <ul class="workload-list">
          {#each toWorkloads(data.results.containers) as container}
            <li class="vm-row">
              <button
                class="workload-row-button"
                type="button"
              >
                <span>{container.id ?? 'Unknown'}</span>
                <span>{container.name ?? 'Unnamed container'}</span>
                <span>{container.status ?? '-'}</span>
                <span>{container.node ?? '-'}</span>
                <span>{formatUptime(container.uptime)}</span>
              </button>

              <VMContainerControls
                compact={true}
                disabled={container.id == null}
                selectedWorkload={{ type: 'container', id: container.id, name: container.name }}
              />
            </li>
          {/each}
        </ul>
      {:else}
        <p>No containers found.</p>
      {/if}
    </section>
  {:else}
    <p>No Proxmox data available.</p>
  {/if}
</main>

<style>
  :global(:root) {
    --actions-col-width: 7.6rem;
  }

  main {
    padding: 2rem;
  }

  section + section {
    margin-top: 1.5rem;
  }

  .server-status {
    background: #f0f0f0;
    border: 1px solid #d6d6d6;
    border-radius: 0.65rem;
    font-weight: 600;
    margin: 0 0 1rem;
    padding: 0.65rem 0.85rem;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .workload-list {
    display: grid;
    gap: 0.5rem;
  }

  .workload-header,
  .workload-row-button {
    display: grid;
    gap: 1rem;
    grid-template-columns: 5rem minmax(10rem, 2fr) 7rem 7rem 6rem;
  }

  .vm-header-row {
    align-items: center;
    display: grid;
    gap: 0.75rem;
    grid-template-columns: minmax(20rem, 1fr) var(--actions-col-width);
  }

  .actions-header {
    color: #666;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    text-align: center;
    text-transform: uppercase;
  }

  .vm-row {
    align-items: center;
    display: grid;
    gap: 0.75rem;
    grid-template-columns: minmax(20rem, 1fr) var(--actions-col-width);
  }

  .workload-header {
    color: #666;
    font-size: 0.8rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin-bottom: 0.5rem;
    padding: 0 1rem;
    text-transform: uppercase;
  }

  .workload-row-button {
    width: 100%;
    border: 1px solid #d0d0d0;
    border-radius: 0.65rem;
    background: #fff;
    color: #222;
    cursor: pointer;
    padding: 0.85rem 1rem;
    text-align: left;
  }

  .workload-row-button span:last-child {
    color: #555;
  }
</style>