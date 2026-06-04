<script lang="ts">
  let {
    deployTitle,
    deployLabel,
    renameTitle,
    renameLabel,
    renameEnabled = true,
    submitInFlight = false,
    onDeploy,
    onRename,
  }: {
    deployTitle: string;
    deployLabel: string;
    renameTitle: string;
    renameLabel: string;
    renameEnabled?: boolean;
    submitInFlight?: boolean;
    onDeploy: () => void;
    onRename: () => void;
  } = $props();
</script>

<div class="template-actions">
  <button
    type="button"
    class="deploy-btn"
    title={deployTitle}
    aria-label={deployLabel}
    disabled={submitInFlight}
    onclick={onDeploy}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="btn-icon">
      <path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <button
    type="button"
    class="rename-btn"
    class:enabled={renameEnabled}
    title={renameTitle}
    aria-label={renameLabel}
    disabled={!renameEnabled || submitInFlight}
    onclick={onRename}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="btn-icon">
      <path d="M4 20h4l10.5-10.5a2.12 2.12 0 1 0-3-3L5.5 17v3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
</div>

<style>
  .template-actions {
    align-items: center;
    display: inline-flex;
    gap: 0.35rem;
  }

  .deploy-btn {
    align-items: center;
    background: #3b82f6;
    border: 1px solid #2563eb;
    border-radius: 0.4rem;
    color: #fff;
    cursor: pointer;
    display: inline-flex;
    font-size: 0.9rem;
    height: 2rem;
    justify-content: center;
    padding: 0.35rem;
    width: 2rem;
  }

  .deploy-btn:hover {
    background: #1d4ed8;
    border-color: #1e40af;
  }

  .deploy-btn:active {
    transform: scale(0.97);
  }

  .btn-icon {
    display: block;
    height: 1.05rem;
    width: 1.05rem;
  }

  .rename-btn {
    align-items: center;
    background: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 0.4rem;
    color: #7c2d12;
    cursor: pointer;
    display: inline-flex;
    height: 2rem;
    justify-content: center;
    opacity: 0.7;
    padding: 0.35rem;
    width: 2rem;
  }

  .rename-btn.enabled {
    cursor: pointer;
    opacity: 1;
  }

  .rename-btn.enabled:hover {
    background: #fde68a;
    border-color: #d97706;
  }

  .rename-btn.enabled:active {
    transform: scale(0.97);
  }

  .rename-btn:disabled {
    cursor: not-allowed;
    opacity: 0.35;
  }
</style>
