<script lang="ts">
	// $app/environment and $state are only available in SvelteKit, but this playground is meant to be used in a variety of environments, so we ignore the type error here
	import { browser } from '$app/environment';	
	import BigRedButton from './BigRedButton.svelte';

	let audio = $state<HTMLAudioElement | null>(null);

	$effect(() => {
		if (browser) {
			audio = new Audio('/clownshorn.mp3');
		}
	});

	function honk(): void {
		if (audio) {
			audio.load();
			audio.play();
		}
	}
</script>

<div class="container">
	<BigRedButton onclick={honk} />
</div>

<style>
	.container {
		position: fixed;
		left: 0;
		top: 5%;
		width: var(--leftbar-size);
		height: 15%;
	}
</style>