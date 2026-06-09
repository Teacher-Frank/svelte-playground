<script lang="ts">
  import './PxMxStyle.css';
  import { createOptimisticDialogEnhance, focusAndSelectInput } from './templateDialogEnhance.js';
  import type { EnhanceResult } from './templateDialogEnhance.js';
  import PxMxTemplateTable from './PxMxTemplateTable.svelte';
  import PxMxTemplateDialog from './PxMxTemplateDialog.svelte';

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
    form,
    onDeployStarted,
    onDeployFailed,
  }: {
    workloads: Workload[];
    form?: {
      message?: string;
      status?: 'success' | 'error';
    } | null;
    onDeployStarted?: (payload: { name: string; node?: string; taskUpids?: string[] }) => void;
    onDeployFailed?: (payload: { name: string; node?: string }) => void;
  } = $props();

  const templates = $derived(
    workloads.filter((workload) => workload.isTemplate === true || workload.template === 1 || workload.template === true)
  );

  const templateTableHeaders = ['ID', 'Name', 'Node', 'Deploy'];

  const templateTableRows = $derived(
    templates.map((templateVm, index) => ({
      key: `vm-template-${templateVm.id ?? templateVm.name ?? index}`,
      cells: [
        templateVm.id?.toString() ?? '-',
        templateVm.name ?? 'Unnamed template',
        templateVm.node ?? '-',
      ],
      deployTitle: 'Deploy VM from template',
      deployLabel: 'Deploy VM from template',
      renameTitle: 'Rename template',
      renameLabel: 'Rename template',
      renameEnabled: true,
      onDeploy: () => openVmDialog(templateVm, 'deploy'),
      onRename: () => openVmDialog(templateVm, 'rename'),
    }))
  );

  type VmTemplateAction = 'deploy' | 'rename';

  let vmDialog: HTMLDialogElement | null = $state(null);
  let activeTemplate = $state<Workload | null>(null);
  let activeAction = $state<VmTemplateAction>('deploy');
  let requestedName = $state('');
  let ciUser = $state('');
  let ciPassword = $state('');
  let vmNameInput: HTMLInputElement | null = $state(null);
  let submitInFlight = $state(false);
  let pendingMessage = $state<string | null>(null);
  let pendingDeployContext = $state<{ name: string; node?: string } | null>(null);

  const vmDialogTitle = $derived.by(() => {
    const templateName = activeTemplate?.name ?? activeTemplate?.id?.toString() ?? 'template';
    return activeAction === 'deploy'
      ? `Deploy VM from ${templateName}`
      : `Rename ${templateName}`;
  });
  const vmDialogSubmitLabel = $derived(activeAction === 'deploy' ? 'Deploy' : 'Rename');


  const vmDialogAction = $derived(
    activeAction === 'deploy' ? '?/cloneFromTemplate' : '?/renameVmTemplate'
  );

  function openVmDialog(templateVm: Workload, action: VmTemplateAction): void {
    activeTemplate = templateVm;
    activeAction = action;
    requestedName = '';
    ciUser = '';
    ciPassword = '';
    vmDialog?.showModal();
    focusAndSelectInput(vmNameInput);
  }

  function handleVmDialogClose(): void {
    activeTemplate = null;
    requestedName = '';
    ciUser = '';
    ciPassword = '';
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

  const enhanceVmDialogSubmit = () => {
    return createOptimisticDialogEnhance({
      closeDialog: () => {
        vmDialog?.close();
      },
      onSubmitStart: () => {
        submitInFlight = true;
        pendingMessage = pendingSubmitMessage();
        dismissed = false;
        if (activeAction === 'deploy') {
          const payload = {
            name: requestedName.trim(),
            node: activeTemplate?.node,
          };
          pendingDeployContext = payload;
          onDeployStarted?.(payload);
        } else {
          pendingDeployContext = null;
        }
      },
      onSubmitEnd: (result: EnhanceResult | undefined) => {
        submitInFlight = false;
        if (result?.type === 'success' && pendingDeployContext) {
          const upids = Array.isArray(result.data?.deployTaskUpids)
            ? result.data?.deployTaskUpids.filter((upid): upid is string => typeof upid === 'string' && upid.trim().length > 0)
            : [];
          onDeployStarted?.({
            name: result.data?.deployWorkloadName?.trim() || pendingDeployContext.name,
            node: result.data?.deployTaskNode?.trim() || pendingDeployContext.node,
            taskUpids: upids,
          });
        }
        if (result?.type === 'failure') {
          pendingMessage = null;
          if (pendingDeployContext) {
            onDeployFailed?.(pendingDeployContext);
          }
        }
        pendingDeployContext = null;
      },
    });
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
    <PxMxTemplateTable
      headers={templateTableHeaders}
      rows={templateTableRows}
      submitInFlight={submitInFlight}
    />
  {:else}
    <p>No VM templates found.</p>
  {/if}

  <PxMxTemplateDialog
    bind:dialog={vmDialog}
    active={Boolean(activeTemplate)}
    title={vmDialogTitle}
    action={vmDialogAction}
    submitLabel={vmDialogSubmitLabel}
    submitInFlight={submitInFlight}
    onDialogClose={handleVmDialogClose}
    onCancel={() => vmDialog?.close()}
    enhanceSubmit={enhanceVmDialogSubmit}
  >
    {#snippet fields()}
      <input type="hidden" name="templateId" value={activeTemplate?.id?.toString() ?? ''} />
      <input type="hidden" name="templateNode" value={activeTemplate?.node ?? ''} />
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
      {#if activeAction === 'deploy'}
        <label>
          Username
          <input
            type="text"
            name="ciUser"
            placeholder="e.g. ubuntu, debian"
            bind:value={ciUser}
            required
            autocomplete="off"
            class="deploy-name-input"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            name="ciPassword"
            placeholder="Cloud-init password"
            required
            autocomplete="new-password"
            minlength="12"
            pattern={String.raw`(?=.*[A-Z])(?=.*[a-z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{12,}`}
            title="At least 12 characters with uppercase, lowercase, digit, and special character"
            class="deploy-name-input"
            bind:value={ciPassword}
          />
        </label>
      {/if}
    {/snippet}
    {#snippet hint()}
      {activeAction === 'deploy'
        ? 'Name, username, and password are used for this deployment only.'
        : 'Only the template name will be updated.'}
    {/snippet}
  </PxMxTemplateDialog>
</section>

<style>
  .deploy-name-input {
    border: 1px solid #b3b3b3;
    border-radius: 0.4rem;
    padding: 0.25rem 0.5rem;
    font-size: 0.9rem;
    width: 12rem;
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