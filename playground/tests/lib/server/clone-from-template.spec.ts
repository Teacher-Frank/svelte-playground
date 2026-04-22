import { describe, it, expect, vi } from 'vitest';
import { Client } from 'pve-client';

type VmEntry = {
	vmid: number;
	name: string;
	node: string;
	status: string;
	template: number;
};

function makeClient(vmList: VmEntry[]) {
	let cloneBody: string | undefined;
	let cloneUrl: string | undefined;

	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);

		if (url.includes('/cluster/nextid')) {
			return new Response(JSON.stringify({ data: 200 }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}

		if (url.includes('/qemu') && !url.includes('/clone') && !url.includes('/vmid')) {
			return new Response(JSON.stringify({ data: vmList }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}

		if (url.includes('/clone')) {
			cloneUrl = url;
			cloneBody = String(init?.body ?? '');
			return new Response(JSON.stringify({ data: 'UPID:pve:001:clone-task' }), {
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
		fetch: fetchMock as unknown as typeof fetch
	});

	return { client, fetchMock, getCloneUrl: () => cloneUrl, getCloneBody: () => cloneBody };
}

describe('clone VM from template', () => {
	const mockVmList: VmEntry[] = [
		{ vmid: 101, name: 'base-ubuntu', node: 'pve', status: 'stopped', template: 1 },
		{ vmid: 102, name: 'running-vm', node: 'pve', status: 'running', template: 0 }
	];

	it('deploys the first template as vitevm using the next available ID', async () => {
		expect.assertions(7);

		const { client, fetchMock, getCloneUrl, getCloneBody } = makeClient(mockVmList);
		const node = 'pve';

		// Get VM list and find first template
		const nodeApi = client.api.nodes.get(node);
		const typedNodeApi = nodeApi as Record<string, Record<string, unknown>>;
		const vms = await (typedNodeApi.qemu as Record<string, (...args: unknown[]) => Promise<VmEntry[]>>).list({ $path: { node } });
		const firstTemplate = vms.find((vm) => vm.template === 1);
		expect(firstTemplate).toBeDefined();
		expect(firstTemplate?.vmid).toBe(101);

		// Get next available VM ID
		const clusterApi = client.api.cluster as unknown as Record<string, (...args: unknown[]) => Promise<number>>;
		const newid = await clusterApi.nextid({});
		expect(newid).toBe(200);

		// Clone the template
		const vmApi = (typedNodeApi.qemu as Record<string, (id: number) => Record<string, (...args: unknown[]) => Promise<string>>>).vmid(firstTemplate!.vmid);
		const upid = await vmApi.clone({
			$body: {
				newid,
				name: 'vitevm',
				full: 1,
			}
		});

		expect(upid).toBe('UPID:pve:001:clone-task');
		expect(getCloneUrl()).toContain(`/qemu/${firstTemplate!.vmid}/clone`);
		expect(getCloneBody()).toContain('vitevm');
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});
