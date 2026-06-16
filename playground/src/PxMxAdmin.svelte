<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import './PxMxStyle.css';
  import PxMxServerStatus from './PxMxServerStatus.svelte';
  import PxMxTasklist from './PxMxTasklist.svelte';
  import PxMxVMTemplateList from './PxMxVMTemplateList.svelte';
  import PxMxLxcTemplateList from './PxMxLxcTemplateList.svelte';
  import PxMxWorkloadList from './PxMxWorkloadList.svelte';

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
    isTemplate?: boolean;
    template?: number | boolean;
  };

  type DeployWorkloadKind = 'vm' | 'container';

  type DeployingWorkload = {
    key: string;
    kind: DeployWorkloadKind;
    name: string;
    node?: string;
    startedAt: number;
    taskUpids: string[];
    // Earliest time at which resolution may be considered. Prevents the deploying
    // row from disappearing in the same reactive cycle that task UPIDs arrive,
    // which happens when both tasks complete during the server action's execution time.
    resolveNotBefore: number;
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
    guestGuiBridgeSupported: boolean;
    serverStatus: string;
    refreshIntervalSeconds: number;
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
    notifications: string[];
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
      deployWorkloadName?: string;
      deployTaskNode?: string;
      deployTaskUpids?: string[];
    } | null;
  } = $props();

  // Controls how often the UI refreshes Proxmox data (in seconds)
  let STATUS_REFRESH_SECONDS = $state(5);
  // Toggle for enabling/disabling auto-refresh
  let REFRESH_ENABLED = $state(true);
  let refreshIntervalInitialized = $state(false);

  // Derived: Calculate refresh interval in ms from seconds
  const REFRESH_INTERVAL_MS = $derived.by(() => {
    const seconds = Number(STATUS_REFRESH_SECONDS);
    return (Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 1) * 1000;
  });

  // Derived: Split form state for each type of action so only the relevant subcomponent receives feedback
  const templateForm = $derived(form?.formType === 'vm-template' ? form : null);
  const lxcTemplateForm = $derived(form?.formType === 'lxc-template' ? form : null);
  const vmForm = $derived(form?.formType === 'vm' ? form : null);
  const containerForm = $derived(form?.formType === 'container' ? form : null);

  $effect(() => {
    if (refreshIntervalInitialized) {
      return;
    }

    const configuredSeconds = data.results?.refreshIntervalSeconds;
    if (Number.isFinite(configuredSeconds)) {
      STATUS_REFRESH_SECONDS = Math.max(1, Math.floor(configuredSeconds as number));
    }
    refreshIntervalInitialized = true;
  });

  const lxcGuestTemplates = $derived(
    (data.results?.containers ?? []).filter(
      (container) => container.template === 1 || container.template === true || container.isTemplate === true
    )
  );

  const lxcWorkloadsFromServer = $derived(
    (data.results?.containers ?? []).filter(
      (container) => !(container.template === 1 || container.template === true || container.isTemplate === true)
    )
  );

  const vmWorkloadsFromServer = $derived(
    (data.results?.vms ?? []).filter((vm) => !vm.template && !vm.isTemplate)
  );

  let deployingWorkloads = $state<DeployingWorkload[]>([]);
  let lastHandledDeploySignature = $state<string | null>(null);

  const makeDeployingKey = (kind: DeployWorkloadKind, name: string): string =>
    `${kind}:${name.trim().toLowerCase()}`;

  const normalizeUpids = (taskUpids?: string[]): string[] =>
    (taskUpids ?? []).filter((upid) => typeof upid === 'string' && upid.trim().length > 0);

  const isTaskActive = (upid: string): boolean | undefined => {
    const task = data.results?.recentTasks.find((item) => item.upid === upid);
    if (!task) {
      return undefined;
    }

    if (typeof task.endtime === 'number' && task.endtime > 0) {
      return false;
    }

    const normalizedStatus = (task.status ?? '').trim().toLowerCase();
    if (
      normalizedStatus === 'ok' ||
      normalizedStatus === 'stopped' ||
      normalizedStatus === 'error' ||
      normalizedStatus === 'warnings'
    ) {
      return false;
    }

    return true;
  };

  const isDeployResolved = (pending: DeployingWorkload): boolean => {
    const now = Date.now();
    const ageMs = now - pending.startedAt;

    // Hard cap: never hold a deploying entry beyond 10 minutes regardless of task state.
    if (ageMs > 10 * 60 * 1000) {
      return true;
    }

    // Always show deploying for at least the minimum window. This prevents the entry
    // from being pruned in the same reactive cycle that task UPIDs arrive — which
    // happens when both tasks complete during the server action's own execution time.
    if (now < pending.resolveNotBefore) {
      return false;
    }

    const pendingName = pending.name.trim().toLowerCase();
    const pendingNode = (pending.node ?? '').trim().toLowerCase();
    const source = pending.kind === 'vm' ? vmWorkloadsFromServer : lxcWorkloadsFromServer;

    const workloadExists = source.some((workload) => {
      const workloadName = (workload.name ?? '').trim().toLowerCase();
      if (workloadName !== pendingName) {
        return false;
      }
      if (pendingNode.length === 0) {
        return true;
      }
      return (workload.node ?? '').trim().toLowerCase() === pendingNode;
    });

    if (pending.taskUpids.length > 0) {
      const states = pending.taskUpids.map((upid) => isTaskActive(upid));
      // At least one tracked task is still actively running — keep deploying.
      if (states.some((state) => state === true)) {
        return false;
      }
      // All tasks are either completed or unknown (aged out of recentTasks).
      // Resolve as soon as the workload exists on the server.
      if (workloadExists) {
        return true;
      }
      // Workload not yet visible on the server — keep deploying until
      // it appears or the hard cap expires.
      return false;
    }

    // No task IDs yet (optimistic phase before server responds) — keep deploying.
    return false;
  };

  const isShadowedByDeployingWorkload = (workload: Workload, kind: DeployWorkloadKind): boolean => {
    const workloadName = (workload.name ?? '').trim().toLowerCase();
    if (workloadName.length === 0) {
      return false;
    }

    return deployingWorkloads.some((pending) => {
      if (pending.kind !== kind) {
        return false;
      }

      if (pending.name.trim().toLowerCase() !== workloadName) {
        return false;
      }

      const pendingNode = (pending.node ?? '').trim().toLowerCase();
      const workloadNode = (workload.node ?? '').trim().toLowerCase();
      return pendingNode.length === 0 || pendingNode === workloadNode;
    });
  };

  const DEPLOY_MIN_VISIBLE_MS = 30_000;

  function markDeployingWorkload(kind: DeployWorkloadKind, name: string, node?: string, taskUpids?: string[]): void {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      return;
    }

    const key = makeDeployingKey(kind, normalizedName);
    const normalizedUpids = normalizeUpids(taskUpids);
    const existing = deployingWorkloads.find((pending) => pending.key === key);
    const isUpgrade = normalizedUpids.length > 0 && existing?.taskUpids.length === 0;
    deployingWorkloads = [
      ...deployingWorkloads.filter((pending) => pending.key !== key),
      {
        key,
        kind,
        name: normalizedName,
        node,
        startedAt: existing?.startedAt ?? Date.now(),
        taskUpids: normalizedUpids.length > 0 ? normalizedUpids : (existing?.taskUpids ?? []),
        // Reset the minimum visibility window when task UPIDs first arrive so
        // tasks that complete during server execution are still shown as deploying.
        resolveNotBefore: isUpgrade
          ? Date.now() + DEPLOY_MIN_VISIBLE_MS
          : (existing?.resolveNotBefore ?? Date.now() + DEPLOY_MIN_VISIBLE_MS),
      },
    ];
  }

  function clearDeployingWorkload(kind: DeployWorkloadKind, name: string): void {
    const normalizedName = name.trim();
    if (normalizedName.length === 0) {
      return;
    }
    const key = makeDeployingKey(kind, normalizedName);
    deployingWorkloads = deployingWorkloads.filter((pending) => pending.key !== key);
  }

  $effect(() => {
    const filtered = deployingWorkloads.filter((pending) => !isDeployResolved(pending));
    const isUnchanged =
      filtered.length === deployingWorkloads.length &&
      filtered.every((pending, index) => pending.key === deployingWorkloads[index]?.key);

    if (!isUnchanged) {
      deployingWorkloads = filtered;
    }
  });

  const deployingVmWorkloads = $derived(
    deployingWorkloads
      .filter((pending) => pending.kind === 'vm')
      .map((pending, index) => ({
        id: `deploying-vm-${pending.startedAt}-${index}`,
        name: pending.name,
        node: pending.node ?? '-',
        status: 'deploying',
        uptime: 0,
        deployTaskUpids: pending.taskUpids,
      }))
  );

  const deployingLxcWorkloads = $derived(
    deployingWorkloads
      .filter((pending) => pending.kind === 'container')
      .map((pending, index) => ({
        id: `deploying-lxc-${pending.startedAt}-${index}`,
        name: pending.name,
        node: pending.node ?? '-',
        status: 'deploying',
        uptime: 0,
        deployTaskUpids: pending.taskUpids,
      }))
  );

  const vmWorkloads = $derived([
    ...deployingVmWorkloads,
    ...vmWorkloadsFromServer.filter((workload) => !isShadowedByDeployingWorkload(workload, 'vm')),
  ]);
  const lxcWorkloads = $derived([
    ...deployingLxcWorkloads,
    ...lxcWorkloadsFromServer.filter((workload) => !isShadowedByDeployingWorkload(workload, 'container')),
  ]);

  $effect(() => {
    if (form?.status !== 'success') {
      return;
    }

    if ((form.formType !== 'vm-template' && form.formType !== 'lxc-template') || typeof form.deployWorkloadName !== 'string') {
      return;
    }

    const deploySignature = [
      form.formType,
      form.deployWorkloadName,
      form.deployTaskNode ?? '',
      ...(form.deployTaskUpids ?? []),
    ].join('|');
    if (deploySignature === lastHandledDeploySignature) {
      return;
    }
    lastHandledDeploySignature = deploySignature;

    markDeployingWorkload(
      form.formType === 'vm-template' ? 'vm' : 'container',
      form.deployWorkloadName,
      form.deployTaskNode,
      form.deployTaskUpids
    );
  });

  let lastContainerIpRefreshActionId = $state<string | null>(null);

  // Effect: Trigger staggered re-fetches after a container starts/restarts so guest
  // networking can settle and interface-derived IPv4 data appears quickly.
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

    let refreshInFlight = false;

    // Refreshes server status, VM/container status, and the task log together.
    const intervalId = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      if (refreshInFlight) {
        return;
      }

      refreshInFlight = true;
      void invalidateAll().finally(() => {
        refreshInFlight = false;
      });
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
    <!-- Toast notifications from server (e.g., DHCP→static conversions) -->
    {#if data.results?.notifications?.length}
      <div role="alert" class="action-status success" aria-live="polite">
        {#each data.results.notifications as msg (msg)}
          <p>{msg}</p>
        {/each}
      </div>
    {/if}

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
            <PxMxVMTemplateList
              workloads={data.results.vms}
              form={templateForm}
              onDeployStarted={({ name, node, taskUpids }: { name: string; node?: string; taskUpids?: string[] }) => {
                markDeployingWorkload('vm', name, node, taskUpids);
              }}
              onDeployFailed={({ name }: { name: string; node?: string }) => {
                clearDeployingWorkload('vm', name);
              }}
            />
            <PxMxWorkloadList
              kind="vm"
              workloads={vmWorkloads}
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
              onDeployStarted={({ name, node, taskUpids }: { name: string; node?: string; taskUpids?: string[] }) => {
                markDeployingWorkload('container', name, node, taskUpids);
              }}
              onDeployFailed={({ name }: { name: string; node?: string }) => {
                clearDeployingWorkload('container', name);
              }}
            />
            <PxMxWorkloadList
              kind="container"
              workloads={lxcWorkloads}
              form={containerForm}
              containerGuiEnabled={data.results.guestGuiBridgeSupported}
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