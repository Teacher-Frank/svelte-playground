/**
 * Thin re-export stub for the Proxmox admin page server module.
 *
 * All logic has been extracted into focused sub-modules:
 *
 * - `types.ts`             — Shared type definitions (Workload, ClusterNode, etc.)
 * - `helpers.ts`           — Utility helpers, constants, and shared state
 * - `loadData.ts`          — Proxmox data loading and SvelteKit `load` export
 * - `proxmox-actions.ts`   — Form actions and SvelteKit `actions` export
 */

export type { WorkloadKind, WorkloadAction } from './types.js';
export type {
  Workload,
  ClusterNode,
  LxcTemplate,
  RecentTask,
  ProxmoxResults,
} from './types.js';
export { load } from './loadData.js';
export { actions } from './proxmox-actions.js';