<script lang="ts">
	import type { TransitionConfig } from 'svelte/transition';
 	import { slide } from 'svelte/transition';

	let TWvisible = $state<boolean>(false);

 	let items = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

	let showItems = $state(true);
	let i = $state(5);


	interface TypewriterParams {
		speed?: number;
	}

	function typewriter(node: HTMLElement, { speed = 1 }: TypewriterParams): TransitionConfig {
		const valid: boolean = node.childNodes.length === 1 && node.childNodes[0].nodeType === Node.TEXT_NODE;

		if (!valid) {
			throw new Error(`This transition only works on elements with a single text node child`);
		}

		const text: string = node.textContent!;
		const duration: number = text.length / (speed * 0.01);

		return {
			duration,
			tick: (t: number): void => {
				const i: number = Math.trunc(text.length * t);
				node.textContent = text.slice(0, i);
			}
		};
	}
</script>
<div class="container">
  <label>
    <input type="checkbox" bind:checked={TWvisible} />
    Typewriter
  </label>

  {#if TWvisible}
    <p transition:typewriter={{ speed: 2 }}>
      The quick brown fox jumps over the lazy dog
    </p>
  {/if}

    <label>
	  <input type="checkbox" bind:checked={showItems} />
	  show list
  </label>

  <label>
    <input type="range" bind:value={i} max="10" />
  </label>

  {#if showItems}
    {#each items.slice(0, i) as item}
      <div class="slide" transition:slide|global>
        {item}
      </div>
    {/each}
  {/if}

</div>

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 50%;
		width: var(--leftbar-size);
		height: 15%;
	}
</style>  