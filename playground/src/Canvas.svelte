<script lang="ts">
	interface Props {
		color: string;
		size: number;
		clearToken: number;
	}

	interface Coords {
		x: number;
		y: number;
	}

	let { color, size, clearToken }: Props = $props();

	let canvas = $state<HTMLCanvasElement>();
	let context = $state<CanvasRenderingContext2D>();
	let coords = $state<Coords | null>();

	$effect(() => {
		if (canvas) {
			context = canvas.getContext('2d')!;
			resize();
		}
	});

	$effect(() => {
		if (context && canvas) {
			// clearToken is used to track when the canvas should be cleared
			void clearToken;
			context.clearRect(0, 0, canvas.width, canvas.height);
		}
	});

	function resize(): void {
		if (canvas && canvas.parentElement) {
			canvas.width = canvas.parentElement.clientWidth;
			canvas.height = canvas.parentElement.clientHeight;
		}
	}
</script>

<svelte:window onresize={resize} />

<canvas
	bind:this={canvas}
	onpointerdown={(e: PointerEvent) => {
		coords = { x: e.offsetX, y: e.offsetY };

		if (context) {
			context.fillStyle = color;
			context.beginPath();
			context.arc(coords.x, coords.y, size / 2, 0, 2 * Math.PI);
			context.fill();
		}
	}}
	onpointerleave={() => {
		coords = null;
	}}
	onpointermove={(e: PointerEvent) => {
		const previous = coords;

		coords = { x: e.offsetX, y: e.offsetY };

		if (e.buttons === 1 && context && previous) {
			e.preventDefault();

			context.strokeStyle = color;
			context.lineWidth = size;
			context.lineCap = 'round';
			context.beginPath();
			context.moveTo(previous.x, previous.y);
			context.lineTo(coords.x, coords.y);
			context.stroke();
		}
	}}
></canvas>

{#if coords}
	<div
		class="preview"
		style="--color: {color}; --size: {size}px; --x: {coords.x}px; --y: {coords.y}px"
	></div>
{/if}

<style>
	canvas {
		position: absolute;
		left: 0;
		top: 0;
		width: 100%;
		height: 100%;
	}

	.preview {
		position: absolute;
		left: var(--x);
		top: var(--y);
		width: var(--size);
		height: var(--size);
		transform: translate(-50%, -50%);
		background: var(--color);
		border-radius: 50%;
		opacity: 0.5;
		pointer-events: none;
	}
</style>
