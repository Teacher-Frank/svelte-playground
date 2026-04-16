<script lang="ts">
  import type { ActionData, PageData } from './$types.js';
  import AdminProxmox from '../../AdminProxmox.svelte';

  let {
    data,
    form
  }: {
    data: PageData;
    form?: ActionData;
  } = $props();

  const normalizedForm = $derived(form ?? undefined);
</script>

<AdminProxmox {data} form={normalizedForm} />

