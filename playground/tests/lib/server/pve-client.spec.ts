import { describe, it, expect, vi } from 'vitest';
import { Client } from 'pve-client';

function headerValue(headers: RequestInit['headers'], key: string): string | undefined {
	if (!headers) return undefined;
	if (headers instanceof Headers) return headers.get(key) ?? undefined;
	if (Array.isArray(headers)) {
		const pair = headers.find(([k]) => k.toLowerCase() === key.toLowerCase());
		return pair?.[1];
	}
	const record = headers as Record<string, string>;
	const found = Object.entries(record).find(([k]) => k.toLowerCase() === key.toLowerCase());
	return found?.[1];
}

describe('pve-client', () => {
	it('logs in with username/password and stores session cookie', async () => {
		expect.assertions(7);

		const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
			expect(String(input)).toContain('/api2/json/access/ticket');
			expect(init?.method).toBe('POST');
			const body = String(init?.body ?? '');
			expect(body).toContain('username=root');
			expect(body).toContain('realm=pam');
			expect(body).toContain('password=secret');

			return new Response(
				JSON.stringify({ data: { ticket: 'ticket-value', CSRFPreventionToken: 'csrf-token' } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});

		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			username: 'root',
			password: 'secret',
			realm: 'pam',
			fetch: fetchMock as unknown as typeof fetch
		});

		await client.login();

		expect(client.sessionCookie()).toContain('PVEAuthCookie=ticket-value');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('sends authorization header for apiToken requests', async () => {
		expect.assertions(4);

		const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) => {
			const auth = headerValue(init?.headers, 'authorization');
			expect(auth).toBeDefined();
			expect(auth).toContain('root@pam!mytoken=abc123');

			return new Response(
				JSON.stringify({ data: { release: '8.2', repoid: 'pve-no-subscription', version: '8.2.4' } }),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			);
		});

		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			apiToken: 'root@pam!mytoken=abc123',
			fetch: fetchMock as unknown as typeof fetch
		});

		const version = await client.api.version.version();
		expect(version.version).toBe('8.2.4');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects login when configured with apiToken', async () => {
		expect.assertions(1);

		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			apiToken: 'root@pam!mytoken=abc123'
		});

		await expect(client.login()).rejects.toThrow('login() is only available for username/password auth');
	});

	it('throws on non-2xx API responses', async () => {
		expect.assertions(2);

		const fetchMock = vi.fn(async () => {
			return new Response('permission denied', {
				status: 403,
				statusText: 'Forbidden',
				headers: { 'content-type': 'text/plain' }
			});
		});

		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			apiToken: 'root@pam!mytoken=abc123',
			fetch: fetchMock as unknown as typeof fetch
		});

		await expect(client.api.version.version()).rejects.toThrow('HTTP 403 Forbidden: permission denied');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// Test that status control methods are accessible on nodes.get(node).qemu.vmid(id)
	it('provides status.start/stop/reboot methods on nodes.get(node).qemu.vmid(id)', () => {
		expect.assertions(6);

		const fetchMock = vi.fn();
		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			apiToken: 'root@pam!token=abc123',
			fetch: fetchMock as unknown as typeof fetch
		});

		const nodeApi = client.api.nodes.get('pve');
		const vmApi = nodeApi.qemu.vmid(200);
		const statusApi = vmApi.status as Record<string, unknown>;

		// Verify that status object exists and has the required methods
		expect(vmApi).toBeDefined();
		expect(statusApi).toBeDefined();
		expect(typeof statusApi.start).toBe('function');
		expect(typeof statusApi.stop).toBe('function');
		expect(typeof statusApi.reboot).toBe('function');

		// Also verify the clone method is still there
		expect(typeof vmApi.clone).toBe('function');
	});

	// Test that status control methods are accessible on nodes.get(node).lxc.id(id)
	it('provides status.start/stop/reboot methods on nodes.get(node).lxc.id(vmid)', () => {
		expect.assertions(6);

		const fetchMock = vi.fn();
		const client = new Client({
			baseUrl: 'https://pve.example.com:8006',
			apiToken: 'root@pam!token=abc123',
			fetch: fetchMock as unknown as typeof fetch
		});

		const nodeApi = client.api.nodes.get('pve');
		const ctApi = nodeApi.lxc.id(100);
		const statusApi = ctApi.status as Record<string, unknown>;

		// Verify that status object exists and has the required methods
		expect(ctApi).toBeDefined();
		expect(statusApi).toBeDefined();
		expect(typeof statusApi.start).toBe('function');
		expect(typeof statusApi.stop).toBe('function');
		expect(typeof statusApi.reboot).toBe('function');

		// Also verify the clone method is still there
		expect(typeof ctApi.clone).toBe('function');
	});
});