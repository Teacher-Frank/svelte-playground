// @ts-expect-error - SvelteKit virtual module didn't resolve otherwise
import type { Actions, PageServerLoad } from './$types.js';
import * as db from '$lib/server/database.js';

export const load: PageServerLoad = ({ cookies }) => {
	let id = cookies.get('userid');

	if (!id) {
		id = crypto.randomUUID();
		cookies.set('userid', id, { path: '/' });
	}

	return {
		todos: db.getTodos(id)
	};
};

export const actions: Actions = {
	default: async ({ cookies, request }) => {
		const userid = cookies.get('userid');

		if (!userid) {
			return;
		}

		const data = await request.formData();
		const description = data.get('description');

		if (typeof description !== 'string' || description.length === 0) {
			return;
		}

		db.createTodo(userid, description);
	}
};
