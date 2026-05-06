<script lang="ts">
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

  // Controls whether the feedback message is visible.
  let dismissed = $state(false);
  $effect(() => {
    // Reset dismissal when a new message arrives.
    if (form?.message) dismissed = false;
  });
</script>

<section>
  <div class="tasklist-header">
    <h2>LXC Templates</h2>
  </div>

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
                <form method="POST" action="?/cloneLxcTemplate" class="deploy-form">
                  <input type="hidden" name="templateVolid" value={templateLxc.volid} />
                  <input type="hidden" name="templateNode" value={serverNode} />
                  <input
                    type="text"
                    name="newName"
                    placeholder="New container name"
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
