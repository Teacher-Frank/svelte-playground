import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types.js';

const VALID_SERIAL_PORTS = ['serial0', 'serial1', 'serial2', 'serial3'];

export const load: PageServerLoad = ({ url }) => {
  const vmidStr = url.searchParams.get('vmid');
  const node = url.searchParams.get('node');
  const type = url.searchParams.get('type');
  const name = url.searchParams.get('name');
  const serial = url.searchParams.get('serial');

  if (!vmidStr || !node || (type !== 'vm' && type !== 'container')) {
    error(400, 'Missing or invalid vmid, node, or type query parameters');
  }

  const vmid = parseInt(vmidStr, 10);
  if (!Number.isInteger(vmid) || vmid <= 0) {
    error(400, `Invalid vmid: ${JSON.stringify(vmidStr)}`);
  }

  // Validate serial port: only allowed for VMs, must be in valid range.
  if (serial !== null) {
    if (type !== 'vm') {
      error(400, 'Serial port selection is only supported for QEMU VMs, not LXC containers');
    }
    if (!VALID_SERIAL_PORTS.includes(serial)) {
      error(400, `Invalid serial port: ${serial} — must be one of ${VALID_SERIAL_PORTS.join(', ')}`);
    }
  }

  return {
    vmid,
    node,
    type,
    name: name?.trim() || null,
    serial: serial ?? 'serial0',
  };
};
