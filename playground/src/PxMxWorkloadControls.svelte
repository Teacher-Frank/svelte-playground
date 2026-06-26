<script lang="ts">
  import { enhance } from '$app/forms';
  import './PxMxStyle.css';
  import { useToast } from './notification-store.svelte.js';
  import ToastNotification from './ToastNotification.svelte';

  type SelectedWorkload = {
    type: 'vm' | 'container';
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    primaryIp?: string;
    cpulimit?: number;
    memorylimit?: number;
    hostMaxCpu?: number;
    hostMaxMemory?: number;
    hostMaxStorage?: number;
    hostAvailableStorage?: number;
  };

  let {
    disabled = false,
    selectedLabel = 'No workload selected',
    selectedWorkload = null,
    compact = false,
    containerGuiEnabled = false,
  }: {
    disabled?: boolean;
    selectedLabel?: string;
    selectedWorkload?: SelectedWorkload | null;
    compact?: boolean;
    containerGuiEnabled?: boolean;
  } = $props();

  const controlsDisabled = $derived(
    disabled || selectedWorkload?.status === 'deploying' || selectedWorkload?.status === 'destroyFailed'
  );

  // Terminal is only useful when the selected guest is currently running.
  const terminalEnabled = $derived(
    !controlsDisabled &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const supportsGuiAccess = $derived(
    selectedWorkload?.type === 'vm' || containerGuiEnabled
  );

  const hasResolvedWorkloadIp = $derived(
    typeof selectedWorkload?.primaryIp === 'string' && selectedWorkload.primaryIp.trim().length > 0
  );

  // GUI/VNC access eligibility differs by workload type:
  // - VMs use native Proxmox VNC (vncproxy) — no IP address needed, just running state.
  // - Containers use bridge mode (websockify on guest) — requires resolved IPv4.
  const vncEnabled = $derived(
    !controlsDisabled &&
    supportsGuiAccess &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null &&
    (selectedWorkload.type === 'vm' || hasResolvedWorkloadIp)
  );

  const vncTooltip = $derived.by(() => {
    if (selectedWorkload?.type === 'container' && !containerGuiEnabled) {
      return 'GUI is not available for containers without an LXC VNC bridge';
    }

    if (selectedWorkload?.type === 'container' && !hasResolvedWorkloadIp) {
      return 'Waiting for container IPv4 address before enabling GUI (VNC)';
    }

    return 'Open GUI (VNC)';
  });

  // Destructive actions are allowed whenever a concrete workload is selected.
  // For destroyFailed: only delete is allowed, all other buttons are disabled.
  const deleteEnabled = $derived(
    !disabled &&
    (selectedWorkload?.status !== 'deploying') &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  // Conversion applies to any selected VM/container; running workloads are
  // stopped server-side before conversion.
  const convertToTemplateEnabled = $derived(
    !controlsDisabled &&
    (selectedWorkload?.type === 'container' || selectedWorkload?.type === 'vm') &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const convertToTemplateTooltip = $derived.by(() => {
    const targetLabel = selectedWorkload?.type === 'vm' ? 'VM' : 'container';
    if (selectedWorkload?.status === 'running') {
      return `Stop and convert ${targetLabel} to template`;
    }
    return `Convert ${targetLabel} to template`;
  });

  const hasHostCapacityData = $derived(
    typeof selectedWorkload?.hostMaxCpu === 'number' &&
    Number.isFinite(selectedWorkload.hostMaxCpu) &&
    selectedWorkload.hostMaxCpu > 0 &&
    typeof selectedWorkload?.hostMaxMemory === 'number' &&
    Number.isFinite(selectedWorkload.hostMaxMemory) &&
    selectedWorkload.hostMaxMemory > 0
  );

  const configureEnabled = $derived(
    !controlsDisabled &&
    (selectedWorkload?.type === 'container' || selectedWorkload?.type === 'vm') &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null &&
    hasHostCapacityData
  );

  const hostCpuCount = $derived(
    typeof selectedWorkload?.hostMaxCpu === 'number' && Number.isFinite(selectedWorkload.hostMaxCpu)
      ? selectedWorkload.hostMaxCpu
      : 0
  );

  const hostMemoryMiB = $derived(
    typeof selectedWorkload?.hostMaxMemory === 'number' && Number.isFinite(selectedWorkload.hostMaxMemory)
      ? Math.floor(selectedWorkload.hostMaxMemory / (1024 ** 2))
      : 0
  );

  const hostStorageGiB = $derived(
    typeof selectedWorkload?.hostMaxStorage === 'number' && Number.isFinite(selectedWorkload.hostMaxStorage)
      ? Math.floor(selectedWorkload.hostMaxStorage / (1024 ** 3))
      : 0
  );

  const hostAvailableStorageGiB = $derived(
    typeof selectedWorkload?.hostAvailableStorage === 'number' && Number.isFinite(selectedWorkload.hostAvailableStorage)
      ? Math.floor(selectedWorkload.hostAvailableStorage / (1024 ** 3))
      : 0
  );

  const maxCpuSharePercent = 75;

  const maxMemoryMiB = $derived(
    hostMemoryMiB > 0 ? Math.max(16, Math.floor(hostMemoryMiB * 0.75)) : 0
  );

  const defaultCpuSharePercent = $derived.by(() => {
    if (hostCpuCount <= 0) return 25;
    const currentCpuLimit = selectedWorkload?.cpulimit;
    if (typeof currentCpuLimit !== 'number' || !Number.isFinite(currentCpuLimit) || currentCpuLimit <= 0) {
      return 25;
    }
    const percent = Math.round((currentCpuLimit / hostCpuCount) * 100);
    return Math.min(maxCpuSharePercent, Math.max(1, percent));
  });

  const defaultMemoryMiB = $derived.by(() => {
    if (maxMemoryMiB <= 0) return 1024;
    const currentMemoryLimit = selectedWorkload?.memorylimit;
    if (typeof currentMemoryLimit !== 'number' || !Number.isFinite(currentMemoryLimit) || currentMemoryLimit <= 0) {
      return Math.min(maxMemoryMiB, 1024);
    }
    const currentMiB = Math.floor(currentMemoryLimit / (1024 ** 2));
    return Math.min(maxMemoryMiB, Math.max(16, currentMiB));
  });

  const configureTooltip = $derived.by(() => {
    if (selectedWorkload?.type !== 'container' && selectedWorkload?.type !== 'vm') {
      return 'Configuration is only available for VM and LXC workloads';
    }
    if (!hasHostCapacityData) {
      return 'Host capacity is unavailable for this node';
    }
    return selectedWorkload?.type === 'vm'
      ? 'Configure VM CPU, memory, and storage'
      : 'Configure container CPU, memory, and storage';
  });

  // Controls visibility of the high-friction delete confirmation dialog.
  let showDeleteConfirm = $state(false);
  let destroySubmitInFlight = $state(false);
  let showConfigureModal = $state(false);
  let configureSubmitInFlight = $state(false);

  // Unified notification system
  const notify = useToast('config');

  let cpuSharePercent = $state(25);
  let memoryMiB = $state(1024);
  let storageGiB = $state(1);
  let workloadName = $state('');

  const openConfigureModal = () => {
    cpuSharePercent = defaultCpuSharePercent;
    memoryMiB = defaultMemoryMiB;
    storageGiB = hostAvailableStorageGiB > 0 ? 1 : 0;
    workloadName = selectedWorkload?.name ?? '';
    showConfigureModal = true;
  };

  const preserveScrollOnSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
    };
  };

  const setWaitCursor = (enabled: boolean): void => {
    if (typeof document === 'undefined') return;
    document.body.style.cursor = enabled ? 'wait' : '';
  };

  const closeDeleteConfirm = (): void => {
    showDeleteConfirm = false;
    destroySubmitInFlight = false;
    setWaitCursor(false);
  };

  const enhanceDestroySubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    destroySubmitInFlight = true;
    setWaitCursor(true);

    // Keep dialog visible while submitting — it will close once the
    // server confirms the destroy was initiated.
    return async ({ update, result }: { update: () => Promise<void>; result: { type?: string; data?: { message?: string; upid?: string } } }) => {
      try {
        await update();
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });

        if (result?.type === 'success') {
          setWaitCursor(false);

          // Capture workload details before closing dialog (selectedWorkload may
          // become undefined on the next tick when the delete form is removed from DOM).
          const typeLabel = selectedWorkload?.type === 'vm' ? 'VM' : 'container';
          const workloadId = selectedWorkload?.id;

          showDeleteConfirm = false;

          // Show notification only after server confirms destroy was initiated.
          // Clean it after Proxmox confirms the destroy completed.
          // NOTE: The workload row shows a "destroying" badge as persistent feedback,
          // so we only toast the short-lived "initiated" notification and not floating
          // pending bar that would get stuck if the workload disappears before a success/error
          // notification arrives to clear it.
          notify.toast(`Destroying ${typeLabel} ${workloadId}…`);
        }

        if (result?.type === 'failure') {
          setWaitCursor(false);
          showDeleteConfirm = false;
          notify.error(result.data?.message ?? 'Failed to destroy workload.');
        }
      } finally {
        destroySubmitInFlight = false;
      }
    };
  };

  const enhanceConfigureSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    configureSubmitInFlight = true;
    showConfigureModal = false;

    // Hard timeout: if the server takes longer than this, force-release the state.
    const TIMEOUT_MS = 30_000;

    return async ({ result, update }: { result: { type?: string; data?: { message?: string } }; update: () => Promise<void> }) => {
      try {
        // Race update against a timeout so a hung server can't trap the state forever.
        await Promise.race([
          update(),
          new Promise<void>((resolve) => setTimeout(resolve, TIMEOUT_MS)),
        ]);
        window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });

        if (result?.type === 'success') {
          notify.success(result.data?.message ?? 'Container configuration updated.');
          return;
        }

        if (result?.type === 'failure') {
          notify.error(result.data?.message ?? 'Failed to update container configuration.');
        }
      } finally {
        configureSubmitInFlight = false;
      }
    };
  };

  $effect(() => {
    if (!controlsDisabled) {
      return;
    }
    showDeleteConfirm = false;
    showConfigureModal = false;
  });
</script>

<div class="workload-controls" class:compact>
  {#if !compact}
    <div class="selected-target">{selectedLabel}</div>
  {/if}

  <!-- Shared payload for start/stop/restart form actions. -->
  <form class="action-buttons" method="POST" use:enhance={preserveScrollOnSubmit}>
    <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
    <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
    <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
    <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />
    <input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />

    <button formaction="?/start" title="Start" aria-label="Start" disabled={controlsDisabled}>
      <img src="/play.svg" alt="" aria-hidden="true" />
    </button>

    <button formaction="?/stop" title="Stop" aria-label="Stop" disabled={controlsDisabled}>
      <img src="/stop.svg" alt="" aria-hidden="true" />
    </button>

    <button formaction="?/restart" title="Restart" aria-label="Restart" disabled={controlsDisabled}>
      <img src="/restart.svg" alt="" aria-hidden="true" />
    </button>
  </form>

  <!-- Opens the in-browser terminal route for the selected workload. -->
  <a
    class="terminal-btn"
    href={terminalEnabled
      ? `/proxmox/terminal?vmid=${encodeURIComponent(selectedWorkload!.id!)}&node=${encodeURIComponent(selectedWorkload!.node!)}&type=${encodeURIComponent(selectedWorkload!.type)}${selectedWorkload!.name ? `&name=${encodeURIComponent(selectedWorkload!.name)}` : ''}`
      : undefined}
    target={terminalEnabled ? '_blank' : undefined}
    rel={terminalEnabled ? 'noopener noreferrer' : undefined}
    title="Open terminal"
    aria-label="Open terminal"
    aria-disabled={!terminalEnabled}
    tabindex={terminalEnabled ? 0 : -1}
  >
    <img src="/terminal.svg" alt="" aria-hidden="true" />
  </a>

  <!-- Opens the in-browser noVNC route for GUI access to the selected workload. -->
  <a
    class="vnc-btn"
    href={vncEnabled
      ? `/proxmox/vnc?vmid=${encodeURIComponent(selectedWorkload!.id!)}&node=${encodeURIComponent(selectedWorkload!.node!)}&type=${encodeURIComponent(selectedWorkload!.type)}${selectedWorkload!.name ? `&name=${encodeURIComponent(selectedWorkload!.name)}` : ''}${selectedWorkload!.primaryIp ? `&ip=${encodeURIComponent(selectedWorkload!.primaryIp)}` : ''}`
      : undefined}
    target={vncEnabled ? '_blank' : undefined}
    rel={vncEnabled ? 'noopener noreferrer' : undefined}
    title={vncTooltip}
    aria-label={vncTooltip}
    aria-disabled={!vncEnabled}
    tabindex={vncEnabled ? 0 : -1}
  >
    <img src="/vnc.svg" alt="" aria-hidden="true" />
  </a>

  <button
    type="button"
    class="configure-btn"
    title={configureTooltip}
    aria-label={configureTooltip}
    disabled={!configureEnabled || configureSubmitInFlight}
    onclick={openConfigureModal}
  >
    <img src="/settings.svg" alt="" aria-hidden="true" />
  </button>

  <form class="convert-form" method="POST" action="?/convertToTemplate" use:enhance={preserveScrollOnSubmit}>
    <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
    <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
    <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
    <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />
    <input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />
    <button
      type="submit"
      title={convertToTemplateTooltip}
      aria-label={convertToTemplateTooltip}
      class="template-btn"
      disabled={!convertToTemplateEnabled}
    >
      <img src="/template.svg" alt="" aria-hidden="true" />
    </button>
  </form>

  <!-- Triggers an explicit confirmation overlay before submitting destroy. -->
  <button
    type="button"
    class="delete-btn"
    title="Delete workload"
    aria-label="Delete workload"
    disabled={!deleteEnabled}
    onclick={() => { showDeleteConfirm = true; }}
  >
    <img src="/remove.svg" alt="" aria-hidden="true" />
  </button>

  {#if showDeleteConfirm}
    <!-- Aggressive confirmation UI to reduce accidental destructive clicks. -->
    <div
      class="delete-confirm-overlay"
      class:waiting={destroySubmitInFlight}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="delete-confirm-title"
    >
      <div class="delete-confirm-box">
        <p id="delete-confirm-title" class="delete-confirm-title">
          ⚠️ DANGER !! PERMANENT DELETION !!
        </p>
        <p class="delete-confirm-body">
          This will <strong>permanently destroy</strong>
          {selectedWorkload?.name ? `"${selectedWorkload.name}"` : `workload ${selectedWorkload?.id}`}
          and all its disks!<br />
          <strong>THIS CANNOT BE UNDONE!!!</strong>
        </p>
        <div class="delete-confirm-actions">
          <!-- Destroy action receives the same workload identifiers as the power actions. -->
          <form method="POST" action="?/destroy" use:enhance={enhanceDestroySubmit}>
            <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
            <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
            <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
            <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />
            <input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />
            <button type="submit" class="delete-confirm-yes">
              {destroySubmitInFlight ? 'DESTROYING...' : 'YES, DESTROY IT!!!'}
            </button>
          </form>
          <button
            type="button"
            class="delete-confirm-cancel"
            onclick={closeDeleteConfirm}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if showConfigureModal}
    <div class="config-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="config-modal-title">
      <div class="config-modal-box">
        <h3 id="config-modal-title">Workload Configuration</h3>
        <p class="config-modal-subtitle">
          Set required CPU share, memory, and optional storage expansion. CPU/memory limits remain capped at 75% of host capacity.
        </p>

        <form
          method="POST"
          action="?/configureWorkload"
          use:enhance={enhanceConfigureSubmit}
        >
          <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
          <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
          <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
          <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />
          <input name="status" type="hidden" value={selectedWorkload?.status ?? ''} />

          <label class="config-label" for="workload-name">Name</label>
          <input
            id="workload-name"
            name="newName"
            type="text"
            minlength="1"
            maxlength="253"
            bind:value={workloadName}
            placeholder="Workload name"
          />
          <p class="config-hint">Leave unchanged to keep the current name. Use letters, digits, hyphens, and dots.</p>

          <label class="config-label" for="cpu-share-percent">Needed CPU share (%)</label>
          <input
            id="cpu-share-percent"
            name="cpuSharePercent"
            type="number"
            min="1"
            max={maxCpuSharePercent}
            step="1"
            bind:value={cpuSharePercent}
            required
          />
          <p class="config-hint">Host CPU: {hostCpuCount.toFixed(0)} core(s) • Max share: {maxCpuSharePercent}%</p>

          <label class="config-label" for="memory-mib">Needed memory (MiB)</label>
          <input
            id="memory-mib"
            name="memoryMiB"
            type="number"
            min="16"
            max={maxMemoryMiB}
            step="1"
            bind:value={memoryMiB}
            required
          />
          <p class="config-hint">Host memory: {hostMemoryMiB.toLocaleString()} MiB • Max memory: {maxMemoryMiB.toLocaleString()} MiB</p>

          <label class="config-label" for="storage-gib">Add storage (GiB)</label>
          <input
            id="storage-gib"
            name="storageGiB"
            type="number"
            min="0"
            max={hostAvailableStorageGiB}
            step="1"
            bind:value={storageGiB}
            disabled={hostAvailableStorageGiB <= 0}
          />
          <p class="config-hint">Host storage: {hostStorageGiB.toLocaleString()} GiB total • {hostAvailableStorageGiB.toLocaleString()} GiB available</p>

          <div class="config-modal-actions">
            <button type="submit" class="config-ok-btn" disabled={configureSubmitInFlight || controlsDisabled}>OK</button>
            <button
              type="button"
              class="config-cancel-btn"
              disabled={configureSubmitInFlight || controlsDisabled}
              onclick={() => { showConfigureModal = false; }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  <!-- Unified notification: floating toast for config actions -->
  <ToastNotification {notify} inline={false} />
</div>