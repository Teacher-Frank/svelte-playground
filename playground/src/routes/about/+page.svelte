<script lang="ts">
	let { data }: { data: { visited: boolean } } = $props();
</script>

<h1>About</h1>
<p>this is the about page.</p>
<h1>Hello {data.visited ? 'friend' : 'stranger'}!</h1>