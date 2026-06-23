<script lang="ts">
  import type { ToastContext } from './notification-store.svelte.js';

  let {
    context,
    notify,
    inline = false,
  }: {
    /** The toast context obtained from useToast() — prop: context */
    context?: ToastContext;
    /** The toast context obtained from useToast() — shorthand prop: notify */
    notify?: ToastContext;
    /** When true, render as inline bar in-page. When false, render as floating toast. */
    inline?: boolean;
  } = $props();

  const ctx = $derived(context ?? notify) as ToastContext;
</script>

{#if ctx.notification}
  {#if inline}
    <p
      role="alert"
      aria-live="polite"
      class="notify-bar"
      class:warning={ctx.notification.kind === 'warning'}
      class:success={ctx.notification.kind === 'success'}
      class:error={ctx.notification.kind === 'error'}
      class:pending={ctx.notification.kind === 'pending'}
    >
      <span>{ctx.notification.message}</span>
      {#if ctx.notification.dismissible}
        <button class="dismiss-btn" onclick={() => ctx.dismiss()} aria-label="Dismiss">✕</button>
      {/if}
    </p>
  {:else}
    <p
      role="status"
      aria-live="polite"
      class="notify-toast"
      class:success={ctx.notification.kind === 'success'}
      class:error={ctx.notification.kind === 'error'}
      class:pending={ctx.notification.kind === 'pending'}
    >
      {ctx.notification.message}
    </p>
  {/if}
{/if}
