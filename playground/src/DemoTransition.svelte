<script lang="ts">
	import { fade } from 'svelte/transition';

	let visible = $state(true);
</script>

<div class="container">
  <label>
    <input type="checkbox" bind:checked={visible} />
    visible
  </label>

  {#if visible}
    <p transition:fade>
        Fades in and out
    </p>
  {/if}
</div>

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 25%;
		width: 25%;
		height: 10%;
	}
</style>