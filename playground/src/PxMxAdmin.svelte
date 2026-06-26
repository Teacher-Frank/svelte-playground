<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import './PxMxStyle.css';
  import { useToast } from './notification-store.svelte.js';
  import ToastNotification from './ToastNotification.svelte';
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
    // When all tracked tasks first settled as completed (not running). Used to detect
    // deploy failures when the workload never appears after a grace period.
    tasksSettledAt: number | null;
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
      STATUS_REFRESH_SECONDS = Math.max(5, Math.floor(configuredSeconds as number));
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

  /**
   * Maps UPID → last-seen terminal status (endtime > 0 or ok/stopped/error/warnings).
   * Used to detect when a task *just* completed between load cycles so we can log it.
   */
  const lastTaskState = $state<Map<string, { status: string; endtime: number | null; type: string }>>(new Map());

  /**
   * Logs the full task payload from `recentTasks` for debugging Proxmox task
   * completion. Exposed as `window.pveDebug.allTasks()` for browser console use.
   */
  const debugAllTaskLogs = () => {
    if (deployingWorkloads.length === 0) {
      console.info('[taskLogs] no deploying workloads');
      return;
    }
    for (const pending of deployingWorkloads) {
      if (pending.taskUpids.length === 0) {
        console.info(`[taskLogs] "${pending.name}" — no task UPIDs tracked`);
        continue;
      }
      const tasks = data.results?.recentTasks ?? [];
      console.info(`[taskLogs] "${pending.name}" — checking ${pending.taskUpids.length} UPID(s) against ${tasks.length} recentTasks entries:`);
      for (const upid of pending.taskUpids) {
        const task = tasks.find((t) => t.upid === upid);
        if (!task) {
          console.warn(`[taskLogs]   ✗ UPID not found: ${upid}`);
          continue;
        }
        console.info(
          `[taskLogs]   ✓ ${upid} → type="${task.type ?? '?'}" node="${task.node ?? '?'}" status="${task.status ?? '?'}" endtime=${task.endtime ?? 'null'}`,
          task,
        );
      }
    }
  };

  // Expose debug helpers to window for browser console inspection.
  // Usage: window.pveDebug.allTasks()  — dump all deploying workload task details.
  if (typeof globalThis !== 'undefined') {
    const w = globalThis as typeof globalThis & { pveDebug?: { allTasks: () => void } };
    if (!w.pveDebug) {
      w.pveDebug = { allTasks: debugAllTaskLogs };
    } else {
      w.pveDebug.allTasks = debugAllTaskLogs;
    }
  }

  const isTaskActive = (upid: string): boolean | undefined => {
    const task = data.results?.recentTasks.find((item) => item.upid === upid);
    if (!task) {
      console.debug(`[isTaskActive] UPID not found in recentTasks (${(data.results?.recentTasks?.length ?? 0)} total): ${upid}`);
      return undefined;
    }

    if (typeof task.endtime === 'number' && task.endtime > 0) {
      console.debug(`[isTaskActive] UPID ${upid} has endtime=${task.endtime} (${new Date(task.endtime * 1000).toISOString()}) — not active`);
      return false;
    }

    const normalizedStatus = (task.status ?? '').trim().toLowerCase();
    if (
      normalizedStatus === 'ok' ||
      normalizedStatus === 'stopped' ||
      normalizedStatus === 'error' ||
      normalizedStatus === 'warnings'
    ) {
      console.debug(`[isTaskActive] UPID ${upid} status="${normalizedStatus}" endtime=${task.endtime} type="${task.type}" — not active`);
      return false;
    }

    console.debug(`[isTaskActive] UPID ${upid} status="${normalizedStatus}" no endtime — active`);
    return true;
  };

  /**
   * Returns true if the deploying entry should be removed.
   * On success: resolved immediately when workload appears.
   * On failure: shows "deploy-failed" status, then removed after a short timeout.
   *
   * Deploy failure detection: when all tracked tasks complete but the workload
   * never appears on the server, we give a grace period then mark it failed.
   * This catches background deploy failures (e.g., `runPostCloneSteps` crashing,
   * orphan cleanup) that the UI can't directly observe.
   */
  const DEPLOY_FAILURE_GRACE_MS = 60_000; // 60 seconds after tasks settle before marking failed
  const DEPLOY_FAILED_VISIBLE_MS = 10_000; // Show "deploy-failed" status for 10 seconds before auto-removal

  const isDeployResolved = (pending: DeployingWorkload): boolean => {
    const now = Date.now();
    const ageMs = now - pending.startedAt;

    // Hard cap: never hold a deploying entry beyond 10 minutes regardless of task state.
    if (ageMs > 10 * 60 * 1000) {
      console.debug(`[isDeployResolved] "${pending.name}" — HARD CAP HIT after ${(ageMs / 1000).toFixed(1)}s (taskUpids: ${pending.taskUpids.length}, tasksSettledAt: ${pending.tasksSettledAt}, workloadExists: check below)`);
      return true;
    }

    // Always show deploying for at least the minimum window. This prevents the entry
    // from being pruned in the same reactive cycle that task UPIDs arrive — which
    // happens when both tasks complete during the server action's own execution time.
    if (now < pending.resolveNotBefore) {
      console.debug(`[isDeployResolved] "${pending.name}" — within minimum visible window (resolveNotBefore: ${new Date(pending.resolveNotBefore).toISOString()})`);
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
        console.debug(`[isDeployResolved] "${pending.name}" — task(s) still active (states: ${JSON.stringify(states)})`);
        return false;
      }
      // All tasks are either completed or unknown (aged out of recentTasks).
      // Resolve as soon as the workload exists on the server.
      if (workloadExists) {
        console.debug(`[isDeployResolved] "${pending.name}" — RESOLVED: workload found on server`);
        return true;
      }
      // Workload not found — check if this is a confirmed failure.
      if (pending.tasksSettledAt !== null && now - pending.tasksSettledAt > DEPLOY_FAILURE_GRACE_MS) {
        const shouldRemove = now - pending.tasksSettledAt > DEPLOY_FAILURE_GRACE_MS + DEPLOY_FAILED_VISIBLE_MS;
        console.debug(`[isDeployResolved] "${pending.name}" — workload NOT found, tasksSettledAt=${new Date(pending.tasksSettledAt).toISOString()}, grace elapsed: ${((now - pending.tasksSettledAt) / 1000).toFixed(1)}s, removing: ${shouldRemove}`);
        return shouldRemove;
      }
      console.debug(`[isDeployResolved] "${pending.name}" — tasks done but no tasksSettledAt yet, workloadExists=${workloadExists}, keeping deploying`);
      return false;
    }

    console.debug(`[isDeployResolved] "${pending.name}" — no task IDs yet (optimistic phase), age: ${(ageMs / 1000).toFixed(1)}s`);
    return false;
  };

  /**
   * Returns true if the deploying workload likely failed — all tasks completed
   * but the workload never appeared after the grace period.
   */
  const isDeployFailed = (pending: DeployingWorkload): boolean => {
    const now = Date.now();

    // Respect the minimum visible window — don't declare failure too early.
    if (now < pending.resolveNotBefore) {
      return false;
    }

    if (pending.taskUpids.length > 0) {
      const states = pending.taskUpids.map((upid) => isTaskActive(upid));
      const tasksDone = !states.some((state) => state === true);

      if (tasksDone && pending.tasksSettledAt !== null) {
        const pendingName = pending.name.trim().toLowerCase();
        const pendingNode = (pending.node ?? '').trim().toLowerCase();
        const source = pending.kind === 'vm' ? vmWorkloadsFromServer : lxcWorkloadsFromServer;

        const workloadExists = source.some((workload) => {
          const workloadName = (workload.name ?? '').trim().toLowerCase();
          if (workloadName !== pendingName) return false;
          if (pendingNode.length === 0) return true;
          return (workload.node ?? '').trim().toLowerCase() === pendingNode;
        });

        const failed = !workloadExists && now - pending.tasksSettledAt > DEPLOY_FAILURE_GRACE_MS;
        if (failed) {
          console.debug(`[isDeployFailed] "${pending.name}" — FAILED: workload not found after grace period (${((now - pending.tasksSettledAt) / 1000).toFixed(1)}s); tasksSettledAt=${new Date(pending.tasksSettledAt).toISOString()}`);
        }
        return failed;
      }
    }

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
        resolveNotBefore: isUpgrade
          ? Date.now() + DEPLOY_MIN_VISIBLE_MS
          : (existing?.resolveNotBefore ?? Date.now() + DEPLOY_MIN_VISIBLE_MS),
        tasksSettledAt: existing?.tasksSettledAt ?? null,
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
    // Detect when tracked deploy tasks just completed (between load cycles)
    // so we can surface the Proxmox task data in the console.
    const tasks = data.results?.recentTasks ?? [];
    for (const pending of deployingWorkloads) {
      if (pending.taskUpids.length === 0) continue;
      for (const upid of pending.taskUpids) {
        const task = tasks.find((t) => t.upid === upid);
        if (!task) continue;
        const isTerminal =
          typeof task.endtime === 'number' && task.endtime > 0
            ? true
            : ['ok', 'stopped', 'error', 'warnings'].includes((task.status ?? '').trim().toLowerCase());
        const prevState = lastTaskState.get(upid);
        const newTerminal = isTerminal
          ? { status: task.status ?? '', endtime: task.endtime ?? null, type: task.type ?? '' }
          : null;
        if (newTerminal && prevState === undefined) {
          const eventType = (task.status ?? '').toLowerCase() === 'error' ? 'ERROR' : 'completed';
          console.info(
            `[taskTransition] "${pending.name}" UPID ${upid} → ${eventType} | type="${task.type ?? '?'}" node="${task.node ?? '?'}" status="${task.status ?? '?'}" endtime=${task.endtime ?? 'null'}`,
          );
          lastTaskState.set(upid, newTerminal);
        } else if (!isTerminal && prevState === undefined) {
          console.info(
            `[taskTransition] "${pending.name}" UPID ${upid} → started | type="${task.type ?? '?'}" node="${task.node ?? '?'}" status="${task.status ?? '?'}"`,
          );
        }
      }
    }

    // Update tasksSettledAt for entries where tasks have just completed but the workload
    // hasn't appeared yet — needed for deploy failure detection.
    const now = Date.now();
    const updated = deployingWorkloads.map((pending) => {
      if (pending.taskUpids.length === 0 || pending.tasksSettledAt !== null) {
        return pending;
      }

      const states = pending.taskUpids.map((upid) => isTaskActive(upid));
      const allSettled = !states.some((state) => state === true);

      if (allSettled) {
        const pendingName = pending.name.trim().toLowerCase();
        const pendingNode = (pending.node ?? '').trim().toLowerCase();
        const source = pending.kind === 'vm' ? vmWorkloadsFromServer : lxcWorkloadsFromServer;
        const workloadExists = source.some((workload) => {
          const workloadName = (workload.name ?? '').trim().toLowerCase();
          if (workloadName !== pendingName) return false;
          if (pendingNode.length === 0) return true;
          return (workload.node ?? '').trim().toLowerCase() === pendingNode;
        });
        if (!workloadExists) {
          console.debug(`[$effect:deployManager] "${pending.name}" — tasks just settled (allSettled=true, workloadExists=false), setting tasksSettledAt=${new Date(now).toISOString()} | states=${JSON.stringify(states)} | upids=${JSON.stringify(pending.taskUpids)}`);
          return { ...pending, tasksSettledAt: now };
        }
      }
      return pending;
    });

    // Remove resolved and failed entries
    const filtered = updated.filter((pending) => !isDeployResolved(pending));
    const isUnchanged =
      filtered.length === deployingWorkloads.length &&
      filtered.every((pending, index) => pending.key === deployingWorkloads[index]?.key);

    if (!isUnchanged) {
      console.debug(`[$effect:deployManager] state changed: ${deployingWorkloads.length} → ${filtered.length} entries`);
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
        status: isDeployFailed(pending) ? 'deploy-failed' : 'deploying',
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
        status: isDeployFailed(pending) ? 'deploy-failed' : 'deploying',
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

  // Coalesce all invalidateAll() calls into a single in-flight request so that:
  // - The staggered container-start refreshes (4 calls in 8 s) don't create a storm
  // - The periodic refresh and action-triggered refreshes don't overlap
  // - Pending refresh requests are dropped if one is already in flight (data will be fresh anyway)
  // NOTE: This variable persists across prop updates — the component instance is not
  // recreated by invalidateAll(), so a plain `let` is sufficient.
  let _refreshInFlight = false;
  const refresh = async () => {
    if (_refreshInFlight) return;
    _refreshInFlight = true;
    try {
      await invalidateAll();
    } finally {
      // Small delay before releasing the lock — prevents microtask-level re-entrant calls
      // that can happen when a page update triggers before the finally block runs.
      setTimeout(() => { _refreshInFlight = false; }, 200);
    }
  };

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
        void refresh();
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
      if (typeof document !== 'undefined' && document.hidden) {
        return;
      }
      void refresh();
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

  // Page-scoped notifications for server-generated one-time messages
  const pageNotify = useToast('page');
  let shownNotificationCount = $state(0);

  $effect(() => {
    const msgs = data.results?.notifications;
    if (msgs?.length && msgs.length > shownNotificationCount) {
      const newMsgs = msgs.slice(shownNotificationCount).join(' ');
      pageNotify.success(newMsgs);
      shownNotificationCount = msgs.length;
    } else if (!msgs || msgs.length === 0) {
      shownNotificationCount = 0;
    }
  });
</script>

  <main class="pxmx-admin">
    <ToastNotification notify={pageNotify} inline={true} />

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
          min="5"
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