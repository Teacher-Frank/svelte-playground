// @ts-ignore - SvelteKit virtual module didn't resolve otherwise
import type { PageServerLoad } from './$types.js';
import { Client } from 'pve-client';
import { Agent } from 'node:https';

type ProxmoxResults = {
  nodes: unknown;
  version: unknown;
  cluster: unknown;
  vms: unknown;
  containers: unknown;
  resources: unknown;
};

export const load: PageServerLoad = async () => {
  try {
    const baseUrl = process.env.PVE_BASE_URL;
    const apiToken = process.env.PVE_API_TOKEN;
    const username = process.env.PVE_USERNAME;
    const password = process.env.PVE_PASSWORD;
    const realm = process.env.PVE_REALM ?? 'pam';
    const insecureTls = process.env.PVE_INSECURE_TLS === 'true';

    if (!baseUrl) {
      return {
        results: null,
        error: 'Missing PVE_BASE_URL'
      };
    }

    const agent = insecureTls ? new Agent({ rejectUnauthorized: false }) : undefined;

    let client: Client;
    if (apiToken) {
      client = new Client({ baseUrl, apiToken, agent });
    } else if (username && password) {
      client = new Client({ baseUrl, username, password, realm, agent });
      await client.login();
    } else {
      return {
        results: null,
        error: 'Provide PVE_API_TOKEN or PVE_USERNAME and PVE_PASSWORD'
      };
    }

    const node = process.env.PVE_NODE ?? 'pve';

    const [nodes, version, cluster, allResources] = await Promise.all([
      client.api.nodes.list(),
      client.api.version.version(),
      client.api.cluster.status(),
      client.api.cluster.resources.resources({ $query: { type: 'vm' } }),
    ]);

    const vms = (allResources as any[]).filter((r: any) => r.type === 'qemu' && r.node === node);
    const containers = (allResources as any[]).filter((r: any) => r.type === 'lxc' && r.node === node);
    const resources = allResources;

    const results: ProxmoxResults = { nodes, version, cluster, vms, containers, resources };
    return {
      results,
      error: null
    };
  } catch (e) {
    return {
      results: null,
      error: e instanceof Error ? e.message : String(e)
    };
  }
};
