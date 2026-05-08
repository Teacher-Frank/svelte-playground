<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoCanvas from './DemoCanvas.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoCanvas',
    component: DemoCanvas,
    tags: ['autodocs'],
    parameters: {
      layout: 'fullscreen',
    },
  });
</script>

<!-- Interactive drawing canvas with color picker and brush size controls -->
<Story name="Default" />
