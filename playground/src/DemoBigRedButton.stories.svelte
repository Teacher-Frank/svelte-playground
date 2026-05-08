<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import DemoBigRedButton from './DemoBigRedButton.svelte';

  const { Story } = defineMeta({
    title: 'Demos/DemoBigRedButton',
    component: DemoBigRedButton,
    tags: ['autodocs'],
    parameters: {
      sveltekit_experimental: {
        // $app/environment.browser is true in Storybook
      },
    },
  });
</script>

<!-- Clicking the button plays a sound (requires clownshorn.mp3 in /static) -->
<Story name="Default" />
