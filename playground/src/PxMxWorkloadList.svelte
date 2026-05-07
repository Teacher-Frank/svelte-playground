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
    ipAddress?: string;
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

  type IpScope = 'private' | 'public' | 'loopback' | 'link-local' | 'unknown';

  const classifyIpScope = (ipAddress?: string): { scope: IpScope; label: string } => {
    if (!ipAddress) return { scope: 'unknown', label: 'Unknown' };

    const value = ipAddress.trim().toLowerCase();
    const host = value.includes('/') ? value.split('/')[0] : value;
    if (!host) return { scope: 'unknown', label: 'Unknown' };

    if (host === '::1' || host.startsWith('127.')) {
      return { scope: 'loopback', label: 'Loopback' };
    }

    if (host.startsWith('169.254.') || host.startsWith('fe80:')) {
      return { scope: 'link-local', label: 'Link-local' };
    }

    if (host.includes('.')) {
      const octets = host.split('.').map((part) => Number(part));
      if (octets.length === 4 && octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)) {
        const [a, b] = octets;
        if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
          return { scope: 'private', label: 'Private' };
        }
        return { scope: 'public', label: 'Routable' };
      }
    }

    if (host.includes(':')) {
      if (host.startsWith('fc') || host.startsWith('fd')) {
        return { scope: 'private', label: 'Private' };
      }
      return { scope: 'public', label: 'Routable' };
    }

    return { scope: 'unknown', label: 'Unknown' };
  };

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
              {@const ipMeta = classifyIpScope(workload.ipAddress)}
              <span class="ip-cell">
                <span>{workload.ipAddress ?? '-'}</span>
                <span class={`ip-scope ip-scope-${ipMeta.scope}`}>{ipMeta.label}</span>
              </span>
            {/if}
            <span>{formatUptime(workload.uptime)}</span>
          </button>

          <PxMxWorkloadControls
            compact={true}
            disabled={workload.id == null}
            selectedWorkload={{ type: kind, id: workload.id, name: workload.name, node: workload.node, status: workload.status }}
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

  .ip-cell {
    align-items: center;
    display: inline-flex;
    gap: 0.35rem;
    min-width: 0;
  }

  .ip-scope {
    border-radius: 999px;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.01em;
    line-height: 1;
    padding: 0.18rem 0.45rem;
    text-transform: uppercase;
    white-space: nowrap;
  }

  .ip-scope-private {
    background: #e8f1ff;
    color: #1b4a91;
  }

  .ip-scope-public {
    background: #e9f8ef;
    color: #1c6c3b;
  }

  .ip-scope-loopback,
  .ip-scope-link-local {
    background: #fff3e0;
    color: #8a4b12;
  }

  .ip-scope-unknown {
    background: #f1f1f1;
    color: #666;
  }
</style>