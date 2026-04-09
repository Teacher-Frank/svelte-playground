<script lang="ts">
  // @ts-ignore - SvelteKit virtual module didn't resolve otherwise
  import type { PageData } from './$types.js';
  import ListProxmox from '../../ListProxmox.svelte';

  let { data }: { data: PageData } = $props();
</script>

<ListProxmox {data} />

