<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoJSTypeWriter from './DemoJSTypeWriter.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoJSTypeWriter',
    component: DemoJSTypeWriter,
    tags: ['autodocs'],
  });
</script>

<!-- Demonstrates a custom typewriter Svelte transition and a sliding list toggle -->
<Story name="Default" />
