<script lang="ts">
  type SelectedWorkload = {
    type: 'vm' | 'container';
    id?: number | string;
    name?: string;
    node?: string;
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
</script>

<div class="controls" class:compact>
  {#if !compact}
    <div class="selected-target">{selectedLabel}</div>
  {/if}

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
</div>

<style>
  .controls {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    background: #d7d7d7;
    border: 1px solid #b8b8b8;
    border-radius: 0.9rem;
    padding: 0.35rem;
    width: fit-content;
  }

  .selected-target {
    color: #2f2f2f;
    font-size: 0.95rem;
    margin: 0 0.65rem 0 0.4rem;
    min-width: 14rem;
  }

  .action-buttons {
    display: flex;
    gap: 0.25rem;
    margin: 0;
  }

  button {
    background: #efefef;
    border: 1px solid #b3b3b3;
    border-radius: 0.7rem;
    cursor: pointer;
    padding: 0.5rem;
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  button:hover {
    border-color: #888;
    background-color: #fafafa;
  }

  button:active {
    transform: scale(0.95);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  img {
    width: 1.25rem;
    height: 1.25rem;
    display: block;
  }

  .controls.compact {
    border-radius: 0.7rem;
    padding: 0.2rem;
  }

  .controls.compact button {
    height: 2.1rem;
    padding: 0.35rem;
    width: 2.1rem;
  }

  .controls.compact img {
    height: 1rem;
    width: 1rem;
  }
</style>