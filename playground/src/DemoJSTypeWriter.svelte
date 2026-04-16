<script lang="ts">
	import type { TransitionConfig } from 'svelte/transition';
 	import { slide } from 'svelte/transition';
  import { messages } from './loading-messages.ts';

	let TWvisible = $state<boolean>(false);

  //show list with slide bar
 	let items = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

	let showItems = $state(true);
	let i = $state(5);

  
  // Code for loading demo
  let j = $state(-1);

  $effect(() => {
    const interval = setInterval(() => {
      j += 1;
      j %= messages.length;
    }, 2500);

    return () => {
      clearInterval(interval);
    };
  });
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
    {#each items.slice(0, i) as item (item)}
      <div class="slide" transition:slide|global>
        {item}
      </div>
    {/each}
  {/if}

  <h1>loading...demo</h1>

  {#key i}
    <p in:typewriter={{ speed: 10 }}>
      {messages[j] || ''}
    </p>
  {/key}
</div>

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 55%;
		width: var(--leftbar-size);
		height: 15%;
	}
</style>