
<script lang="ts">
  import type { ActionData, PageData } from './$types.js';
  import type { ProxmoxResults } from './types.js';
  import PxMxAdmin from '../../PxMxAdmin.svelte';

  type ExtendedFormType = {
    message?: string;
    status?: 'success' | 'error';
    workloadType?: 'vm' | 'container';
    formType?: 'vm-template' | 'lxc-template' | 'vm' | 'container';
    deployWorkloadName?: string;
    deployTaskNode?: string;
    deployTaskUpids?: string[];
  };

  let {
    data,
    form
  }: {
    data: PageData;
    form?: ActionData;
  } = $props();

  const normalizedForm = $derived(form ?? undefined);
  // PageData from generated $types may wider than the actual runtime shape;
  // cast here so the template stays idiomatic Svelte.
  const typedData = $derived(data as { results: ProxmoxResults | null; error: string | null });
</script>

<PxMxAdmin data={typedData} form={normalizedForm as ExtendedFormType | null | undefined} />

