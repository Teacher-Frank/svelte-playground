<script lang="ts">
  import './PxMxStyle.css';

  type SelectedWorkload = {
    type: 'vm' | 'container';
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
  };

  let {
    disabled = false,
    selectedLabel = 'No workload selected',
    selectedWorkload = null,
    compact = false,
  }: {
    disabled?: boolean;
    selectedLabel?: string;
    selectedWorkload?: SelectedWorkload | null;
    compact?: boolean;
  } = $props();

  // Terminal is only useful when the selected guest is currently running.
  const terminalEnabled = $derived(
    !disabled &&
    selectedWorkload?.status === 'running' &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  // Destructive actions are allowed whenever a concrete workload is selected.
  const deleteEnabled = $derived(
    !disabled &&
    selectedWorkload?.id != null &&
    selectedWorkload?.node != null
  );

  // Controls visibility of the high-friction delete confirmation dialog.
  let showDeleteConfirm = $state(false);
</script>

<div class="workload-controls" class:compact>
  {#if !compact}
    <div class="selected-target">{selectedLabel}</div>
  {/if}

  <!-- Shared payload for start/stop/restart form actions. -->
  <form class="action-buttons" method="POST">
    <input name="type" type="hidden" value={selectedWorkload?.type ?? ''} />
    <input name="id" type="hidden" value={selectedWorkload?.id?.toString() ?? ''} />
    <input name="name" type="hidden" value={selectedWorkload?.name ?? ''} />
    <input name="node" type="hidden" value={selectedWorkload?.node ?? ''} />

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
      ? `/proxmox/terminal?vmid=${encodeURIComponent(selectedWorkload!.id!)}&node=${encodeURIComponent(selectedWorkload!.node!)}&type=${encodeURIComponent(selectedWorkload!.type)}`
      : undefined}
    title="Open terminal"
    aria-label="Open terminal"
    aria-disabled={!terminalEnabled}
    tabindex={terminalEnabled ? 0 : -1}
  >
    <img src="/terminal.svg" alt="" aria-hidden="true" />
  </a>

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
          <form method="POST" action="?/destroy">
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