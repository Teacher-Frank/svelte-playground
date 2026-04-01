<script lang="ts">
  // @ts-ignore - SvelteKit virtual module  didn't resolve otherwise
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
</script>

<h1>blog</h1>

<ul>
	{#each data.summaries as { slug, title }}
		<li><a href="/blog/{slug}">{title}</a></li>
	{/each}
</ul>
