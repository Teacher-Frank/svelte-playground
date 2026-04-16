<script lang="ts">
  import type { PageData } from './$types.js';
  import ListProxmox from '../../ListProxmox.svelte';
  import VMContainerControls from '../../VMContainerControls.svelte';

  let { data }: { data: PageData } = $props();
</script>

<ListProxmox {data} />
<VMContainerControls
  onStart={() => alert('Start VM/Container')}
  onStop={() => alert('Stop VM/Container')}
  onRestart={() => alert('Restart VM/Container')}
/>

