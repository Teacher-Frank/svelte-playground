<script lang="ts">
  import './PxMxStyle.css';
  import { useToast } from './notification-store.svelte.js';
  import ToastNotification from './ToastNotification.svelte';
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

  const formatWorkloadIp = (workload: Workload): string => {
    if (workload.primaryIp && workload.primaryIp.trim().length > 0) {
      return workload.primaryIp;
    }

    // Running guests may need a short settle period before interfaces/guest agent
    // report a usable IPv4; show '?' while discovery is still in progress.
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
    if (normalized === 'deploying') return 'status-deploying';
    if (normalized === 'deploy-failed') return 'status-deploy-failed';
    if (normalized === 'destroying') return 'status-destroying';
    if (normalized === 'destroyfailed') return 'status-destroy-failed';
    return 'status-default';
  };

  const deployingTooltip = (workload: Workload): string | undefined => {
    if (workload.status === 'destroying') {
      return 'Destroying — workload is being stopped and will be removed.';
    }
    if (workload.status === 'destroyFailed') {
      return 'Destroy failed — background task did not complete. Check server logs or retry.';
    }
    if (workload.status !== 'deploying' && workload.status !== 'deploy-failed') {
      return undefined;
    }
    if (workload.status === 'deploy-failed') {
      return 'Deploy failed — background setup error (clone succeeded, config/start failed)';
    }
    if (!workload.deployTaskUpids?.length) {
      return undefined;
    }
    return `Tasks: ${workload.deployTaskUpids.join(', ')}`;
  };

  // Unified notification system — scope changes with kind prop
  // Use $derived.by so kind is read inside the closure and re-evaluates reactively.
  const notify = $derived.by(() => useToast(kind === 'vm' ? 'vm-workloads' : 'container-workloads'));

  // Track which failure notifications have already been fired (to avoid spamming on every refresh cycle).
  const notifiedFailureNames = $state(new Set<string>());

  // Fire error notification when a deploy is detected as failed.
  $effect(() => {
    for (const workload of workloads) {
      if (workload.status !== 'deploy-failed') continue;
      if (notifiedFailureNames.has(workload.name ?? '')) continue;

      notify.error(`Deploy failed: "${workload.name}" — background setup error (clone succeeded, config/start failed). Check server logs for details.`);
      notifiedFailureNames.add(workload.name ?? '');
    }
  });

  // React to form results from server
  $effect(() => {
    if (!form?.message || form.workloadType !== kind) return;
    if (form.status === 'error') {
      notify.error(form.message);
    } else {
      notify.success(form.message);
    }
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
                    <span>{formatWorkloadIp(workload)}</span>
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
                  disabled={workload.id == null || workload.status === 'deploying' || workload.status === 'destroying' || workload.status === 'destroyFailed'}
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
              <span>IP</span>
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
                    <span>{formatWorkloadIp(workload)}</span>
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
                  disabled={workload.id == null || workload.status === 'deploying' || workload.status === 'destroying' || workload.status === 'destroyFailed'}
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

  <!-- Unified notification -->
  <ToastNotification {notify} inline={true} />
</section>

<style>
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

  .status-deploy-failed {
    align-items: center;
    background: #fef2f2;
    border: 1px solid #fca5a5;
    border-radius: 999px;
    color: #991b1b;
    display: inline-flex;
    font-size: 0.8rem;
    font-weight: 600;
    gap: 0.35rem;
    line-height: 1;
    padding: 0.2rem 0.55rem;
    text-transform: uppercase;
  }

  .status-deploy-failed::before {
    background: #dc2626;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.45rem;
    width: 0.45rem;
  }

  .status-destroying {
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

  .status-destroying::before {
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

  .status-destroy-failed {
    align-items: center;
    background: #fef2f2;
    border: 1px solid #f87171;
    border-radius: 999px;
    color: #991b1b;
    display: inline-flex;
    font-size: 0.8rem;
    font-weight: 600;
    gap: 0.35rem;
    line-height: 1;
    padding: 0.2rem 0.55rem;
    text-transform: uppercase;
  }

  .status-destroy-failed::before {
    background: #dc2626;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.45rem;
    width: 0.45rem;
  }

</style>