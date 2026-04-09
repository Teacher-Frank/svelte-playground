import { describe, it, expect, vi } from 'vitest';
import { Client } from 'pve-client';

function makeClient() {
	const fetchMock = vi.fn(async (input: string | URL) => {
		const url = String(input);
		if (url.includes('/status')) {
			return new Response(JSON.stringify({ data: { ok: true } }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}

		return new Response(JSON.stringify({ data: [] }), {
			status: 200,
			headers: { 'content-type': 'application/json' }
		});
	});

	const client = new Client({
		baseUrl: 'https://pve.example.com:8006',
		apiToken: 'root@pam!mytoken=abc123',
		fetch: fetchMock as any
	});

	return { client, fetchMock };
}

describe('pve-client typed surface canary tests', () => {
	it('README path-based status sample should be exposed on node API', async () => {
		const { client } = makeClient();
		const nodeApi: any = client.api.nodes.get('pve');

		expect(nodeApi.status).toBeDefined();
		expect(typeof nodeApi.status.get).toBe('function');

		const status = await nodeApi.status.get({ $path: { node: 'pve' } });
		expect(status).toBeDefined();
	});

	it('node-scoped qemu list should be exposed on node API', async () => {
		const { client } = makeClient();
		const nodeApi: any = client.api.nodes.get('pve');

		expect(nodeApi.qemu).toBeDefined();
		expect(typeof nodeApi.qemu.list).toBe('function');

		const vms = await nodeApi.qemu.list({ $path: { node: 'pve' } });
		expect(Array.isArray(vms)).toBe(true);
	});

	it('node-scoped lxc list should be exposed on node API', async () => {
		const { client } = makeClient();
		const nodeApi: any = client.api.nodes.get('pve');

		expect(nodeApi.lxc).toBeDefined();
		expect(typeof nodeApi.lxc.list).toBe('function');

		const containers = await nodeApi.lxc.list({ $path: { node: 'pve' } });
		expect(Array.isArray(containers)).toBe(true);
	});
});
