
<script lang="ts">
  import type { ActionData, PageData } from './$types.js';
  import PxMxAdmin from '../../PxMxAdmin.svelte';

  type ExtendedFormType = {
    message?: string;
    status?: 'success' | 'error';
    workloadType?: 'vm' | 'container';
    formType?: 'vm-template' | 'lxc-template' | 'vm' | 'container';
  };

  let {
    data,
    form
  }: {
    data: PageData;
    form?: ActionData;
  } = $props();

  const normalizedForm = $derived(form ?? undefined);
</script>

<PxMxAdmin {data} form={normalizedForm as ExtendedFormType | null | undefined} />

