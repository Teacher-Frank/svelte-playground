// @ts-expect-error - SvelteKit virtual module didn't resolve otherwise
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = ({ cookies }) => {
	const visited = cookies.get('visited') === 'true';

	cookies.set('visited', 'true', {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		maxAge: 60 * 60 * 24 * 365
	});

	return {
		visited
	};
};
