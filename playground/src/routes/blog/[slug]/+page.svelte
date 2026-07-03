<script>
	let { data } = $props();
</script>

<h1>{data.post.title}</h1>
<!-- Intentional: blog content is rendered as trusted HTML for rich post formatting. -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -->
<div>{@html data.post.content}</div>