<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoTooltip from './DemoTooltip.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoTooltip',
    component: DemoTooltip,
    tags: ['autodocs'],
  });
</script>

<!-- Demonstrates Svelte 5 {@attach} directive with tippy.js tooltip — type in the input to change tooltip content -->
<Story name="Default" />
