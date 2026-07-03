<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import Canvas from './Canvas.svelte';

  const { Story } = defineMeta({
    title: 'Components/Canvas',
    component: Canvas,
    tags: ['autodocs'],
    argTypes: {
      color: { control: 'color' },
      size: { control: { type: 'range', min: 2, max: 60, step: 1 } },
    },
    args: {
      color: '#3b82f6',
      size: 20,
      clearToken: 0,
    },
    parameters: {
      layout: 'fullscreen',
    },
  });
</script>

<!-- Interactive drawing canvas — click or drag to draw -->
<Story name="Default" />

<Story name="Large brush" args={{ size: 40, color: '#ef4444' }} />

<Story name="Fine pen" args={{ size: 4, color: '#22c55e' }} />
