<script lang="ts">
	// @ts-expect-error - tippy.js has module resolution issues
	import tippy from 'tippy.js';
	import 'tippy.js/dist/tippy.css';

	let content = $state<string>('Hello!');

	function tooltip(content: string) {
		return (node: HTMLElement): (() => void) => {
			// @ts-expect-error tippy.js doesn't have proper types
			const instance = tippy(node, { content });
			return () => instance.destroy();
		};
	}
</script>

<div class="container">
  <input bind:value={content} />

  <button {@attach tooltip(content)}>
      Hover me
  </button>
</div>

<style>
	.container {
		position: fixed;
		left: 0%;
		top: 25%;
		width: var(--leftbar-size);
		height: 5%;
	}

	:global {
		[data-tippy-root] {
			--bg: #666;
			background-color: var(--bg);
			color: white;
			border-radius: 0.2rem;
			padding: 0.2rem 0.6rem;
			filter: drop-shadow(1px 1px 3px rgb(0 0 0 / 0.1));

			* {
				transition: none;
			}
		}

		[data-tippy-root]::before {
			--size: 0.4rem;
			content: '';
			position: absolute;
			left: calc(50% - var(--size));
			top: calc(-2 * var(--size) + 1px);
			border: var(--size) solid transparent;
			border-bottom-color: var(--bg);
		}
	}
</style>
