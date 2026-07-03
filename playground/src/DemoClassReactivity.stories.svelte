<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoClassReactivity from './DemoClassReactivity.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoClassReactivity',
    component: DemoClassReactivity,
    tags: ['autodocs'],
  });
</script>

<!-- Demonstrates Svelte 5 class-based reactivity with $state and $derived in a class instance -->
<Story name="Default" />
