<script lang="ts">
  import './PxMxStyle.css';

  type ProxmoxTask = {
    id: string;
    node: string;
    starttime: number;
    endtime?: number;
    status?: string;
    type: string;
    user: string;
    upid: string;
  };

  let {
    tasks
  }: {
    tasks: ProxmoxTask[];
  } = $props();

  let isExpanded = $state(true);

  const formatTaskTime = (unixSeconds?: number): string => {
    if (!unixSeconds || unixSeconds <= 0) {
      return '-';
    }

    return new Date(unixSeconds * 1000).toLocaleString();
  };
</script>

<section>
  <div class="tasklist-header">
    <h2>Last 10 Actions</h2>
    <button
      class="tasklist-toggle"
      type="button"
      aria-expanded={isExpanded}
      onclick={() => {
        isExpanded = !isExpanded;
      }}
    >
      {isExpanded ? 'v' : '>'}
    </button>
  </div>

  {#if isExpanded}
    {#if tasks.length > 0}
      <div class="tasks-table-wrap">
        <table class="tasks-table">
          <thead>
            <tr>
              <th>Start</th>
              <th>Type</th>
              <th>Status</th>
              <th>Node</th>
              <th>User</th>
              <th>ID</th>
            </tr>
          </thead>
          <tbody>
            {#each tasks as task (task.upid || task.id)}
              <tr>
                <td>{formatTaskTime(task.starttime)}</td>
                <td>{task.type || '-'}</td>
                <td>{task.status || '-'}</td>
                <td>{task.node || '-'}</td>
                <td>{task.user || '-'}</td>
                <td>{task.id || task.upid || '-'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <p>No task history available.</p>
    {/if}
  {/if}
</section>