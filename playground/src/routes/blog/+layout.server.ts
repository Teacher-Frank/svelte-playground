// @ts-ignore - SvelteKit virtual module  didn't resolve otherwise
import type { PageServerLoad } from './$types.js';
import { posts } from './data.ts';

export const load: PageServerLoad = () => {
	return {
		summaries: posts.map((post) => ({
			slug: post.slug,
			title: post.title
		}))
	};
};
