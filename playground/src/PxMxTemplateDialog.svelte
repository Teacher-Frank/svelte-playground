<script lang="ts">
  import { enhance } from '$app/forms';
  import type { SubmitFunction } from '@sveltejs/kit';
  import type { Snippet } from 'svelte';

  let {
    dialog = $bindable<HTMLDialogElement | null>(null),
    active,
    title,
    action,
    submitLabel,
    submitInFlight = false,
    onDialogClose,
    onCancel,
    fields,
    hint,
    enhanceSubmit,
  }: {
    dialog?: HTMLDialogElement | null;
    active: boolean;
    title: string;
    action: string;
    submitLabel: string;
    submitInFlight?: boolean;
    onDialogClose: () => void;
    onCancel: () => void;
    fields: Snippet;
    hint?: Snippet;
    enhanceSubmit?: SubmitFunction;
  } = $props();

  // Prevent an empty dialog from getting stuck visible after active goes false
  // (e.g. from page data refresh, navigation, or reactivity timing)
  $effect(() => {
    if (!active && dialog && dialog.open) {
      dialog.close();
    }
  });
</script>

<dialog class="template-dialog" bind:this={dialog} onclose={onDialogClose}>
  {#if active}
    <form method="POST" action={action} class="template-dialog-form" autocomplete="off" use:enhance={enhanceSubmit}>
      <div class="template-dialog-header">
        <h3>{title}</h3>
        <button type="button" class="dialog-close-btn" onclick={onCancel} aria-label="Close dialog" disabled={submitInFlight}>✕</button>
      </div>

      <div class="dialog-fields">
        {@render fields()}
      </div>

      {#if hint}
        <p class="dialog-hint">{@render hint()}</p>
      {/if}

      <div class="template-dialog-actions">
        <button type="submit" class="dialog-primary-btn" disabled={submitInFlight}>{submitLabel}</button>
        <button type="button" class="cancel-btn" onclick={onCancel} disabled={submitInFlight}>Cancel</button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .template-dialog {
    border: 1px solid #cfcfcf;
    border-radius: 0.65rem;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
    max-width: 30rem;
    padding: 1rem;
    width: calc(100% - 2rem);
  }

  .template-dialog::backdrop {
    background: rgba(0, 0, 0, 0.35);
  }

  .template-dialog-form {
    display: grid;
    gap: 0.75rem;
  }

  .template-dialog-form h3 {
    margin: 0;
  }

  .template-dialog-header {
    align-items: center;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .dialog-close-btn {
    background: transparent;
    border: none;
    color: #666;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0.2rem;
  }

  .dialog-close-btn:hover {
    color: #111;
  }

  .dialog-fields :global(label) {
    color: #333;
    display: grid;
    font-size: 0.9rem;
    font-weight: 600;
    gap: 0.35rem;
  }

  .template-dialog-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }

  .dialog-primary-btn {
    background: #2563eb;
    border: 1px solid #1d4ed8;
    border-radius: 0.4rem;
    color: #fff;
    cursor: pointer;
    font-size: 0.9rem;
    font-weight: 600;
    padding: 0.45rem 0.9rem;
  }

  .dialog-primary-btn:hover {
    background: #1d4ed8;
  }

  .dialog-hint {
    color: #666;
    font-size: 0.84rem;
    margin: -0.1rem 0 0;
  }

  .cancel-btn {
    background: #f5f5f5;
    border: 1px solid #d0d0d0;
    border-radius: 0.4rem;
    color: #333;
    cursor: pointer;
    font-size: 0.9rem;
    padding: 0.45rem 0.75rem;
  }

  .cancel-btn:hover {
    background: #e9e9e9;
  }
</style>
