<script lang="ts">
  import PxMxTemplateActionButtons from './PxMxTemplateActionButtons.svelte';

  type TemplateActionRow = {
    key: string;
    cells: string[];
    deployTitle: string;
    deployLabel: string;
    renameTitle: string;
    renameLabel: string;
    renameEnabled?: boolean;
    onDeploy: () => void;
    onRename: () => void;
  };

  let {
    headers,
    rows,
    submitInFlight = false,
  }: {
    headers: string[];
    rows: TemplateActionRow[];
    submitInFlight?: boolean;
  } = $props();
</script>

<div class="tasks-table-wrap">
  <table class="tasks-table">
    <thead>
      <tr>
        {#each headers as header, headerIndex (`${header}-${headerIndex}`)}
          <th>{header}</th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each rows as row (row.key)}
        <tr>
          {#each row.cells as cell, cellIndex (`${row.key}-${cellIndex}`)}
            <td>{cell}</td>
          {/each}
          <td>
            <PxMxTemplateActionButtons
              deployTitle={row.deployTitle}
              deployLabel={row.deployLabel}
              renameTitle={row.renameTitle}
              renameLabel={row.renameLabel}
              renameEnabled={row.renameEnabled ?? true}
              submitInFlight={submitInFlight}
              onDeploy={row.onDeploy}
              onRename={row.onRename}
            />
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
