/**
 * Validators and parsers for Proxmox form submissions.
 *
 * Extracted from proxmox-actions.ts to keep that module under the 750-line threshold.
 * These functions are pure — no API calls, no side effects.
 */
import type { WorkloadKind } from './types.js';

/** Validates and parses a workload control form submission. */
export function parseWorkloadSubmission(
  formData: FormData,
): { type: WorkloadKind; id: number; name: string; node: string; status?: string } {
  const type = formData.get('type');
  const idValue = formData.get('id');
  const name = formData.get('name');
  const nodeValue = formData.get('node');
  const status = formData.get('status');

  if (type !== 'vm' && type !== 'container') {
    throw new Error(`Select a virtual machine or container first. Got type=${JSON.stringify(type)}`);
  }

  if (typeof idValue !== 'string' || idValue.length === 0) {
    throw new Error(`Missing workload ID. Form data id=${JSON.stringify(idValue)}, type=${JSON.stringify(type)}`);
  }

  const id = Number(idValue);
  if (!Number.isInteger(id)) {
    throw new Error(`Invalid workload ID: "${idValue}" is not an integer (parsed as ${id})`);
  }

  if (typeof nodeValue !== 'string' || nodeValue.trim().length === 0) {
    throw new Error(
      `Missing workload node: nodeValue=${JSON.stringify(nodeValue)}, type=${JSON.stringify(type)}, id=${idValue}`
    );
  }

  return {
    type,
    id,
    name: typeof name === 'string' ? name : '',
    node: nodeValue.trim(),
    status: typeof status === 'string' && status.trim().length > 0 ? status.trim() : undefined,
  };
}

/**
 * Returns an error message if the password is not strong enough, or `null` if it passes.
 * Rules: ≥12 chars, at least one uppercase, one lowercase, one digit, one special character.
 */
export function validateStrongPassword(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return 'Root password is required.';
  if (value.length < 12) return 'Root password must be at least 12 characters.';
  if (!/[A-Z]/.test(value)) return 'Root password must contain at least one uppercase letter.';
  if (!/[a-z]/.test(value)) return 'Root password must contain at least one lowercase letter.';
  if (!/[0-9]/.test(value)) return 'Root password must contain at least one digit.';
  if (!/[^A-Za-z0-9]/.test(value))
    return 'Root password must contain at least one special character.';
  return null;
}

/**
 * Returns an error message if the name is not a valid Proxmox DNS name, or `null` if it passes.
 * Proxmox accepts labels (a-z, A-Z, 0-9, hyphens) separated by dots, each label ≤63 chars,
 * must start and end with alphanumeric, max 253 chars total.
 */
export function validateProxmoxName(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return 'Name is required.';
  if (trimmed.length > 253) return `"${trimmed}" is too long (max 253 characters).`;
  const labelPattern = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
  const labels = trimmed.split('.');
  for (const label of labels) {
    if (!labelPattern.test(label)) {
      return `"${trimmed}" is not a valid name. Use only letters, digits, hyphens, and dots; each part must start and end with a letter or digit.`;
    }
  }
  return null;
}
