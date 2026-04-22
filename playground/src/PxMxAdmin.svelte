<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import './PxMxStyle.css';
  import PxMxServerStatus from './PxMxServerStatus.svelte';
  import PxMxTasklist from './PxMxTasklist.svelte';
  import PxMxVMTemplateList from './PxMxVMTemplateList.svelte';
  import PxMxLxcTemplateList from './PxMxLxcTemplateList.svelte';
  import PxMxWorkloadList from './PxMxWorkloadList.svelte';

  // Controls how often the UI refreshes Proxmox data (in seconds)
  let STATUS_REFRESH_SECONDS = $state(5);
  // Toggle for enabling/disabling auto-refresh
  let REFRESH_ENABLED = $state(true);

  // Derived: Calculate refresh interval in ms from seconds
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
    isTemplate?: boolean;
    template?: number | boolean;
  };


  type LxcTemplate = {
    storage: string;
    volid: string;
    format: string;
    size: number;
    content: string;
    notes?: string;
    parent?: string;
    ctime?: number;
    used?: number;
    vmid?: number;
    // ...other fields from Proxmox API
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
    lxcTemplates: LxcTemplate[];
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


  // Props: data contains all backend results, form is for feedback messages (success/error)
  let {
    data,
    form
  }: {
    data: { results: ProxmoxResults | null; error: string | null };
    form?: {
      message?: string;
      status?: 'success' | 'error';
      workloadType?: 'vm' | 'container';
      formType?: 'vm-template' | 'lxc-template' | 'vm' | 'container';
    } | null;
  } = $props();

  // Derived: Split form state for each type of action so only the relevant subcomponent receives feedback
  const templateForm = $derived(form?.formType === 'vm-template' ? form : null);
  const lxcTemplateForm = $derived(form?.formType === 'lxc-template' ? form : null);
  const vmForm = $derived(form?.formType === 'vm' ? form : null);
  const containerForm = $derived(form?.formType === 'container' ? form : null);

  // Effect: Set up periodic refresh if enabled
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
        <!-- Show error if backend returned an error string -->
        <p class="load-error">{data.error}</p>
      {/if}

      <!-- Controls for refresh interval and toggle -->
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

      <!-- Show server status summary -->
      <PxMxServerStatus results={data.results} />

      <!-- Show VM template list and LXC template list, each with their own feedback form -->
      <PxMxVMTemplateList workloads={data.results.vms} form={templateForm} />
      <PxMxLxcTemplateList workloads={data.results.lxcTemplates} form={lxcTemplateForm} />

      <!-- Show lists of running VMs and containers -->
      <PxMxWorkloadList kind="vm" workloads={data.results.vms.filter((vm) => !vm.template && !vm.isTemplate)} form={vmForm} />
      <PxMxWorkloadList kind="container" workloads={data.results.containers} form={containerForm} />

      <!-- Show recent Proxmox tasks -->
      <PxMxTasklist tasks={data.results.recentTasks} />
    {:else if data.error}
      <!-- Show error if no results but error present -->
      <p class="load-error">{data.error}</p>
    {:else}
      <!-- Fallback if no data at all -->
      <p>No Proxmox data available.</p>
    {/if}
  </main>