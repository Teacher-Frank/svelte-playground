import { error } from '@sveltejs/kit';
// @ts-ignore - SvelteKit virtual module  didn't resolve otherwise
import type { PageServerLoad } from './$types';
import { posts } from '../data.ts';

export const load: PageServerLoad = ({ params }: {  params: any }) => {
	const post = posts.find((post) => post.slug === params.slug);

	if (!post) error(404);

	return {
		post
	};
};
