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

  // Conversion applies to any selected LXC container; running ones are stopped
  // server-side before conversion.
  const convertToTemplateEnabled = $derived(
    !disabled &&
    selectedWorkload?.type === 'container' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  const convertToTemplateTooltip = $derived(
    selectedWorkload?.status === 'running'
      ? 'Stop and convert to template'
      : 'Convert to template'
  );

  // Controls visibility of the high-friction delete confirmation dialog.
  let showDeleteConfirm = $state(false);

  const preserveScrollOnSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
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

  {#if selectedWorkload?.type === 'container'}
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
  {/if}

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
    <div class="delete-confirm-overlay" role="alertdialog" aria-modal="true" aria-labelledby="delete-confirm-title">
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
          <form method="POST" action="?/destroy" use:enhance={preserveScrollOnSubmit}>
            <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
            <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
            <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
            <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />
            <button type="submit" class="delete-confirm-yes">YES, DESTROY IT!!!</button>
          </form>
          <button type="button" class="delete-confirm-cancel" onclick={() => { showDeleteConfirm = false; }}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</div>