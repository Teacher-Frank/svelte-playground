import type { Action } from 'svelte/action';

type FocusableElement = HTMLButtonElement | HTMLAnchorElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement;

export const trapFocus: Action<HTMLElement> = (node: HTMLElement) => {
	const previous = document.activeElement as HTMLElement | null;

	function focusable(): FocusableElement[] {
		return Array.from(
			node.querySelectorAll<FocusableElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
		);
	}

	function handleKeydown(event: KeyboardEvent): void {
		if (event.key !== 'Tab') return;

		const current = document.activeElement;

		const elements = focusable();
		const first = elements.at(0);
		const last = elements.at(-1);

		if (event.shiftKey && current === first) {
			last?.focus();
			event.preventDefault();
		}

		if (!event.shiftKey && current === last) {
			first?.focus();
			event.preventDefault();
		}
	}

	focusable()[0]?.focus();
	node.addEventListener('keydown', handleKeydown);

	return () => {
		node.removeEventListener('keydown', handleKeydown);
		previous?.focus();
	};
};
