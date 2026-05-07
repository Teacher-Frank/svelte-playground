import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';

export const load: PageServerLoad = ({ url }) => {
  const vmidStr = url.searchParams.get('vmid');
  const node = url.searchParams.get('node');
  const type = url.searchParams.get('type');

  if (!vmidStr || !node || (type !== 'vm' && type !== 'container')) {
    error(400, 'Missing or invalid vmid, node, or type query parameters');
  }

  const vmid = parseInt(vmidStr, 10);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    error(400, `Invalid vmid: ${JSON.stringify(vmidStr)}`);
  }

  return {
    vmid,
    node,
    type,
  };
};
