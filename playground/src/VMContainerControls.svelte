<script lang="ts">
  type ActionHandler = () => void;

  let {
    onStart = () => {},
    onStop = () => {},
    onRestart = () => {},
  }: {
    onStart?: ActionHandler;
    onStop?: ActionHandler;
    onRestart?: ActionHandler;
  } = $props();
</script>

<div class="controls">
  <button onclick={onStart} title="Start" aria-label="Start">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 5v14l11-7z" />
    </svg>
  </button>

  <button onclick={onStop} title="Stop" aria-label="Stop">
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M6 4h12v16H6z" />
    </svg>
  </button>

  <button onclick={onRestart} title="Restart" aria-label="Restart">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 2v6h-6" />
      <path d="M3 11a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 13a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  </button>
</div>

<style>
  .controls {
    display: flex;
    gap: 0.5rem;
  }

  button {
    background: none;
    border: 1px solid #ccc;
    border-radius: 4px;
    cursor: pointer;
    padding: 0.5rem;
    width: 2.5rem;
    height: 2.5rem;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #666;
    transition: all 0.2s;
  }

  button:hover {
    border-color: #999;
    color: #333;
    background-color: #f5f5f5;
  }

  button:active {
    transform: scale(0.95);
  }

  svg {
    width: 1.25rem;
    height: 1.25rem;
  }
</style>