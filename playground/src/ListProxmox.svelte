<script lang="ts">
  type ProxmoxResults = {
    nodes: unknown;
    version: unknown;
    cluster: unknown;
    vms: unknown;
    containers: unknown;
  };

  let { data }: { data: { results: ProxmoxResults | null; error: string | null } } = $props();
</script>

<main>
  <h1>Proxmox VE Client</h1>
  {#if data.error}
    <p>{data.error}</p>
  {:else if data.results}
    <pre>{JSON.stringify(data.results, null, 2)}</pre>
  {:else}
    <p>No Proxmox data available.</p>
  {/if}
</main>

<style>
  main {
    padding: 2rem;
  }
</style>