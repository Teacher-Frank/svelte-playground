/**
 * Unified notification system (toast-notification.ts is the canonical name).
 *
 * Rules (per POLICIES.md):
 * - One notification per action — never both toast AND inline bar.
 * - Toast (floating): transient "work-in-progress" → auto-dismisses after 3s.
 * - Pending (inline bar): long-running "work-in-progress" → stays until success/error replaces it.
 * - Inline bar (success/error/warning): final outcome → success 10s, error stays until manual dismiss.
 * - When an inline bar arrives, any pending toast for the same scope is cleared.
 * - Do not create ad-hoc notification elements in components.
 */

export type NotificationKind = 'toast' | 'warning' | 'success' | 'error' | 'pending';
export type NotificationScope = 'page' | 'vm-templates' | 'lxc-templates' | 'vm-workloads' | 'container-workloads' | 'config';

/** What the ToastNotification.svelte component reads. */
export interface DisplayedNotification {
  message: string;
  kind: NotificationKind;
  dismissible: boolean;
}

/** Per-scope notification context. Call `useToast(scope)` from any component. */
export interface ToastContext {
  /** Current notification, or null. Reactive — safe to use in component $effect / template. */
  get notification(): DisplayedNotification | null;

  /** User dismissed the notification. */
  dismiss(): void;

  /** Immediately clear without timeout. */
  clear(): void;

  /** Transient "task started" toast → auto-dismisses after 3s. */
  toast(message: string): void;

  /** Inline pending bar → stays until replaced by success/error (no auto-dismiss). */
  pending(message: string): void;

  /** Inline success bar → auto-dismisses after 10s. */
  success(message: string): void;

  /** Inline error bar → stays until user dismisses. */
  error(message: string): void;

  /** Inline warning bar → dismissible, auto-dismisses after 10s. */
  warning(message: string): void;
}

// Auto-dismiss durations per kind (null = no auto-dismiss)
const AUTO_DISMISS_MS: Record<NotificationKind, number | null> = {
  toast: 3000,
  warning: 10000,
  success: 10000,
  error: null,
  pending: null,
};

function createScope(): ToastContext {
  let current: DisplayedNotification | null = $state(null);
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function clearTimeout_() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function scheduleAutoDismiss() {
    clearTimeout_();
    if (!current) return;
    const ms = AUTO_DISMISS_MS[current.kind];
    if (ms === null) return;

    timeoutId = setTimeout(() => {
      current = null;
      timeoutId = null;
    }, ms);
  }

  function set(kind: NotificationKind, message: string) {
    // Rule: replacing a toast with inline notification clears immediately
    if (current?.kind === 'toast' && kind !== 'toast') {
      clearTimeout_();
      current = null;
    }

    // If setting same kind, also clear previous timeout
    clearTimeout_();

    current = {
      message,
      kind,
      dismissible: kind !== 'toast',
    };
    scheduleAutoDismiss();
  }

  return {
    get notification(): DisplayedNotification | null {
      return current;
    },

    dismiss() {
      if (current && current.dismissible) {
        clearTimeout_();
        current = null;
      }
    },

    clear() {
      clearTimeout_();
      current = null;
    },

    toast(message: string) {
      set('toast', message);
    },

    pending(message: string) {
      set('pending', message);
    },

    success(message: string) {
      set('success', message);
    },

    error(message: string) {
      set('error', message);
    },

    warning(message: string) {
      set('warning', message);
    },
  };
}

// Pre-create all scopes — each maintains independent $state for reactivity
const scopes: Record<NotificationScope, ToastContext> = {
  page: createScope(),
  'vm-templates': createScope(),
  'lxc-templates': createScope(),
  'vm-workloads': createScope(),
  'container-workloads': createScope(),
  config: createScope(),
};

/**
 * Get the notification context for a given scope.
 * Components import this and pass the scope name.
 */
export function useToast(scope: NotificationScope): ToastContext {
  return scopes[scope];
}