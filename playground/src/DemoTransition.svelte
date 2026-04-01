<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { elasticOut } from 'svelte/easing';
	import type { TransitionConfig } from 'svelte/transition';

	let visible = $state<boolean>(true);

	interface SpinParams {
		duration: number;
	}

	function spin(node: HTMLElement, { duration }: SpinParams): TransitionConfig {
		return {
			duration,
			css: (t: number, u: number): string => {
				const eased = elasticOut(t);

				return `
					transform: scale(${eased}) rotate(${eased * 1080}deg);
					color: hsl(
						${Math.trunc(t * 360)},
						${Math.min(100, 1000 * u)}%,
						${Math.min(50, 500 * u)}%
					);`;
			}
		};
	}
</script>

<label>
	<input type="checkbox" bind:checked={visible} />
	visible
</label>

{#if visible}
	<div
		class="centered"
		in:spin={{ duration: 8000 }}
		out:fade
	>
		<span>transitions!</span>
	</div>
{/if}

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 25%;
		width: var(--leftbar-size);
		height: 5%;
	}

  .centered {
		position: absolute;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
	}

	span {
		position: absolute;
		transform: translate(-50%, -50%);
		font-size: 4em;
	}
</style>


<div class="container">
  <label>
    <input type="checkbox" bind:checked={visible} />
    visible
  </label>

  {#if visible}
    <p in:fly={{ y: 200, duration: 2000 }} out:fade>
      Flies in, fades out
    </p>
  {/if}
</div>

