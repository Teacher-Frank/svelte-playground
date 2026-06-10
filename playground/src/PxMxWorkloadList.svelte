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
    cpulimit?: number;
    memorylimit?: number;
    hostMaxCpu?: number;
    hostMaxMemory?: number;
    hostMaxStorage?: number;
    hostAvailableStorage?: number;
    deployTaskUpids?: string[];
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

  const formatCpuLimit = (workload: Workload): string => {
    if (
      typeof workload.cpulimit !== 'number' ||
      !Number.isFinite(workload.cpulimit) ||
      workload.cpulimit <= 0 ||
      typeof workload.hostMaxCpu !== 'number' ||
      !Number.isFinite(workload.hostMaxCpu) ||
      workload.hostMaxCpu <= 0
    ) {
      return '-';
    }

    const sharePercent = Math.round((workload.cpulimit / workload.hostMaxCpu) * 100);
    return `${sharePercent}%`;
  };

  const formatMemoryLimit = (workload: Workload): string => {
    if (typeof workload.memorylimit !== 'number' || !Number.isFinite(workload.memorylimit) || workload.memorylimit <= 0) {
      return '-';
    }

    const bytes = workload.memorylimit;
    const gib = 1024 ** 3;
    if (bytes >= gib) {
      return `${(bytes / gib).toFixed(1)} GiB`;
    }

    const mib = 1024 ** 2;
    return `${Math.round(bytes / mib)} MiB`;
  };

  const statusClass = (status?: string): string => {
    const normalized = (status ?? '').trim().toLowerCase();
    return normalized === 'deploying' ? 'status-deploying' : 'status-default';
  };

  const deployingTooltip = (workload: Workload): string | undefined => {
    if (workload.status !== 'deploying' || !workload.deployTaskUpids?.length) {
      return undefined;
    }

    return `Tasks: ${workload.deployTaskUpids.join(', ')}`;
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
    {#if kind === 'container'}
      <div class="container-list-layout">
        <div class="container-table-wrap">
          <div class="container-table-content">
            <div class="workload-header container-kind">
              <span class="col-id">ID</span>
              <span class="col-name">Name</span>
              <span>Status</span>
              <span>Node</span>
              <span>IP</span>
              <span>CPU Share</span>
              <span>Memory Limit</span>
              <span>Uptime</span>
            </div>
            <ul class="workload-list">
              <!-- Key rows by workload id to preserve control state predictably during refreshes. -->
              {#each workloads as workload (workload.id)}
                <li>
                  <button
                    class="workload-row-button container-kind"
                    type="button"
                  >
                    <span class="col-id">{workload.id ?? 'Unknown'}</span>
                    <span class="col-name">{workload.name ?? unnamedLabel}</span>
                    <span
                      class={statusClass(workload.status)}
                      title={deployingTooltip(workload)}
                    >{workload.status ?? '-'}</span>
                    <span>{workload.node ?? '-'}</span>
                    <span>{formatContainerIp(workload)}</span>
                    <span>{formatCpuLimit(workload)}</span>
                    <span>{formatMemoryLimit(workload)}</span>
                    <span>{formatUptime(workload.uptime)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        </div>

        <div class="container-actions-pane">
          <span class="actions-header">Actions</span>
          <ul class="container-actions-list">
            {#each workloads as workload (workload.id)}
              <li class="container-action-row">
                <PxMxWorkloadControls
                  compact={true}
                  disabled={workload.id == null || workload.status === 'deploying'}
                  containerGuiEnabled={containerGuiEnabled}
                  selectedWorkload={{
                    type: kind,
                    id: workload.id,
                    name: workload.name,
                    node: workload.node,
                    status: workload.status,
                    primaryIp: workload.primaryIp,
                    cpulimit: workload.cpulimit,
                    memorylimit: workload.memorylimit,
                    hostMaxCpu: workload.hostMaxCpu,
                    hostMaxMemory: workload.hostMaxMemory,
                    hostMaxStorage: workload.hostMaxStorage,
                    hostAvailableStorage: workload.hostAvailableStorage,
                  }}
                />
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {:else}
      <div class="vm-list-layout">
        <div class="vm-table-wrap">
          <div class="vm-table-content">
            <div class="workload-header vm-kind">
              <span class="col-id">ID</span>
              <span class="col-name">Name</span>
              <span>Status</span>
              <span>Node</span>
              <span>Uptime</span>
            </div>
            <ul class="workload-list">
              <!-- Key rows by workload id to preserve control state predictably during refreshes. -->
              {#each workloads as workload (workload.id)}
                <li>
                  <button
                    class="workload-row-button vm-kind"
                    type="button"
                  >
                    <span class="col-id">{workload.id ?? 'Unknown'}</span>
                    <span class="col-name">{workload.name ?? unnamedLabel}</span>
                    <span
                      class={statusClass(workload.status)}
                      title={deployingTooltip(workload)}
                    >{workload.status ?? '-'}</span>
                    <span>{workload.node ?? '-'}</span>
                    <span>{formatUptime(workload.uptime)}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        </div>

        <div class="vm-actions-pane">
          <span class="actions-header">Actions</span>
          <ul class="vm-actions-list">
            {#each workloads as workload (workload.id)}
              <li class="vm-action-row">
                <!-- Forward row context directly so action forms submit authoritative node/type/id values. -->
                <PxMxWorkloadControls
                  compact={true}
                  disabled={workload.id == null || workload.status === 'deploying'}
                  containerGuiEnabled={containerGuiEnabled}
                  selectedWorkload={{
                    type: kind,
                    id: workload.id,
                    name: workload.name,
                    node: workload.node,
                    status: workload.status,
                    primaryIp: workload.primaryIp,
                    cpulimit: workload.cpulimit,
                    memorylimit: workload.memorylimit,
                    hostMaxCpu: workload.hostMaxCpu,
                    hostMaxMemory: workload.hostMaxMemory,
                    hostMaxStorage: workload.hostMaxStorage,
                    hostAvailableStorage: workload.hostAvailableStorage,
                  }}
                />
              </li>
            {/each}
          </ul>
        </div>
      </div>
    {/if}
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

  .status-default {
    color: inherit;
  }

  .status-deploying {
    align-items: center;
    background: #fff7ed;
    border: 1px solid #fdba74;
    border-radius: 999px;
    color: #9a3412;
    display: inline-flex;
    font-size: 0.8rem;
    font-weight: 600;
    gap: 0.35rem;
    line-height: 1;
    padding: 0.2rem 0.55rem;
    text-transform: uppercase;
  }

  .status-deploying::before {
    animation: deploying-pulse 1.2s ease-in-out infinite;
    background: #ea580c;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.45rem;
    width: 0.45rem;
  }

  @keyframes deploying-pulse {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }

    50% {
      opacity: 1;
      transform: scale(1);
    }
  }

</style>