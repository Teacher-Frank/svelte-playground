<script lang="ts">
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

  let dismissed = $state(false);
  $effect(() => {
    // Reset dismissed state whenever a new form result arrives
    if (form?.message) dismissed = false;
  });
</script>

<section>
  <div class="tasklist-header">
    <h2>VM Templates</h2>
  </div>

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
            <th>Status</th>
            <th>Deploy</th>
          </tr>
        </thead>
        <tbody>
          {#each templates as templateVm (templateVm.id)}
            <tr>
              <td>{templateVm.id ?? '-'}</td>
              <td>{templateVm.name ?? 'Unnamed template'}</td>
              <td>{templateVm.node ?? '-'}</td>
              <td>{templateVm.status ?? '-'}</td>
              <td>
                <form method="POST" action="?/cloneFromTemplate" class="deploy-form">
                  <input type="hidden" name="templateId" value={templateVm.id?.toString() ?? ''} />
                  <input type="hidden" name="templateNode" value={templateVm.node ?? ''} />
                  <input
                    type="text"
                    name="newName"
                    placeholder="New VM name"
                    required
                    class="deploy-name-input"
                  />
                  <button type="submit" class="deploy-btn">Deploy</button>
                </form>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p>No VM templates found.</p>
  {/if}
</section>

<style>
  .deploy-form {
    display: flex;
    gap: 0.4rem;
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
    padding: 0.25rem 0.75rem;
    white-space: nowrap;
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