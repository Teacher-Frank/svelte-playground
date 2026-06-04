<script lang="ts">
  import { enhance } from '$app/forms';
  import './PxMxStyle.css';

  type Workload = {
    id?: number | string;
    name?: string;
    node?: string;
    status?: string;
    isTemplate?: boolean;
    template?: number | boolean;
  };

  let {
    workloads,
    form
  }: {
    workloads: Workload[];
    form?: {
      message?: string;
      status?: 'success' | 'error';
    } | null;
  } = $props();

  const templates = $derived(
    workloads.filter((workload) => workload.isTemplate === true || workload.template === 1 || workload.template === true)
  );

  type VmTemplateAction = 'deploy' | 'rename';

  let vmDialog: HTMLDialogElement | null = $state(null);
  let activeTemplate = $state<Workload | null>(null);
  let activeAction = $state<VmTemplateAction>('deploy');
  let requestedName = $state('');
  let vmNameInput: HTMLInputElement | null = $state(null);
  let submitInFlight = $state(false);
  let pendingMessage = $state<string | null>(null);

  const vmDialogTitle = $derived.by(() => {
    const templateName = activeTemplate?.name ?? activeTemplate?.id?.toString() ?? 'template';
    return activeAction === 'deploy'
      ? `Deploy VM from ${templateName}`
      : `Rename ${templateName}`;
  });

  const vmDialogAction = $derived(
    activeAction === 'deploy' ? '?/cloneFromTemplate' : '?/renameVmTemplate'
  );

  function openVmDialog(templateVm: Workload, action: VmTemplateAction): void {
    activeTemplate = templateVm;
    activeAction = action;
    requestedName = '';
    vmDialog?.showModal();

    setTimeout(() => {
      vmNameInput?.focus();
      vmNameInput?.select();
    }, 0);
  }

  function handleVmDialogClose(): void {
    activeTemplate = null;
    requestedName = '';
  }

  const pendingSubmitMessage = (): string =>
    activeAction === 'deploy'
      ? 'VM deployment started. The task is now running.'
      : 'Template rename started.';

  let dismissed = $state(false);
  $effect(() => {
    // Reset dismissed state whenever a new form result arrives
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

  const enhanceVmDialogSubmit = () => {
    if (typeof window === 'undefined') return;

    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    submitInFlight = true;
    pendingMessage = pendingSubmitMessage();
    dismissed = false;
    vmDialog?.close();

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
    <h2>VM Templates</h2>
  </div>

  {#if pendingMessage}
    <p class="action-success">
      {pendingMessage}
    </p>
  {/if}

  {#if form?.message && !dismissed}
    <p class={form.status === 'error' ? 'action-error' : 'action-success'}>
      {form.message}
      <button class="dismiss-btn" onclick={() => dismissed = true} aria-label="Dismiss">✕</button>
    </p>
  {/if}

  {#if templates.length > 0}
    <div class="tasks-table-wrap">
      <table class="tasks-table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Name</th>
            <th>Node</th>
            <th>Deploy</th>
          </tr>
        </thead>
        <tbody>
          {#each templates as templateVm (templateVm.id)}
            <tr>
              <td>{templateVm.id ?? '-'}</td>
              <td>{templateVm.name ?? 'Unnamed template'}</td>
              <td>{templateVm.node ?? '-'}</td>
              <td>
                <div class="template-actions">
                  <button
                    type="button"
                    class="deploy-btn"
                    title="Deploy VM from template"
                    aria-label="Deploy VM from template"
                    disabled={submitInFlight}
                    onclick={() => openVmDialog(templateVm, 'deploy')}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" class="btn-icon">
                      <path d="M5 12h14M12 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="rename-btn"
                    title="Rename template"
                    aria-label="Rename template"
                    disabled={submitInFlight}
                    onclick={() => openVmDialog(templateVm, 'rename')}
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
    <p>No VM templates found.</p>
  {/if}

  <dialog class="template-dialog" bind:this={vmDialog} onclose={handleVmDialogClose}>
    {#if activeTemplate}
      <form method="POST" action={vmDialogAction} class="template-dialog-form" autocomplete="off" use:enhance={enhanceVmDialogSubmit}>
        <div class="template-dialog-header">
          <h3>{vmDialogTitle}</h3>
          <button type="button" class="dialog-close-btn" onclick={() => vmDialog?.close()} aria-label="Close dialog" disabled={submitInFlight}>✕</button>
        </div>
        <input type="hidden" name="templateId" value={activeTemplate.id?.toString() ?? ''} />
        <input type="hidden" name="templateNode" value={activeTemplate.node ?? ''} />
        <label>
          New VM name
          <input
            bind:this={vmNameInput}
            type="text"
            name="newName"
            placeholder="New VM name"
            bind:value={requestedName}
            required
            autocomplete="off"
            class="deploy-name-input"
          />
        </label>
        <p class="dialog-hint">This name is used for {activeAction === 'deploy' ? 'the newly deployed VM.' : 'the existing template.'}</p>
        <div class="template-dialog-actions">
          <button type="submit" class="dialog-primary-btn" disabled={submitInFlight}>{activeAction === 'deploy' ? 'Deploy' : 'Rename'}</button>
          <button type="button" class="cancel-btn" onclick={() => vmDialog?.close()} disabled={submitInFlight}>Cancel</button>
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
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.35rem;
    width: 2rem;
    height: 2rem;
  }

  .rename-btn:hover {
    background: #fde68a;
    border-color: #d97706;
  }

  .rename-btn:active {
    transform: scale(0.97);
  }

  .template-dialog {
    border: 1px solid #cfcfcf;
    border-radius: 0.65rem;
    box-shadow: 0 14px 40px rgba(0, 0, 0, 0.24);
    max-width: 28rem;
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