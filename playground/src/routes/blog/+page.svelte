<script lang="ts">
  // @ts-expect-error - SvelteKit virtual module  didn't resolve otherwise
  import type { PageData } from './$types';
  import { base } from '$app/paths';

  let { data }: { data: PageData } = $props();
</script>

<h1>blog</h1>

<ul>
	{#each data.summaries as { slug, title } (slug)}
		<li><a href="{base}/blog/{slug}">{title}</a></li>
	{/each}
</ul>
