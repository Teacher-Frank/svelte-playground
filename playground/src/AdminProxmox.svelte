<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import VMContainerControls from './VMContainerControls.svelte';

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

  const formatTaskTime = (unixSeconds?: number): string => {
    if (!unixSeconds || unixSeconds <= 0) {
      return '-';
    }

    return new Date(unixSeconds * 1000).toLocaleString();
  };

  const formatRefreshTime = (unixMs?: number | null): string => {
    if (!unixMs || unixMs <= 0) {
      return 'No successful refresh yet';
    }

    return new Date(unixMs).toLocaleString();
  };

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

<main>
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

    <p class="server-status">
      Server status ({data.results.serverNode}): {data.results.serverStatus} | Configured node exists: {data.results.configuredNodeExists ? 'yes' : 'no'} | Configured node: {data.results.configuredNode} | API host: {data.results.apiHost}
    </p>
    <p class="last-refresh">Last successful refresh: {formatRefreshTime(data.results.lastSuccessfulRefresh)}</p>

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
          {#each toWorkloads(data.results.vms) as vm (vm.id)}
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
                selectedWorkload={{ type: 'vm', id: vm.id, name: vm.name, node: vm.node }}
              />
            </li>
          {/each}
        </ul>
      {:else}
        <p>No virtual machines found.</p>
      {/if}

      {#if form?.message && form.workloadType === 'vm'}
        <p class="action-status" class:success={form.status === 'success'} class:error={form.status === 'error'}>{form.message}</p>
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
          {#each toWorkloads(data.results.containers) as container (container.id)}
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
                selectedWorkload={{ type: 'container', id: container.id, name: container.name, node: container.node }}
              />
            </li>
          {/each}
        </ul>
      {:else}
        <p>No containers found.</p>
      {/if}

      {#if form?.message && form.workloadType === 'container'}
        <p class="action-status" class:success={form.status === 'success'} class:error={form.status === 'error'}>{form.message}</p>
      {/if}
    </section>

    <section>
      <h2>Last 10 Actions</h2>
      {#if data.results.recentTasks.length > 0}
        <div class="tasks-table-wrap">
          <table class="tasks-table">
            <thead>
              <tr>
                <th>Start</th>
                <th>Type</th>
                <th>Status</th>
                <th>Node</th>
                <th>User</th>
                <th>ID</th>
              </tr>
            </thead>
            <tbody>
              {#each data.results.recentTasks as task (task.upid || task.id)}
                <tr>
                  <td>{formatTaskTime(task.starttime)}</td>
                  <td>{task.type || '-'}</td>
                  <td>{task.status || '-'}</td>
                  <td>{task.node || '-'}</td>
                  <td>{task.user || '-'}</td>
                  <td>{task.id || task.upid || '-'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        <p>No task history available.</p>
      {/if}
    </section>
  {:else if data.error}
    <p class="load-error">{data.error}</p>
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

  .refresh-control {
    align-items: center;
    display: flex;
    gap: 0.6rem;
    margin: 0 0 1rem;
  }

  .refresh-control label {
    color: #444;
    font-size: 0.92rem;
    font-weight: 600;
  }

  .refresh-control input {
    border: 1px solid #c8c8c8;
    border-radius: 0.5rem;
    font-size: 0.9rem;
    padding: 0.35rem 0.45rem;
    width: 5.5rem;
  }

  .refresh-toggle {
    align-items: center;
    color: #444;
    display: inline-flex;
    font-size: 0.9rem;
    font-weight: 600;
    gap: 0.4rem;
    margin-left: 0.25rem;
  }

  .refresh-toggle input {
    margin: 0;
  }

  .server-status {
    background: #f0f0f0;
    border: 1px solid #d6d6d6;
    border-radius: 0.65rem;
    font-weight: 600;
    margin: 0 0 1rem;
    padding: 0.65rem 0.85rem;
  }

  .last-refresh {
    color: #555;
    font-size: 0.88rem;
    margin: -0.35rem 0 1rem;
  }

  .load-error {
    background: #fff2cc;
    border: 1px solid #e3c16a;
    border-radius: 0.65rem;
    color: #6b4f00;
    margin: 0 0 1rem;
    padding: 0.65rem 0.85rem;
  }

  .action-status {
    border-radius: 0.75rem;
    margin-top: 0.9rem;
    padding: 0.85rem 1rem;
  }

  .success {
    background: #e6f5ea;
    color: #215c33;
  }

  .error {
    background: #fbe9e7;
    color: #8b2e24;
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

  .tasks-table-wrap {
    overflow-x: auto;
  }

  .tasks-table {
    border-collapse: collapse;
    width: 100%;
  }

  .tasks-table th,
  .tasks-table td {
    border-bottom: 1px solid #e1e1e1;
    font-size: 0.9rem;
    padding: 0.6rem 0.5rem;
    text-align: left;
    vertical-align: top;
  }

  .tasks-table th {
    color: #555;
    font-size: 0.78rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
</style>