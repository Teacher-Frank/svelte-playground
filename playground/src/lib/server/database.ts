// In a real app, this data would live in a database,
// rather than in memory. But for now, we cheat.
type Todo = {
	id: string;
	description: string;
	done: boolean;
};

const db = new Map<string, Todo[]>();

function getOrCreateTodos(userid: string): Todo[] {
	if (!db.has(userid)) {
		db.set(userid, [
			{
				id: crypto.randomUUID(),
				description: 'Learn SvelteKit',
				done: false
			}
		]);
	}

	return db.get(userid)!;
}

export function getTodos(userid: string): Todo[] {
	return getOrCreateTodos(userid);
}

export function createTodo(userid: string, description: string): void {
	const todos = getOrCreateTodos(userid);

	todos.push({
		id: crypto.randomUUID(),
		description,
		done: false
	});
}

export function deleteTodo(userid: string, todoid: string): void {
	const todos = getOrCreateTodos(userid);
	const index = todos.findIndex((todo) => todo.id === todoid);

	if (index !== -1) {
		todos.splice(index, 1);
	}
}
