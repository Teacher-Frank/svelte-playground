<script lang="ts">
  import type { ActionData, PageData } from './$types.js';
  import PxMxAdmin from '../../PxMxAdmin.svelte';

  let {
    data,
    form
  }: {
    data: PageData;
    form?: ActionData;
  } = $props();

  const normalizedForm = $derived(form ?? undefined);
</script>

<PxMxAdmin {data} form={normalizedForm} />

