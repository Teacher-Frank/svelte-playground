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
    disabled || selectedWorkload?.status === 'deploying' || selectedWorkload?.status === 'destroyFailed' || selectedWorkload?.status === 'deployFailed'
  );

  const supportsGuiAccess = $derived(
    selectedWorkload?.type === 'vm' || containerGuiEnabled
  );

  const hasResolvedWorkloadIp = $derived(
    typeof selectedWorkload?.primaryIp === 'string' && selectedWorkload.primaryIp.trim().length > 0
  );

  // When the guest is running but the IP hasn't resolved yet, treat it as
  // "discovering" — disable all non-destructive controls until an address
  // appears. Destroy (delete) stays enabled so the user can clean up a stuck VM.
  const ipUnknownForRunningWorkload = $derived(
    selectedWorkload?.status === 'running' && !hasResolvedWorkloadIp
  );

  // Terminal is only useful when the selected guest is currently running
  // and has a resolved IP.
  const terminalEnabled = $derived(
    !controlsDisabled &&
    !ipUnknownForRunningWorkload &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  // GUI/VNC access eligibility differs by workload type:
  // - VMs use native Proxmox VNC (vncproxy) — no IP address needed, just running state.
  // - Containers use bridge mode (websockify on guest) — requires resolved IPv4.
  // In both cases, disabled while IP is unknown (discovery in progress).
  const vncEnabled = $derived(
    !controlsDisabled &&
    !ipUnknownForRunningWorkload &&
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

    if (ipUnknownForRunningWorkload) {
      return 'Waiting for IP address discovery before enabling GUI (VNC)';
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
  // stopped server-side before conversion. Disabled while IP is unknown.
  const convertToTemplateEnabled = $derived(
    !controlsDisabled &&
    !ipUnknownForRunningWorkload &&
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

  // Rename is enabled whenever a concrete workload is selected and controls aren't disabled.
  // Disabled while IP is unknown (discovery in progress).
  const renameEnabled = $derived(
    !controlsDisabled &&
    !ipUnknownForRunningWorkload &&
    (selectedWorkload?.type === 'container' || selectedWorkload?.type === 'vm') &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const renameTooltip = $derived.by(() => {
    if (selectedWorkload?.type !== 'container' && selectedWorkload?.type !== 'vm') {
      return 'Rename is only available for VM and LXC workloads';
    }
    return 'Rename workload';
  });

  // Controls visibility of the high-friction delete confirmation dialog.
  let showDeleteConfirm = $state(false);
  let destroySubmitInFlight = $state(false);
  let showRenameModal = $state(false);
  let renameSubmitInFlight = $state(false);

  // Notifications for config actions (destroy, rename, convert) are handled
  // by PxMxWorkloadList via server form response to avoid showing both toast
  // AND inline bar for the same action.

  let workloadName = $state('');

  const openRenameModal = () => {
    workloadName = selectedWorkload?.name ?? '';
    showRenameModal = true;
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

          // Notification for this action is handled by PxMxWorkloadList via server
          // form response (vm-workloads/container-workloads scope, inline bar).
          // We don't fire a notification here to avoid showing both toast AND bar.
        }

        if (result?.type === 'failure') {
          setWaitCursor(false);
          showDeleteConfirm = false;
          // Error notification handled by PxMxWorkloadList via server form response.
        }
      } finally {
        destroySubmitInFlight = false;
      }
    };
  };

  const enhanceRenameSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    renameSubmitInFlight = true;
    showRenameModal = false;

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
          // Notification handled by PxMxWorkloadList via server form response.
        }

        if (result?.type === 'failure') {
          // Error notification handled by PxMxWorkloadList via server form response.
        }
      } finally {
        renameSubmitInFlight = false;
      }
    };
  };

  $effect(() => {
    if (!controlsDisabled) {
      return;
    }
    showDeleteConfirm = false;
    showRenameModal = false;
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
    class="rename-btn"
    title={renameTooltip}
    aria-label={renameTooltip}
    disabled={!renameEnabled || renameSubmitInFlight}
    onclick={openRenameModal}
  >
    <img src="/rename.svg" alt="" aria-hidden="true" />
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

  {#if showRenameModal}
    <div class="config-modal-overlay" role="dialog" aria-modal="true" aria-labelledby="rename-modal-title">
      <div class="config-modal-box">
        <h3 id="rename-modal-title">Rename Workload</h3>
        <p class="config-modal-subtitle">
          Enter a new name for this workload. Use letters, digits, hyphens, and dots.
        </p>

        <form
          method="POST"
          action="?/renameWorkload"
          use:enhance={enhanceRenameSubmit}
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
            required
          />

          <div class="config-modal-actions">
            <button type="submit" class="config-ok-btn" disabled={renameSubmitInFlight || controlsDisabled}>OK</button>
            <button
              type="button"
              class="config-cancel-btn"
              disabled={renameSubmitInFlight || controlsDisabled}
              onclick={() => { showRenameModal = false; }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  {/if}


</div>