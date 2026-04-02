<script lang="ts">
	import BigRedButton from '../DemoBigRedButton.svelte';
  import Canvas from '../DemoCanvas.svelte';
  import Tooltip from '../DemoTooltip.svelte';
  import Transition from '../DemoTransition.svelte';
  import TypeWriter from '../DemoJSTypeWriter.svelte';
  import DemoClassReactivity from '../DemoClassReactivity.svelte';
</script>

<div style="height:5% width:100%; background:var(--color-primary); display:flex; align-items:center; justify-content:center;">
  <h1 style="color:black;">Svelte Playground Homepage</h1>
</div>
<div style="height:95% width:100%; background:var(--color-primary); display:flex; align-items:center; justify-content:center;">
  <BigRedButton />
  <Canvas />
  <Tooltip />
  <Transition />
  <TypeWriter />
  <DemoClassReactivity />
</div>