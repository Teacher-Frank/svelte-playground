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


  // Props: workloads is the array of LXC templates, form is for feedback messages (success/error).
  let {
    workloads,
    form,
    serverNode
  }: {
    workloads: LxcTemplate[];
    serverNode: string;
    form?: {
      message?: string;
      status?: 'success' | 'error';
    } | null;
  } = $props();

  // For storage-based LXC templates, just use the array as-is.
  // This allows the UI to always reflect the backend result, even if empty.
  const templates = $derived(workloads);
  const hasUbuntu2404Template = $derived(
    templates.some((template) => /(?:^|:)vztmpl\/ubuntu-24\.04-standard_/i.test(template.volid))
  );

  // Controls whether the feedback message is visible.
  let dismissed = $state(false);
  let ubuntuNoticeDismissed = $state(false);
  $effect(() => {
    // Reset dismissal when a new message arrives.
    if (form?.message) dismissed = false;
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

  {#if form?.message && !dismissed}
    <!-- Show feedback message for deploy actions, dismissible by user -->
    <p class={form.status === 'error' ? 'action-error' : 'action-success'}>
      {form.message}
      <button class="dismiss-btn" onclick={() => dismissed = true} aria-label="Dismiss">✕</button>
    </p>
  {/if}

  {#if templates.length > 0}
    <!-- Render table of LXC templates if any are available -->
    <div class="tasks-table-wrap">
      <table class="tasks-table">
        <thead>
          <tr>
            <th>Volume</th>
            <th>Storage</th>
            <th>Format</th>
            <th>Size (MB)</th>
            <th>Deploy</th>
          </tr>
        </thead>
        <tbody>
          {#each templates as templateLxc (templateLxc.volid)}
            <tr>
              <td>{templateLxc.volid}</td>
              <td>{templateLxc.storage}</td>
              <td>{templateLxc.format}</td>
              <td>{Math.round(templateLxc.size / (1024 * 1024))}</td>
              <td>
                <!-- Deploy form for each template, posts to backend to clone template -->
                <form method="POST" action="?/cloneLxcTemplate" class="deploy-form" autocomplete="off" use:enhance={preserveScrollOnSubmit}>
                  <input type="hidden" name="templateVolid" value={templateLxc.volid} />
                  <input type="hidden" name="templateNode" value={serverNode} />
                  <input
                    type="text"
                    name="newName"
                    placeholder="Container name"
                    required
                    autocomplete="off"
                    class="deploy-name-input"
                  />
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
                  />
                  <div class="template-actions">
                    <button
                      type="submit"
                      class="deploy-btn"
                      title="Deploy container from template"
                      aria-label="Deploy container from template"
                    >
                      <img src="/deploy.svg" alt="" aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      class="rename-btn"
                      title="Rename is not available for storage templates"
                      aria-label="Rename is not available for storage templates"
                      disabled
                    >
                      <img src="/rename.svg" alt="" aria-hidden="true" />
                    </button>
                  </div>
                </form>
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
</section>

<style>
  .deploy-form {
    display: flex;
    gap: 0.4rem;
    align-items: center;
  }

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

  .deploy-btn img {
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

  .rename-btn img {
    width: 1.05rem;
    height: 1.05rem;
    display: block;
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
