<script lang="ts">
  import { enhance } from '$app/forms';
  import './PxMxStyle.css';


  // LxcTemplate type describes the structure of a Proxmox LXC template as returned by the backend.
  type LxcTemplate = {
    storage: string;
    volid: string;
    format: string;
    size: number;
    content: string;
    notes?: string;
    parent?: string;
    ctime?: number;
    used?: number;
    vmid?: number;
    // ...other fields from Proxmox API
  };

  type GuestTemplate = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    template?: number | boolean;
    isTemplate?: boolean;
  };

  type UnifiedTemplateRow = {
    key: string;
    sourceType: 'storage' | 'lxc';
    templateId?: number | string;
    templateNode?: string;
    displayRef: string;
    displayName: string;
    displayLocation: string;
    displayStatusOrFormat: string;
    displaySizeMb: string;
    templateVolid?: string;
  };


  // Props: workloads is the array of LXC templates, form is for feedback messages (success/error).
  let {
    workloads,
    containerTemplates = [],
    form,
    serverNode
  }: {
    workloads: LxcTemplate[];
    containerTemplates?: GuestTemplate[];
    serverNode: string;
    form?: {
      message?: string;
      status?: 'success' | 'error';
    } | null;
  } = $props();

  // For storage-based LXC templates, just use the array as-is.
  // This allows the UI to always reflect the backend result, even if empty.
  const templates = $derived(workloads);
  const guestTemplates = $derived(containerTemplates);
  const unifiedTemplates = $derived.by<UnifiedTemplateRow[]>(() => {
    const guestRows = guestTemplates.map((guestTemplate) => ({
      key: `lxc-${guestTemplate.id ?? guestTemplate.name ?? 'unknown'}`,
      sourceType: 'lxc' as const,
      templateId: guestTemplate.id,
      templateNode: guestTemplate.node,
      displayRef: guestTemplate.id?.toString() ?? '-',
      displayName: guestTemplate.name ?? 'Unnamed template',
      displayLocation: guestTemplate.node ?? '-',
      displayStatusOrFormat: guestTemplate.status ?? '-',
      displaySizeMb: '-',
    }));

    const storageRows = templates.map((templateLxc) => ({
      key: `storage-${templateLxc.volid}`,
      sourceType: 'storage' as const,
      templateNode: serverNode,
      displayRef: templateLxc.volid,
      displayName: templateLxc.notes?.trim() || templateLxc.volid.split('/').pop() || templateLxc.volid,
      displayLocation: templateLxc.storage,
      displayStatusOrFormat: templateLxc.format,
      displaySizeMb: Math.round(templateLxc.size / (1024 * 1024)).toString(),
      templateVolid: templateLxc.volid,
    }));

    return [...guestRows, ...storageRows];
  });
  const hasUbuntu2404Template = $derived(
    templates.some((template) => /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(template.volid))
  );

  type LxcDialogAction = 'deploy-storage' | 'deploy-lxc' | 'rename-lxc';

  let templateDialog: HTMLDialogElement | null = $state(null);
  let activeTemplateRow = $state<UnifiedTemplateRow | null>(null);
  let activeAction = $state<LxcDialogAction>('deploy-storage');
  let requestedName = $state('');
  let requestedPassword = $state('');
  let lxcNameInput: HTMLInputElement | null = $state(null);
  let submitInFlight = $state(false);
  let pendingMessage = $state<string | null>(null);

  const needsRootPassword = $derived(activeAction === 'deploy-storage');

  const templateDialogTitle = $derived.by(() => {
    if (!activeTemplateRow) return '';

    const label = activeTemplateRow.displayName || activeTemplateRow.displayRef;
    if (activeAction === 'rename-lxc') {
      return `Rename ${label}`;
    }

    return `Deploy ${label}`;
  });

  const templateDialogAction = $derived.by(() => {
    if (activeAction === 'deploy-storage') return '?/cloneLxcTemplate';
    if (activeAction === 'deploy-lxc') return '?/cloneLxcGuestTemplate';
    return '?/renameLxcGuestTemplate';
  });

  const submitLabel = $derived(activeAction === 'rename-lxc' ? 'Rename' : 'Deploy');

  function openTemplateDialog(templateRow: UnifiedTemplateRow, intent: 'deploy' | 'rename'): void {
    if (intent === 'rename' && templateRow.sourceType !== 'lxc') {
      return;
    }

    activeTemplateRow = templateRow;
    activeAction = intent === 'rename'
      ? 'rename-lxc'
      : (templateRow.sourceType === 'storage' ? 'deploy-storage' : 'deploy-lxc');
    requestedName = '';
    requestedPassword = '';
    templateDialog?.showModal();

    setTimeout(() => {
      lxcNameInput?.focus();
      lxcNameInput?.select();
    }, 0);
  }

  function handleTemplateDialogClose(): void {
    activeTemplateRow = null;
    requestedName = '';
    requestedPassword = '';
  }

  const pendingSubmitMessage = (): string => {
    if (activeAction === 'rename-lxc') {
      return 'Template rename started.';
    }

    return 'Container deployment started. The task is now running.';
  };

  // Controls whether the feedback message is visible.
  let dismissed = $state(false);
  let ubuntuNoticeDismissed = $state(false);
  $effect(() => {
    // Reset dismissal when a new message arrives.
    if (form?.message) {
      dismissed = false;
      pendingMessage = null;
    }
  });

  const preserveScrollOnSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;

    return async ({ update }: { update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
    };
  };

  const enhanceTemplateDialogSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    submitInFlight = true;
    pendingMessage = pendingSubmitMessage();
    dismissed = false;
    templateDialog?.close();

    return async ({ result, update }: { result: { type?: string; data?: { message?: string } }; update: () => Promise<void> }) => {
      await update();
      window.scrollTo({ left: scrollX, top: scrollY, behavior: 'auto' });
      submitInFlight = false;

      if (result?.type === 'failure') {
        pendingMessage = null;
      }
    };
  };
</script>

<section>
  <div class="tasklist-header">
    <h2>LXC Templates</h2>
  </div>

  {#if hasUbuntu2404Template && !ubuntuNoticeDismissed}
    <p class="action-warning">
      Ubuntu 24.04 template note: Proxmox reports console and networking issues for some deployments unless the CT is created as unprivileged with nesting enabled. This app applies that workaround automatically. See IssueUbuntuTemplate.md.
      <button class="dismiss-btn" onclick={() => ubuntuNoticeDismissed = true} aria-label="Dismiss">✕</button>
    </p>
  {/if}

  {#if pendingMessage}
    <p class="action-success">
      {pendingMessage}
    </p>
  {/if}

  {#if form?.message && !dismissed}
    <!-- Show feedback message for deploy actions, dismissible by user -->
    <p class={form.status === 'error' ? 'action-error' : 'action-success'}>
      {form.message}
      <button class="dismiss-btn" onclick={() => dismissed = true} aria-label="Dismiss">✕</button>
    </p>
  {/if}

  {#if unifiedTemplates.length > 0}
    <div class="tasks-table-wrap">
      <table class="tasks-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Template</th>
            <th>Name</th>
            <th>Location</th>
            <th>Status/Format</th>
            <th>Size (MB)</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {#each unifiedTemplates as templateRow (templateRow.key)}
            <tr>
              <td>{templateRow.sourceType}</td>
              <td>{templateRow.displayRef}</td>
              <td>{templateRow.displayName}</td>
              <td>{templateRow.displayLocation}</td>
              <td>{templateRow.displayStatusOrFormat}</td>
              <td>{templateRow.displaySizeMb}</td>
              <td>
                <div class="template-actions">
                  <button
                    type="button"
                    class="deploy-btn"
                    title={templateRow.sourceType === 'storage' ? 'Deploy container from storage template' : 'Deploy container from guest template'}
                    aria-label={templateRow.sourceType === 'storage' ? 'Deploy container from storage template' : 'Deploy container from guest template'}
                    disabled={submitInFlight}
                    onclick={() => openTemplateDialog(templateRow, 'deploy')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="btn-icon">
                      <path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="rename-btn"
                    class:enabled={templateRow.sourceType === 'lxc'}
                    title={templateRow.sourceType === 'storage' ? 'Rename is not available for storage templates' : 'Rename template'}
                    aria-label={templateRow.sourceType === 'storage' ? 'Rename is not available for storage templates' : 'Rename template'}
                    disabled={templateRow.sourceType === 'storage' || submitInFlight}
                    onclick={() => openTemplateDialog(templateRow, 'rename')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="btn-icon">
                      <path d="M4 20h4l10.5-10.5a2.12 2.12 0 1 0-3-3L5.5 17v3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                </div>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <!-- Show message if no templates are found -->
    <p>No LXC templates found.</p>
  {/if}

  <dialog class="template-dialog" bind:this={templateDialog} onclose={handleTemplateDialogClose}>
    {#if activeTemplateRow}
      <form method="POST" action={templateDialogAction} class="template-dialog-form" autocomplete="off" use:enhance={enhanceTemplateDialogSubmit}>
        <div class="template-dialog-header">
          <h3>{templateDialogTitle}</h3>
          <button type="button" class="dialog-close-btn" onclick={() => templateDialog?.close()} aria-label="Close dialog" disabled={submitInFlight}>✕</button>
        </div>

        {#if activeTemplateRow.sourceType === 'storage'}
          <input type="hidden" name="templateVolid" value={activeTemplateRow.templateVolid ?? ''} />
          <input type="hidden" name="templateNode" value={activeTemplateRow.templateNode ?? serverNode} />
        {:else}
          <input type="hidden" name="templateId" value={activeTemplateRow.templateId?.toString() ?? ''} />
          <input type="hidden" name="templateNode" value={activeTemplateRow.templateNode ?? ''} />
        {/if}

        <label>
          Container name
          <input
            type="text"
            name="newName"
            placeholder="Container name"
            required
            autocomplete="off"
            class="deploy-name-input"
            bind:this={lxcNameInput}
            bind:value={requestedName}
          />
        </label>

        {#if needsRootPassword}
          <label>
            Root password
            <input
              type="password"
              name="rootPassword"
              placeholder="Root password"
              required
              autocomplete="new-password"
              minlength="12"
              pattern={String.raw`(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{12,}`}
              title="At least 12 characters with uppercase, lowercase, digit, and special character"
              class="deploy-name-input"
              bind:value={requestedPassword}
            />
          </label>
        {/if}

        <p class="dialog-hint">
          {activeAction === 'rename-lxc'
            ? 'Only the template name will be updated.'
            : 'The values are used for this deployment only.'}
        </p>

        <div class="template-dialog-actions">
          <button type="submit" class="dialog-primary-btn" disabled={submitInFlight}>{submitLabel}</button>
          <button type="button" class="cancel-btn" onclick={() => templateDialog?.close()} disabled={submitInFlight}>Cancel</button>
        </div>
      </form>
    {/if}
  </dialog>
</section>

<style>
  .template-actions {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
  }

  .deploy-name-input {
    border: 1px solid #b3b3b3;
    border-radius: 0.4rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
    width: 12rem;
  }

  .deploy-btn {
    background: #3b82f6;
    border: 1px solid #2563eb;
    border-radius: 0.4rem;
    color: #fff;
    cursor: pointer;
    font-size: 0.9rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    width: 2rem;
    height: 2rem;
  }

  .btn-icon {
    width: 1.05rem;
    height: 1.05rem;
    display: block;
  }

  .rename-btn {
    background: #fef3c7;
    border: 1px solid #f59e0b;
    border-radius: 0.4rem;
    color: #7c2d12;
    cursor: not-allowed;
    opacity: 0.55;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    width: 2rem;
    height: 2rem;
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

  .template-dialog-form label {
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

  .deploy-btn:hover {
    background: #2563eb;
  }

  .deploy-btn:active {
    transform: scale(0.97);
  }

  .action-success {
    color: #166534;
    background: #dcfce7;
    border: 1px solid #86efac;
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .action-error {
    color: #991b1b;
    background: #fee2e2;
    border: 1px solid #fca5a5;
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .action-warning {
    color: #854d0e;
    background: #fef3c7;
    border: 1px solid #fbbf24;
    border-radius: 0.4rem;
    padding: 0.4rem 0.75rem;
    margin-bottom: 0.5rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .dismiss-btn {
    background: none;
    border: none;
    cursor: pointer;
    font-size: 0.85rem;
    line-height: 1;
    opacity: 0.6;
    padding: 0;
  }

  .dismiss-btn:hover {
    opacity: 1;
  }
</style>
