<script lang="ts">
  import './PxMxStyle.css';
  import PxMxWorkloadControls from './PxMxWorkloadControls.svelte';

  type WorkloadKind = 'vm' | 'container';

  type Workload = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    uptime?: number;
    primaryIp?: string;
  };

  let {
    kind,
    workloads,
    form,
    containerGuiEnabled = false,
  }: {
    kind: WorkloadKind;
    workloads: Workload[];
    containerGuiEnabled?: boolean;
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

  const formatContainerIp = (workload: Workload): string => {
    if (workload.primaryIp && workload.primaryIp.trim().length > 0) {
      return workload.primaryIp;
    }

    // Running containers may need a short settle period before interfaces report
    // a usable IPv4; show '?' while discovery is still in progress.
    if (workload.status === 'running') {
      return '?';
    }

    return '-';
  };

  let dismissed = $state(false);
  $effect(() => {
    // Reset dismissal when server action feedback changes so each new result is
    // visible at least once and cannot be hidden by a previous dismiss click.
    if (form?.message) dismissed = false;
  });
</script>

<section>
  <div class="tasklist-header">
    <h2>{sectionTitle}</h2>
  </div>
  {#if workloads.length > 0}
    <div class="vm-header-row">
      <div class="workload-header" class:container-kind={kind === 'container'}>
        <span>ID</span>
        <span>Name</span>
        <span>Status</span>
        <span>Node</span>
        {#if kind === 'container'}
          <span>IP</span>
        {/if}
        <span>Uptime</span>
      </div>
      <span class="actions-header">Actions</span>
    </div>
    <ul class="workload-list">
      <!-- Key rows by workload id to preserve control state predictably during refreshes. -->
      {#each workloads as workload (workload.id)}
        <li class="vm-row">
          <button
            class="workload-row-button"
            class:container-kind={kind === 'container'}
            type="button"
          >
            <span>{workload.id ?? 'Unknown'}</span>
            <span>{workload.name ?? unnamedLabel}</span>
            <span>{workload.status ?? '-'}</span>
            <span>{workload.node ?? '-'}</span>
            {#if kind === 'container'}
              <span>{formatContainerIp(workload)}</span>
            {/if}
            <span>{formatUptime(workload.uptime)}</span>
          </button>

          <!-- Forward row context directly so action forms submit authoritative node/type/id values. -->
          <PxMxWorkloadControls
            compact={true}
            disabled={workload.id == null}
            containerGuiEnabled={containerGuiEnabled}
            selectedWorkload={{
              type: kind,
              id: workload.id,
              name: workload.name,
              node: workload.node,
              status: workload.status,
              primaryIp: workload.primaryIp,
            }}
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