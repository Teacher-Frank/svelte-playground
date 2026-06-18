<script lang="ts">
  import './PxMxStyle.css';
  import { useToast } from './notification-store.js';
  import { createOptimisticDialogEnhance, focusAndSelectInput } from './templateDialogEnhance.js';
  import type { EnhanceResult } from './templateDialogEnhance.js';
  import PxMxTemplateTable from './PxMxTemplateTable.svelte';
  import PxMxTemplateDialog from './PxMxTemplateDialog.svelte';
  import ToastNotification from './ToastNotification.svelte';


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
    displayFormat: string;
    displaySizeMb: string;
    templateVolid?: string;
  };


  // Props: workloads is the array of LXC templates, form is for feedback messages (success/error).
  let {
    workloads,
    containerTemplates = [],
    form,
    serverNode,
    onDeployStarted,
    onDeployFailed,
  }: {
    workloads: LxcTemplate[];
    containerTemplates?: GuestTemplate[];
    serverNode: string;
    form?: {
      message?: string;
      status?: 'success' | 'error';
    } | null;
    onDeployStarted?: (payload: { name: string; node?: string; taskUpids?: string[] }) => void;
    onDeployFailed?: (payload: { name: string; node?: string }) => void;
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
      displayFormat: '-',
      displaySizeMb: '-',
    }));

    const storageRows = templates.map((templateLxc) => ({
      key: `storage-${templateLxc.volid}`,
      sourceType: 'storage' as const,
      templateNode: serverNode,
      displayRef: templateLxc.volid,
      displayName: templateLxc.notes?.trim() || templateLxc.volid.split('/').pop() || templateLxc.volid,
      displayLocation: templateLxc.storage,
      displayFormat: templateLxc.format,
      displaySizeMb: Math.round(templateLxc.size / (1024 * 1024)).toString(),
      templateVolid: templateLxc.volid,
    }));

    return [...guestRows, ...storageRows];
  });
  const hasUbuntu2404Template = $derived(
    templates.some((template) => /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(template.volid))
  );

  const templateTableHeaders = ['Type', 'Template', 'Name', 'Location', 'Format', 'Size (MB)', 'Actions'];

  const templateTableRows = $derived(
    unifiedTemplates.map((templateRow) => ({
      key: templateRow.key,
      cells: [
        templateRow.sourceType,
        templateRow.displayRef,
        templateRow.displayName,
        templateRow.displayLocation,
        templateRow.displayFormat,
        templateRow.displaySizeMb,
      ],
      deployTitle: templateRow.sourceType === 'storage'
        ? 'Deploy container from storage template'
        : 'Deploy container from guest template',
      deployLabel: templateRow.sourceType === 'storage'
        ? 'Deploy container from storage template'
        : 'Deploy container from guest template',
      renameTitle: templateRow.sourceType === 'storage'
        ? 'Rename is not available for storage templates'
        : 'Rename template',
      renameLabel: templateRow.sourceType === 'storage'
        ? 'Rename is not available for storage templates'
        : 'Rename template',
      renameEnabled: templateRow.sourceType === 'lxc',
      onDeploy: () => openTemplateDialog(templateRow, 'deploy'),
      onRename: () => openTemplateDialog(templateRow, 'rename'),
    }))
  );

  type LxcDialogAction = 'deploy-storage' | 'deploy-lxc' | 'rename-lxc';

  let templateDialog: HTMLDialogElement | null = $state(null);
  let activeTemplateRow = $state<UnifiedTemplateRow | null>(null);
  let activeAction = $state<LxcDialogAction>('deploy-storage');
  let requestedName = $state('');
  let requestedPassword = $state('');
  let lxcNameInput: HTMLInputElement | null = $state(null);
  let submitInFlight = $state(false);
  let pendingDeployContext = $state<{ name: string; node?: string } | null>(null);

  // Unified notification — replaces pendingMessage, dismissed, timeout logic
  const notify = useToast('lxc-templates');

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
    focusAndSelectInput(lxcNameInput);
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

  // React to form results from server: move them into the unified notification
  $effect(() => {
    if (!form?.message) return;
    if (form.status === 'error') {
      notify.error(form.message);
    } else {
      notify.success(form.message);
    }
  });

  const enhanceTemplateDialogSubmit = () => {
    return createOptimisticDialogEnhance({
      closeDialog: () => {
        templateDialog?.close();
      },
      onSubmitStart: () => {
        submitInFlight = true;
        notify.toast(pendingSubmitMessage());
        if (activeAction === 'deploy-storage' || activeAction === 'deploy-lxc') {
          const payload = {
            name: requestedName.trim(),
            node: activeTemplateRow?.templateNode ?? serverNode,
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
        if (result?.type === 'failure' && pendingDeployContext) {
          onDeployFailed?.(pendingDeployContext);
        }
        pendingDeployContext = null;
      },
    });
  };
</script>

<section>
  <div class="tasklist-header">
    <h2>LXC Templates</h2>
  </div>

  <!-- Unified notification: inline bar for final result, toast for task started -->
  <ToastNotification {notify} inline={true} />

  {#if unifiedTemplates.length > 0}
    <PxMxTemplateTable
      headers={templateTableHeaders}
      rows={templateTableRows}
      submitInFlight={submitInFlight}
    />
  {:else}
    <!-- Show message if no templates are found -->
    <p>No LXC templates found.</p>
  {/if}

  <PxMxTemplateDialog
    bind:dialog={templateDialog}
    active={Boolean(activeTemplateRow)}
    title={templateDialogTitle}
    action={templateDialogAction}
    submitLabel={submitLabel}
    submitInFlight={submitInFlight}
    onDialogClose={handleTemplateDialogClose}
    onCancel={() => templateDialog?.close()}
    enhanceSubmit={enhanceTemplateDialogSubmit}
  >
    {#snippet fields()}
      {#if activeTemplateRow?.sourceType === 'storage'}
        <input type="hidden" name="templateVolid" value={activeTemplateRow.templateVolid ?? ''} />
        <input type="hidden" name="templateNode" value={activeTemplateRow.templateNode ?? serverNode} />
      {:else}
        <input type="hidden" name="templateId" value={activeTemplateRow?.templateId?.toString() ?? ''} />
        <input type="hidden" name="templateNode" value={activeTemplateRow?.templateNode ?? ''} />
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
    {/snippet}
    {#snippet hint()}
      {activeAction === 'rename-lxc'
        ? 'Only the template name will be updated.'
        : 'The values are used for this deployment only.'}
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
</style>
