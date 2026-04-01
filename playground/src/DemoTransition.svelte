<script lang="ts">
	import { fade, fly } from 'svelte/transition';
	import { elasticOut } from 'svelte/easing';
	import type { TransitionConfig } from 'svelte/transition';

	let visible = $state<boolean>(true);
  let status = $state('waiting...');

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

<div class="container">
  <p>status: {status}</p>

  <label>
    <input type="checkbox" bind:checked={visible} />
    visible
  </label>

  {#if visible}
    <p 
      in:fly={{ y: 200, duration: 2000 }} 
      out:fade
    >
      Flies in, fades out
    </p>
  {/if}

  {#if visible}
    <div
      in:spin={{ duration: 4000 }}
      out:fade
      onintrostart={() => status = 'intro started'}
      onoutrostart={() => status = 'outro started'}
      onintroend={() => status = 'intro ended'}
      onoutroend={() => status = 'outro ended'}
    >
      <span
      >transitions!</span>
    </div>
  {/if}

</div>

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 30%;
		width: var(--leftbar-size);
		height: 10%;
	}
  span {
		position: relative;
    top: 0%;
		font-size: 3em;
	}

</style>




