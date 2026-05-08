<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoTransition from './DemoTransition.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoTransition',
    component: DemoTransition,
    tags: ['autodocs'],
  });
</script>

<!-- Demonstrates custom spin/fade/fly Svelte transitions with checkbox toggle and status events -->
<Story name="Default" />
