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
    primaryIp?: string;
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
    containerGuiSupported: boolean;
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
      upid?: string;
      workloadAction?: 'start' | 'stop' | 'restart';
      workloadType?: 'vm' | 'container';
      formType?: 'vm-template' | 'lxc-template' | 'vm' | 'container';
    } | null;
  } = $props();

  // Derived: Split form state for each type of action so only the relevant subcomponent receives feedback
  const templateForm = $derived(form?.formType === 'vm-template' ? form : null);
  const lxcTemplateForm = $derived(form?.formType === 'lxc-template' ? form : null);
  const vmForm = $derived(form?.formType === 'vm' ? form : null);
  const containerForm = $derived(form?.formType === 'container' ? form : null);

  const lxcGuestTemplates = $derived(
    (data.results?.containers ?? []).filter(
      (container) => container.template === 1 || container.template === true || container.isTemplate === true
    )
  );

  const lxcWorkloads = $derived(
    (data.results?.containers ?? []).filter(
      (container) => !(container.template === 1 || container.template === true || container.isTemplate === true)
    )
  );

  let lastContainerIpRefreshActionId = $state<string | null>(null);

  $effect(() => {
    if (form?.status !== 'success' || form.workloadType !== 'container') {
      return;
    }

    if (form.workloadAction !== 'start' && form.workloadAction !== 'restart') {
      return;
    }

    const actionId = form.upid ?? `${form.message ?? ''}:${form.workloadAction}`;
    if (actionId === lastContainerIpRefreshActionId) {
      return;
    }
    lastContainerIpRefreshActionId = actionId;

    // Refresh in the background a few times after boot/reboot so container
    // networking can settle and interface-derived IPv4 data appears quickly.
    const timeouts = [0, 1500, 4000, 8000].map((delayMs) =>
      setTimeout(() => {
        void invalidateAll();
      }, delayMs)
    );

    return () => {
      for (const timeout of timeouts) {
        clearTimeout(timeout);
      }
    };
  });

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

  type WorkloadTab = 'vms' | 'lxc';

  const TAB_COOKIE = 'pxmx_active_tab';
  const TAB_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

  function readTabCookie(): WorkloadTab {
    if (typeof document === 'undefined') return 'vms';
    const match = document.cookie.split('; ').find((c) => c.startsWith(`${TAB_COOKIE}=`));
    const value = match?.split('=')[1];
    return value === 'lxc' ? 'lxc' : 'vms';
  }

  function writeTabCookie(tab: WorkloadTab): void {
    document.cookie = `${TAB_COOKIE}=${tab}; path=/; max-age=${TAB_COOKIE_MAX_AGE}; SameSite=Strict`;
  }

  let activeTab = $state<WorkloadTab>(readTabCookie());

  function setActiveTab(tab: WorkloadTab): void {
    activeTab = tab;
    writeTabCookie(tab);
  }
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
      <div class="pxmx-tabs">
        <div class="pxmx-tab-bar" role="tablist">
          <button
            role="tab"
            aria-selected={activeTab === 'vms'}
            aria-controls="tab-panel-vms"
            id="tab-vms"
            class:active={activeTab === 'vms'}
            onclick={() => { setActiveTab('vms'); }}
          >Virtual Machines</button>
          <button
            role="tab"
            aria-selected={activeTab === 'lxc'}
            aria-controls="tab-panel-lxc"
            id="tab-lxc"
            class:active={activeTab === 'lxc'}
            onclick={() => { setActiveTab('lxc'); }}
          >LXC Containers</button>
        </div>

        {#if activeTab === 'vms'}
          <div
            id="tab-panel-vms"
            role="tabpanel"
            aria-labelledby="tab-vms"
          >
            <PxMxVMTemplateList workloads={data.results.vms} form={templateForm} />
            <PxMxWorkloadList
              kind="vm"
              workloads={data.results.vms.filter((vm) => !vm.template && !vm.isTemplate)}
              form={vmForm}
            />
          </div>
        {:else}
          <div
            id="tab-panel-lxc"
            role="tabpanel"
            aria-labelledby="tab-lxc"
          >
            <PxMxLxcTemplateList
              workloads={data.results.lxcTemplates}
              containerTemplates={lxcGuestTemplates}
              serverNode={data.results.serverNode}
              form={lxcTemplateForm}
            />
            <PxMxWorkloadList
              kind="container"
              workloads={lxcWorkloads}
              form={containerForm}
              containerGuiEnabled={data.results.containerGuiSupported}
            />
          </div>
        {/if}
      </div>

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