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
  executeWorkloadConfigureAction,
} from './action-executors.js';
import {
  deployVmFromTemplate,
  renameVmTemplate,
  cloneLxcTemplate,
  cloneLxcGuestTemplate,
} from './action-template-deployers.js';

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

  configureWorkload: async ({ request }: RequestEvent) => {
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

      const cpuShareRaw = formData.get('cpuSharePercent');
      const memoryRaw = formData.get('memoryMiB');
      const storageRaw = formData.get('storageGiB');

      if (typeof cpuShareRaw !== 'string' || cpuShareRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'CPU share is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      if (typeof memoryRaw !== 'string' || memoryRaw.trim().length === 0) {
        return fail(400, {
          status: 'error' as const,
          message: 'Memory is required.',
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const cpuSharePercent = Number(cpuShareRaw);
      const memoryMiB = Number(memoryRaw);
      const storageGiB =
        typeof storageRaw === 'string' && storageRaw.trim().length > 0
          ? Number(storageRaw)
          : undefined;

      if (storageGiB != null && (!Number.isFinite(storageGiB) || storageGiB < 1)) {
        return fail(400, {
          status: 'error' as const,
          message: `Storage increase must be at least 1 GiB (got ${JSON.stringify(storageRaw)}).`,
          workloadType: selectedWorkload.type,
          formType: selectedWorkload.type,
        });
      }

      const { upid, appliedCpuLimit, appliedMemoryMiB, appliedCpuCores, appliedStorageGiB, storageTaskUpid } =
        await executeWorkloadConfigureAction(
          selectedWorkload.type,
          selectedWorkload.id,
          selectedWorkload.node,
          cpuSharePercent,
          memoryMiB,
          storageGiB,
        );

      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const cpuSummary =
        selectedWorkload.type === 'vm'
          ? `cores=${appliedCpuCores ?? Math.max(1, Math.round(appliedCpuLimit))}`
          : `cpulimit=${appliedCpuLimit}`;
      const storageSummary = appliedStorageGiB
        ? `, storage=+${appliedStorageGiB} GiB`
        : '';
      const taskSummary = [upid, storageTaskUpid].filter(
        (task): task is string => typeof task === 'string' && task.length > 0,
      );

      return {
        status: 'success' as const,
        message:
          taskSummary.length > 0
            ? `Updated ${kindLabel} ${selectedWorkload.id}${
                selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
              }: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary} — task${
                taskSummary.length > 1 ? 's' : ''
              } ${taskSummary.join(', ')}.`
            : `Updated ${kindLabel} ${selectedWorkload.id}${
                selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
              }: ${cpuSummary}, memory=${appliedMemoryMiB} MiB${storageSummary}.`,
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

      const { cloneUpid, startUpid } = await deployVmFromTemplate(
        templateId,
        templateNode.trim(),
        newName.trim(),
        ciUser.trim(),
        ciPassword as string,
      );

      return {
        status: 'success' as const,
        message: `Deploying "${newName.trim()}" — cloned VM is starting now.`,
        formType: 'vm-template',
        deployWorkloadName: newName.trim(),
        deployTaskNode: templateNode.trim(),
        deployTaskUpids: [cloneUpid, startUpid],
      };
    } catch (error) {
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
    } catch (error) {
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
      const { destroyUpid, stopUpid } = await executeDestroyAction(
        selectedWorkload.type,
        selectedWorkload.id,
        selectedWorkload.node,
        selectedWorkload.status,
      );
      const kindLabel = selectedWorkload.type === 'vm' ? 'VM' : 'container';
      const stopPrefix = stopUpid
        ? `Stopped ${kindLabel} ${selectedWorkload.id}${
            selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
          } — task ${stopUpid}. `
        : '';
      return {
        status: 'success' as const,
        message: `${stopPrefix}Destroyed ${kindLabel} ${selectedWorkload.id}${
          selectedWorkload.name ? ` (${selectedWorkload.name})` : ''
        } — task ${destroyUpid}.`,
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
    } catch (error) {
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
  const { createClient } = await import('./helpers.js');
  const client = await createClient();
  // TODO(pve-client): 'hostname' is a valid LXC config field but missing from
  // the generated PUT body type. Fix in pve-client types; cast for now.
  return await client.request('/nodes/{node}/lxc/{vmid}/config', 'PUT', {
    $path: { node: templateNode, vmid: templateId },
    $body: { hostname: newName } as Record<string, unknown>,
  });
}
