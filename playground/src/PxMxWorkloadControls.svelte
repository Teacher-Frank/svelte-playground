<script lang="ts">
  import { enhance } from '$app/forms';
  import './PxMxStyle.css';

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

  // Terminal is only useful when the selected guest is currently running.
  const terminalEnabled = $derived(
    !disabled &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const supportsGuiAccess = $derived(
    selectedWorkload?.type === 'vm' || containerGuiEnabled
  );

  const hasResolvedContainerIp = $derived(
    selectedWorkload?.type !== 'container' ||
    (typeof selectedWorkload?.primaryIp === 'string' && selectedWorkload.primaryIp.trim().length > 0)
  );

  // GUI/VNC access is only shown as active when the selected workload is
  // running and the backend can provide a real GUI bridge for that type.
  const vncEnabled = $derived(
    !disabled &&
    supportsGuiAccess &&
    hasResolvedContainerIp &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const vncTooltip = $derived.by(() => {
    if (selectedWorkload?.type === 'container' && !containerGuiEnabled) {
      return 'GUI is not available for containers without an LXC VNC bridge';
    }

    if (selectedWorkload?.type === 'container' && !hasResolvedContainerIp) {
      return 'Waiting for container IPv4 address before enabling GUI (VNC)';
    }

    return 'Open GUI (VNC)';
  });

  // Destructive actions are allowed whenever a concrete workload is selected.
  const deleteEnabled = $derived(
    !disabled &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  // Conversion applies to any selected VM/container; running workloads are
  // stopped server-side before conversion.
  const convertToTemplateEnabled = $derived(
    !disabled &&
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
    !disabled &&
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
      ? 'Configure VM CPU cores and memory'
      : 'Configure container CPU and memory';
  });

  // Controls visibility of the high-friction delete confirmation dialog.
  let showDeleteConfirm = $state(false);
  let destroySubmitInFlight = $state(false);
  let showConfigureModal = $state(false);
  let configureSubmitInFlight = $state(false);
  let configToast = $state<{ kind: 'success' | 'error'; message: string } | null>(null);
  let configToastTimeout: ReturnType<typeof setTimeout> | null = null;

  let cpuSharePercent = $state(25);
  let memoryMiB = $state(1024);

  const openConfigureModal = () => {
    cpuSharePercent = defaultCpuSharePercent;
    memoryMiB = defaultMemoryMiB;
    showConfigureModal = true;
  };

  const showConfigToast = (kind: 'success' | 'error', message: string) => {
    configToast = { kind, message };
    if (configToastTimeout) {
      clearTimeout(configToastTimeout);
    }
    configToastTimeout = setTimeout(() => {
      configToast = null;
      configToastTimeout = null;
    }, 2500);
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

    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
      closeDeleteConfirm();
    };
  };

  const enhanceConfigureSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    configureSubmitInFlight = true;
    showConfigureModal = false;
    showConfigToast('success', 'Configuration update started. The task is now running.');

    return async ({ result, update }: { result: { type?: string; data?: { message?: string } }; update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
      configureSubmitInFlight = false;

      if (result?.type === 'success') {
        showConfigToast('success', result.data?.message ?? 'Container configuration updated.');
        return;
      }

      if (result?.type === 'failure') {
        showConfigToast('error', result.data?.message ?? 'Failed to update container configuration.');
      }
    };
  };
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

    <button formaction="?/start" title="Start" aria-label="Start" disabled={disabled}>
      <img src="/play.svg" alt="" aria-hidden="true" />
    </button>

    <button formaction="?/stop" title="Stop" aria-label="Stop" disabled={disabled}>
      <img src="/stop.svg" alt="" aria-hidden="true" />
    </button>

    <button formaction="?/restart" title="Restart" aria-label="Restart" disabled={disabled}>
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
      ? `/proxmox/vnc?vmid=${encodeURIComponent(selectedWorkload!.id!)}&node=${encodeURIComponent(selectedWorkload!.node!)}&type=${encodeURIComponent(selectedWorkload!.type)}${selectedWorkload!.name ? `&name=${encodeURIComponent(selectedWorkload!.name)}` : ''}${selectedWorkload!.type === 'container' && selectedWorkload!.primaryIp ? `&ip=${encodeURIComponent(selectedWorkload!.primaryIp)}` : ''}`
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
            <button type="submit" class="delete-confirm-yes" disabled={destroySubmitInFlight}>
              {destroySubmitInFlight ? 'DESTROYING...' : 'YES, DESTROY IT!!!'}
            </button>
          </form>
          <button
            type="button"
            class="delete-confirm-cancel"
            disabled={destroySubmitInFlight}
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
          Set required CPU share and memory. Maximum allowed is 75% of the host.
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

          <div class="config-modal-actions">
            <button type="submit" class="config-ok-btn" disabled={configureSubmitInFlight}>OK</button>
            <button
              type="button"
              class="config-cancel-btn"
              disabled={configureSubmitInFlight}
              onclick={() => { showConfigureModal = false; }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}

  {#if configToast}
    <p class="config-toast" class:success={configToast.kind === 'success'} class:error={configToast.kind === 'error'}>
      {configToast.message}
    </p>
  {/if}
</div>