<script>
	let { data } = $props();
</script>

<h1>{data.post.title}</h1>
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div>{@html data.post.content}</div>