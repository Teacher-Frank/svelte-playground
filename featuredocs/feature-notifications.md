# Notifications — Current State

**Date:** 2026-06-26
**Scope:** In-app user notification system — toasts, inline bars, scoped stores — all within `svelte-playground/playground`.

## Architecture Overview

```
Action (deploy, configure, upload, etc.)
  → component calls useToast(scope).toast() | .success() | .error() | ...
  → notification-store.svelte.ts (scoped $state + auto-dismiss)
  → ToastNotification.svelte (reactive render: floating toast or inline bar)
  → auto-dismiss / user dismiss → state clears
```

```
┌──────────────────────────────────────────────────────────────┐
│  Components (consumers)                                      │
│  PxMxWorkloadList, PxMxWorkloadControls,                     │
│  PxMxVMTemplateList, PxMxLxcTemplateList                     │
│                                                               │
│  import { useToast } from './notification-store.svelte.js'   │
│  import ToastNotification from './ToastNotification.svelte'  │
└───────────────────────────────┬──────────────────────────────┘
                                │ useToast(scope)
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  notification-store.svelte.ts (store layer)                   │
│  — 6 pre-created scopes (page, vm-templates, lxc-templates,  │
│    vm-workloads, container-workloads, config)                │
│  — 5 notification kinds (toast, pending, success, error,    │
│    warning)                                                  │
│  — per-scope $state + auto-dismiss timer                     │
│  — ONE notification visible per scope at any time            │
└───────────────────────────────┬──────────────────────────────┘
                                │ reactive notification getter
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  ToastNotification.svelte (UI layer)                         │
│  — prop: context (or notify shorthand) → ToastContext        │
│  — prop: inline (boolean) → float vs in-page render          │
│  — floating toast: fixed bottom-center, no dismiss button     │
│  — inline bar: in-flow, with dismiss button (✕)              │
└──────────────────────────────────────────────────────────────┘
```

---

## 1. Store Layer — `notification-store.svelte.ts`

~150 lines. Canonical name for the file is historically `toast-notification.ts`; the current file is `notification-store.svelte.ts`.

### 1a. Types

| Type | Values | Purpose |
|------|--------|---------|
| `NotificationKind` | `'toast' \| 'warning' \| 'success' \| 'error' \| 'pending'` | Semantic category of the notification |
| `NotificationScope` | `'page' \| 'vm-templates' \| 'lxc-templates' \| 'vm-workloads' \| 'container-workloads' \| 'config'` | Independent notification channel — each scope shows one notification at a time |

### 1b. `DisplayedNotification` Interface

```ts
interface DisplayedNotification {
  message: string;
  kind: NotificationKind;
  dismissible: boolean;   /* true for inline bars, false for toasts */
}
```

### 1c. `ToastContext` Interface

Each scope returns a `ToastContext` with these methods:

| Method | Kind Set | Auto-Dismiss | Dismissible |
|--------|----------|-------------|-------------|
| `toast(message)` | `'toast'` | 3 s | no |
| `pending(message)` | `'pending'` | never | no (until replaced) |
| `success(message)` | `'success'` | 10 s | yes |
| `error(message)` | `'error'` | never | yes |
| `warning(message)` | `'warning'` | 10 s | yes |
| `dismiss()` | — | clears timer | manual dismiss |
| `clear()` | — | immediate | programmatic clear |

Plus a reactive getter: `get notification(): DisplayedNotification | null`.

### 1d. Scope Registry

Six scopes are pre-created at module load — each maintains an independent `$state`:

| Scope | Consumer |
|-------|----------|
| `page` | `PxMxAdmin.svelte` (server-generated one-time messages) |
| `vm-templates` | `PxMxVMTemplateList.svelte` |
| `lxc-templates` | `PxMxLxcTemplateList.svelte` |
| `vm-workloads` | `PxMxWorkloadList.svelte` (kind='vm') |
| `container-workloads` | `PxMxWorkloadList.svelte` (kind='container') |
| `config` | `PxMxWorkloadControls.svelte` |

### 1e. Internal Logic — `createScope()`

Each scope is a closure over `$state` and a timer:

1. **`set(kind, message)`** — core internal function
   - If current is `'toast'` and new kind is not `'toast'` → clear immediately (inline bars replace pending toasts)
   - Always clears existing timeout before setting new state
   - Calls `scheduleAutoDismiss()` which reads `AUTO_DISMISS_MS[kind]`

2. **`scheduleAutoDismiss()`** — sets `setTimeout` based on kind's duration

3. **`AUTO_DISMISS_MS`** — hardcoded durations:
   - `toast`: 3000 ms
   - `warning`: 10 000 ms
   - `success`: 10 000 ms
   - `error`: null (stays forever until manual dismiss)
   - `pending`: null (stays until replaced by success/error)

### 1f. Access Pattern

```ts
// In any component:
import { useToast } from './notification-store.svelte.js';

const notify = useToast('config');          // get scope context
notify.toast('Starting deployment…');       // transient, 3s auto-dismiss
notify.success('Deployed successfully');    // inline, 10s auto-dismiss
notify.error('Deploy failed');              // inline, stays until dismissed
```

**Gotcha documented in `PxMxWorkloadList.svelte`:** `useToast()` returns must be stored as plain `const`, NOT `$derived`, to avoid infinite reactive loops. Calling `.success()`/`.error()` modifies the `$state` backing `.notification`, which would re-trigger an `$effect` that reads it.

---

## 2. UI Layer — `ToastNotification.svelte`

~45 lines. Single-purpose reactive renderer.

### 2a. Props

| Prop | Type | Default | Purpose |
|------|------|---------|---------|
| `context` | `ToastContext` | — | Full prop name for the toast context |
| `notify` | `ToastContext` | — | Shorthand prop name (same as `context`) |
| `inline` | `boolean` | `false` | `false` = floating toast, `true` = inline bar |

Internal: `const ctx = $derived(context ?? notify)` — supports either prop name.

### 2b. Floating Toast Mode (`inline={false}`)

- Renders a `<p role="status">` with class `notify-toast`
- Positioned `fixed` at bottom-center of viewport
- No dismiss button (auto-dismisses)
- Color-encoded: green (success/default), red (error)

### 2c. Inline Bar Mode (`inline={true}`)

- Renders a `<p role="alert">` with class `notify-bar`
- Flows inline with page layout
- Shows a dismiss button (✕) when `dismissible` is true
- Color-encoded per kind:
  - Green bg + border (success)
  - Red bg + border (error)
  - Yellow bg + border (warning)
  - Blue bg + border (pending)
- Kind-specific modifier classes applied dynamically

### 2d. Accessibility

- `role="status"` + `aria-live="polite"` for toasts (assistive tech announces without interrupting)
- `role="alert"` + `aria-live="polite"` for inline bars
- Dismiss button has `aria-label="Dismiss"`

---

## 3. Styling — `PxMxStyle.css`

Unified notification styles live in the `/* ── Unified Notification System ── */` section:

### 3a. Floating Toast (`.notify-toast`)

- Fixed position, bottom 1rem, centered horizontally
- `z-index: 1100`
- `max-width: min(90vw, 34rem)`
- White text on colored background
- Box shadow for elevation

### 3b. Inline Bar (`.notify-bar`)

- Flex layout: message left, dismiss button right
- Rounded corners, padding, border
- Four color variants: success (green), error (red), warning (yellow), pending (blue)

### 3c. Legacy Aliases

`.config-toast` classes exist as transitional aliases using `@apply notify-toast` for backward compatibility during migration to the unified system.

---

## 4. Consumers

### 4a. `PxMxWorkloadList.svelte`

- Uses TWO scopes (`vm-workloads` and `container-workloads`) selected at runtime by `kind`
- Shows inline bar (`inline={true}`)
- Fires error notifications for deploy failures via `$effect`, with deduplication via `notifiedFailureNames` Set to avoid spamming on refresh cycles

### 4b. `PxMxWorkloadControls.svelte`

- Uses `config` scope
- Shows floating toast for config actions (`inline={false}`)
- Calls `.toast()` on action start, then `.success()`/`.error()` on outcome

### 4c. `PxMxVMTemplateList.svelte`

- Uses `vm-templates` scope
- Shows inline bar (`inline={true}`)
- Fires notifications for template deploy outcomes

### 4d. `PxMxLxcTemplateList.svelte`

- Uses `lxc-templates` scope
- Shows inline bar (`inline={true}`)
- Fires notifications for LXC template deploy outcomes

### 4e. `PxMxAdmin.svelte` (Legacy Server Notifications)

- Uses `data.results.notifications` (a `string[]` from the server `load` function)
- Renders as a simple `<div role="alert">` with class `action-status success`
- NOT using the unified store — this is a legacy pattern for one-time server-generated messages (e.g., DHCP→static IP conversion confirmations)
- Candidate for future migration to the `page` scope

---

## 5. Design Rules (from POLICIES.md)

| Rule | Rationale |
|------|-----------|
| **One notification per action** — never show both toast AND inline bar for the same action | Prevents duplicate feedback confusing the user |
| **Toast** = transient "task started" → auto-dismisses 3s | Quick acknowledgment, no clutter |
| **Pending** = long-running "work in progress" → stays until replaced | Visible progress for async server calls |
| **Success** = final outcome → auto-dismisses 10s | Confirmation that fades away |
| **Error** = final outcome → stays until manual dismiss | User must acknowledge and read |
| **Warning** = advisory → dismissible, auto-dismisses 10s | Info that should be seen but isn't blocking |
| When inline bar arrives, any pending toast for same scope is cleared | Prevents toast+bar pairing |
| Use unified store and `ToastNotification.svelte` — no ad-hoc `<p>` elements | Consistency, accessibility, single source of auto-dismiss logic |

---

## 6. Known Gaps and Future Work

- **`PxMxAdmin.svelte` server notifications** still use legacy ad-hoc `<div>` rendering instead of the unified `page` scope store.
- **No notification queue** — if two actions fire in the same scope within the auto-dismiss window, the second overwrites the first.
- **No sound or browser notification** — all feedback is visual within the app viewport.
- **Legacy `.config-toast` CSS aliases** remain for transitional compatibility.

---

## 7. Applicable Policies (from POLICIES.md)

> The following are verbatim excerpts from `svelte-playground/POLICIES.md`, the authoritative policy source.

### Notification System (dedicated section)

- **One notification per action** — never show both a toast AND an inline bar for the same action.
- **Toast** (floating bottom): transient "work-in-progress" or "task started" feedback → auto-dismisses after 3–5 seconds.
- **Inline bar** (in-page, above the relevant section): final outcome → success auto-dismisses after 10s, errors stay until manually dismissed.
- When an inline bar arrives (e.g., server response), any pending toast for the same action MUST be cleared.
- Use the unified `toast-notification.ts` store and `ToastNotification.svelte` — do not create ad-hoc notification elements.
- Shared auto-dismiss logic lives in `toast-notification.ts`, never duplicated per component.

### P2b: Consistent Patterns

- When a problem has a confirmed unified solution, apply it everywhere it's needed.
- Never leave ad-hoc or legacy patterns alongside the canonical one — consolidate them.
- **Example:** if a shared notification system replaces scattered `<p>` elements, refactor all consumers to use it.

### P2: Quality and Refactoring — extract shared code

- Extract shared or utility code to dedicated modules — don't let architectural complexity block safe extractions.
- *(Rationale for this feature: auto-dismiss logic, state management, and timer handling all live in one module rather than being duplicated per component.)*

### P4b: Error Messages

- Wrong/rejected values: always include the actual value in the error message so the caller can identify it.
- Missing/empty errors don't need a value.
- Sensitive values (passwords, tokens, secrets) must never appear in error messages.
- *(Applies to notification `.error()` messages shown to users — include the failed action/ID for context, never credentials.)*
