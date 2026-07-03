<script module>
  import { defineMeta } from '@storybook/addon-svelte-csf';
  import { fn } from 'storybook/test';
  import BigRedButton from './BigRedButton.svelte';

  const { Story } = defineMeta({
    title: 'Components/BigRedButton',
    component: BigRedButton,
    tags: ['autodocs'],
    args: {
      onclick: fn(),
    },
  });
</script>

<!-- Default idle state -->
<Story name="Default" />

<!-- Disabled state -->
<Story name="Disabled" args={{ disabled: true }} />
