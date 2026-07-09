/**
 * SvelteKit form actions for Proxmox workload management.
 *
 * This module is intentionally thin (~150 lines). Heavy logic has been extracted:
 * - Validators → action-validators.ts
 * - Execute helpers → action-executors.ts
 * - Template deployment → action-template-deployers.ts
 */
import type { Actions } from './$types.js';
import { fail, type RequestEvent } from '@sveltejs/kit';
import type { WorkloadKind, WorkloadAction } from './types.js';
import {
  parseWorkloadSubmission,
  validateStrongPassword,
  validateProxmoxName,
} from './action-validators.js';
import {
  executeDestroyAction,
  executeConvertToTemplateAction,
  executeWorkloadAction,
  executeWorkloadRenameAction,
} from './action-executors.js';
import { acquireDeployLock, releaseDeployLock, clearPendingDestroy } from './helpers.server.js';
import {
  deployVmFromTemplate,
  renameVmTemplate,
  cloneLxcTemplate,
  cloneLxcGuestTemplate,
} from './action-template-deployers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Formats a Proxmox API error message for user display. */
function formatApiError(message: string): string {
  return message.includes('login or token required')
    ? 'Proxmox authentication required. Check PVE credentials in environment variables.'
    : message;
}

// ---------------------------------------------------------------------------
// Action builder
// ---------------------------------------------------------------------------

/** Builds a SvelteKit form action handler for a given workload power action. */
const buildAction = (action: WorkloadAction) => {
  return async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;

    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const { upid, effectiveAction } = await executeWorkloadAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        action,
        selectedWorkload.status,
      );
      const actionLabel =
        effectiveAction === 'restart'
          ? 'Restarted'
          : effectiveAction === 'stop'
          ? 'Stopped'
          : 'Started';
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: `${actionLabel} ${kindLabel} ${selectedWorkload.id}${
          selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
        }.`,
        upid,
        workloadAction: effectiveAction,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: formatApiError(error instanceof Error ? error.message : String(error)),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  };
};

// ---------------------------------------------------------------------------
// SvelteKit form actions export
// ---------------------------------------------------------------------------

export const actions: Actions = {
  start: buildAction('start'),
  stop: buildAction('stop'),
  restart: buildAction('restart'),

  renameWorkload: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);

      const newNameRaw = formData.get('newName');
      if (typeof newNameRaw !== 'string' || newNameRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Name is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const newNameTrimmed = newNameRaw.trim();
      const nameError = validateProxmoxName(newNameTrimmed);
      if (nameError) {
        return fail(400, {
          status: 'error' as const,
          message: `Name: ${nameError}`,
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const { upid } = await executeWorkloadRenameAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.name,
        newNameTrimmed,
      );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const oldName = selectedWorkload.name ?? `ID ${selectedWorkload.id}`;
      return {
        status: 'success' as const,
        message: `Renamed ${kindLabel} ${selectedWorkload.id} from "${oldName}" to "${newNameTrimmed}"${upid ? ` — task ${upid}` : ''}.`,
        upid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  convertToTemplate: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);

      const { convertUpid, stopUpid } = await executeConvertToTemplateAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status,
      );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';

      return {
        status: 'success' as const,
        message: stopUpid
          ? `Stopped ${kindLabel} ${selectedWorkload.id}${
              selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
            } and started template conversion — stop task ${stopUpid}, convert task ${convertUpid}.`
          : `Converting ${kindLabel} ${selectedWorkload.id}${
              selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
            } to template — task ${convertUpid}.`,
        upid: convertUpid,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  cloneFromTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const ciUser = formData.get('ciUser');
      const ciPassword = formData.get('ciPassword');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'vm-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'vm-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'vm-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New VM name is required.',
          formType: 'vm-template',
        });
      }

      const nameError = validateProxmoxName(newName);
      if (nameError) {
        return fail(400, {
          status: 'error' as const,
          message: `VM name: ${nameError}`,
          formType: 'vm-template',
        });
      }

      if (typeof ciUser !== 'string' || ciUser.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Username is required for cloud-init.',
          formType: 'vm-template',
        });
      }

      const passwordError = validateStrongPassword(ciPassword);
      if (passwordError) {
        return fail(400, {
          status: 'error' as const,
          message: passwordError,
          formType: 'vm-template',
        });
      }

      // Concurrency guard: reject if another deploy is already in progress
      const lockError = acquireDeployLock('vm', newName.trim());
      if (lockError !== null) {
        return fail(409, {
          status: 'error' as const,
          message: lockError,
          formType: 'vm-template',
        });
      }

      const { cloneUpid, newid } = await deployVmFromTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
        ciUser.trim(),
        ciPassword as string,
      );

      return {
        status: 'success' as const,
        message: `Deploying "${newName.trim()}" — clone task started. VM will start automatically once ready.`,
        formType: 'vm-template',
        deployWorkloadName: newName.trim(),
        deployWorkloadId: newid,
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid],
      };
    } catch (error) {
      // Release lock on unexpected errors — idempotent, safe with empty name
      releaseDeployLock('vm', '');
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template',
      });
    }
  },

  renameVmTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Template name is required.',
        });
      }

      const renameNameError = validateProxmoxName(newName);
      if (renameNameError) {
        return fail(400, {
          status: 'error' as const,
          message: `Template name: ${renameNameError}`,
        });
      }

      const result = await renameVmTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
      );
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed template ${templateId} to "${newName.trim()}".`,
        formType: 'vm-template',
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'vm-template',
      });
    }
  },

  cloneLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'lxc-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New container name is required.',
          formType: 'lxc-template',
        });
      }

      // Concurrency guard: reject if another deploy is already in progress
      const lockError = acquireDeployLock('lxc', newName.trim());
      if (lockError !== null) {
        return fail(409, {
          status: 'error' as const,
          message: lockError,
          formType: 'lxc-template',
        });
      }

      try {
        const { cloneUpid, startUpid } = await cloneLxcGuestTemplate(
          templateId,
          templateNode.trim(),
          newName.trim(),
        );

        return {
          status: 'success' as const,
          message:
            `Cloned guest template ${templateId} as "${newName.trim()}" — clone task ${cloneUpid}. ` +
            `Started container ${newName.trim()} — start task ${startUpid}.`,
          formType: 'lxc-template',
          deployWorkloadName: newName.trim(),
          deployTaskNode: templateNode.trim(),
          deployTaskUpids: [cloneUpid, startUpid],
        };
      } finally {
        releaseDeployLock('lxc', newName.trim());
      }
    } catch (error) {
      // Release lock on unexpected errors — idempotent, safe with empty name
      releaseDeployLock('lxc', '');
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },

  renameLxcGuestTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateIdValue = formData.get('templateId');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');

      if (typeof templateIdValue !== 'string' || templateIdValue.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template ID.',
          formType: 'lxc-template',
        });
      }

      const templateId = Number(templateIdValue);
      if (!Number.isInteger(templateId) || templateId <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: `Invalid template ID: "${templateIdValue}".`,
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Template name is required.',
          formType: 'lxc-template',
        });
      }

      const result = await renameLxcGuestTemplateFn(
        templateId,
        templateNode.trim(),
        newName.trim(),
      );
      const maybeTask = typeof result === 'string' ? result : undefined;

      return {
        status: 'success' as const,
        message: maybeTask
          ? `Renaming guest template ${templateId} to "${newName.trim()}" — task ${maybeTask}.`
          : `Renamed guest template ${templateId} to "${newName.trim()}".`,
        formType: 'lxc-template',
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },

  destroy: async ({ request }: RequestEvent) => {
    let selectedWorkload: {
      type: WorkloadKind;
      id: number;
      name?: string;
      node: string;
      status?: string;
    } | undefined;
    try {
      const formData = await request.formData();
      selectedWorkload = parseWorkloadSubmission(formData);
      const { stopUpid } = await executeDestroyAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.name ?? '',
        selectedWorkload.status,
      );
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const nameSuffix = selectedWorkload.name ? ` (${selectedWorkload.name})` : '';

      return {
        status: 'success' as const,
        message: stopUpid
          ? `Destroying ${kindLabel} ${selectedWorkload.id}${nameSuffix} — stop task ${stopUpid}. `
              + `This may take a moment while ${kindLabel.toLowerCase()} ${selectedWorkload.id} stops and is removed.`
          : `Destroying ${kindLabel} ${selectedWorkload.id}${nameSuffix}.`,
        workloadType: selectedWorkload.type,
        formType: selectedWorkload.type,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        workloadType: selectedWorkload?.type,
        formType: selectedWorkload?.type,
      });
    }
  },

  /**
   * Cancels a failed destroy entry so the user can retry the destroy operation.
   * When a destroy fails (timeout, API error), the workload is stuck in `destroyFailed`
   * with all actions disabled. This action clears the entry from `pendingDestroy`.
   */
  cancel: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const rawId = formData.get('id');
      if (rawId === null || rawId === undefined) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing workload ID.',
        });
      }

      const id = Number(rawId);
      if (!Number.isInteger(id) || id <= 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Invalid workload ID.',
        });
      }

      clearPendingDestroy(id);
      return {
        status: 'success' as const,
        message: `Cleared failed destroy for workload ${id}. You can now retry the operation.`,
      };
    } catch (error) {
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  },

  cloneLxcTemplate: async ({ request }: RequestEvent) => {
    try {
      const formData = await request.formData();

      const templateVolid = formData.get('templateVolid');
      const templateNode = formData.get('templateNode');
      const newName = formData.get('newName');
      const rootPassword = formData.get('rootPassword');

      if (typeof templateVolid !== 'string' || templateVolid.length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template volume ID.',
          formType: 'lxc-template',
        });
      }

      if (typeof templateNode !== 'string' || templateNode.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Missing template node.',
          formType: 'lxc-template',
        });
      }

      if (typeof newName !== 'string' || newName.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'New container name is required.',
          formType: 'lxc-template',
        });
      }

      const passwordError = validateStrongPassword(rootPassword);
      if (passwordError) {
        return fail(400, {
          status: 'error' as const,
          message: passwordError,
          formType: 'lxc-template',
        });
      }

      // Concurrency guard: reject if another deploy is already in progress
      const lockError = acquireDeployLock('lxc', newName.trim());
      if (lockError !== null) {
        return fail(409, {
          status: 'error' as const,
          message: lockError,
          formType: 'lxc-template',
        });
      }

      try {
        const upid = await cloneLxcTemplate(
          templateVolid.trim(),
          templateNode.trim(),
          newName.trim(),
          rootPassword as string,
        );

        return {
          status: 'success' as const,
          message: `Deploying LXC template "${templateVolid}" as "${newName.trim()}" — task ${upid}.`,
          formType: 'lxc-template',
          deployWorkloadName: newName.trim(),
          deployTaskNode: templateNode.trim(),
          deployTaskUpids: [upid],
        };
      } finally {
        releaseDeployLock('lxc', newName.trim());
      }
    } catch (error) {
      // Release lock on unexpected errors — idempotent, safe with empty name
      releaseDeployLock('lxc', '');
      return fail(500, {
        status: 'error' as const,
        message: error instanceof Error ? error.message : String(error),
        formType: 'lxc-template',
      });
    }
  },
};

/** Renames a converted LXC guest template by updating hostname in config. */
async function renameLxcGuestTemplateFn(
  templateId: number,
  templateNode: string,
  newName: string,
): Promise<string | unknown> {
  const { createClient } = await import('./helpers.server.js');
  const client = await createClient();
  // TODO(pve-client): 'hostname' is a valid LXC config field but missing from
  // the generated PUT body type. Fix in pve-client types; cast for now.
  return await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { hostname: newName } as Record<string, unknown>,
  });
}
