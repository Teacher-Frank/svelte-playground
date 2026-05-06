<script lang="ts">
  import './PxMxStyle.css';
  import VMContainerControls from './VMContainerControls.svelte';

  type WorkloadKind = 'vm' | 'container';

  type Workload = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    uptime?: number;
  };

  let {
    kind,
    workloads,
    form
  }: {
    kind: WorkloadKind;
    workloads: Workload[];
    form?: {
      message?: string;
      status?: 'success' | 'error';
      workloadType?: WorkloadKind;
    } | null;
  } = $props();

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

  const sectionTitle = $derived(kind === 'vm' ? 'Virtual Machines' : 'Containers');
  const emptyStateLabel = $derived(kind === 'vm' ? 'No virtual machines found.' : 'No containers found.');
  const unnamedLabel = $derived(kind === 'vm' ? 'Unnamed VM' : 'Unnamed container');

  let dismissed = $state(false);
  $effect(() => {
    // Reset dismissed state whenever a new form result arrives
    if (form?.message) dismissed = false;
  });
</script>

<section>
  <div class="tasklist-header">
    <h2>{sectionTitle}</h2>
  </div>
  {#if workloads.length > 0}
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
      {#each workloads as workload (workload.id)}
        <li class="vm-row">
          <button
            class="workload-row-button"
            type="button"
          >
            <span>{workload.id ?? 'Unknown'}</span>
            <span>{workload.name ?? unnamedLabel}</span>
            <span>{workload.status ?? '-'}</span>
            <span>{workload.node ?? '-'}</span>
            <span>{formatUptime(workload.uptime)}</span>
          </button>

          <VMContainerControls
            compact={true}
            disabled={workload.id == null}
            selectedWorkload={{ type: kind, id: workload.id, name: workload.name, node: workload.node }}
          />
        </li>
      {/each}
    </ul>
  {:else}
    <p>{emptyStateLabel}</p>
  {/if}

  {#if form?.message && form.workloadType === kind && !dismissed}
    <p class="action-status" class:success={form.status === 'success'} class:error={form.status === 'error'}>
      {form.message}
      <button class="dismiss-btn" onclick={() => dismissed = true} aria-label="Dismiss">✕</button>
    </p>
  {/if}
</section>

<style>
  .action-status {
    align-items: center;
    border-radius: 0.4rem;
    display: flex;
    gap: 0.8rem;
    justify-content: space-between;
    margin: 0.8rem 0;
    padding: 0.75rem 1rem;
  }

  .action-status.success {
    background: #e8f5e9;
    border: 1px solid #81c784;
    color: #2e7d32;
  }

  .action-status.error {
    background: #ffebee;
    border: 1px solid #ef5350;
    color: #c62828;
  }

  .dismiss-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.6;
    padding: 0;
  }

  .dismiss-btn:hover {
    opacity: 1;
  }
</style>