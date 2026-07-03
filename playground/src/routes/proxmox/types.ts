/**
 * Shared type definitions for the Proxmox admin page.
 *
 * This module groups every public and internal type used by `loadData.ts`,
 * `helpers.ts`, and `actions.ts` so that the three modules can stay focused
 * on their respective behaviours without type-surface drift.
 */

/** The kind of Proxmox guest workload: a QEMU virtual machine or an LXC container. */
export type WorkloadKind = 'vm' | 'container';

/** A power-control action that can be applied to a workload. */
export type WorkloadAction = 'start' | 'stop' | 'restart';

/** A Proxmox guest workload (VM or LXC container) as returned by the API list endpoints. */
export interface Workload {
  /** Numeric or string VMID / container ID. */
  id?: number | string;
  /** Human-readable name of the workload. */
  name?: string;
  /** Name of the cluster node that owns this workload. */
  node?: string;
  /** Current power status (e.g. `"running"`, `"stopped"`). */
  status?: string;
  /** Seconds the workload has been running, or `0` when stopped. */
  uptime?: number;
  /** Primary IPv4 address discovered from guest interfaces, when available. */
  primaryIp?: string;
  /** Configured CPU limit for containers, when available from API payloads. */
  cpulimit?: number;
  /** Configured memory limit for containers, in bytes when available. */
  memorylimit?: number;
  /** Host CPU core count for the workload node. */
  hostMaxCpu?: number;
  /** Host memory capacity (bytes) for the workload node. */
  hostMaxMemory?: number;
  /** Host storage capacity (bytes) for the workload node. */
  hostMaxStorage?: number;
  /** Currently available host storage (bytes) for the workload node. */
  hostAvailableStorage?: number;
}

export interface LxcIpAddress {
  'ip-address'?: string;
  'ip-address-type'?: string;
  prefix?: number;
}

export interface LxcInterface {
  inet?: string;
  'ip-addresses'?: LxcIpAddress[];
  name?: string;
}

export interface VmAgentInterface {
  name?: string;
  'ip-addresses'?: LxcIpAddress[];
}

/** A Proxmox cluster node as returned by the `/nodes` API endpoint. */
export interface ClusterNode {
  /** Node hostname. */
  node?: string;
  /** Node availability status (e.g. `"online"`, `"offline"`). */
  status?: string;
  /** Host CPU core count. */
  maxcpu?: number;
  /** Host memory capacity in bytes. */
  maxmem?: number;
  /** Host storage capacity in bytes. */
  maxdisk?: number;
  /** Host storage currently used in bytes. */
  disk?: number;
}

/** An LXC container template available in Proxmox storage. */
export interface LxcTemplate {
  /** Storage pool that holds the template. */
  storage: string;
  /** Full volume identifier (e.g. `local:vztmpl/debian-12-standard_12.7-1_amd64.tar.zst`). */
  volid: string;
  /** Archive format of the template image. */
  format: string;
  /** Uncompressed template size in bytes. */
  size: number;
  /** Content type tag (typically `"vztmpl"`). */
  content: string;
  /** Optional human-readable notes stored with the template. */
  notes?: string;
  /** Parent snapshot identifier, if applicable. */
  parent?: string;
  /** Creation timestamp (Unix epoch seconds). */
  ctime?: number;
  /** Disk space currently used by the template in bytes. */
  used?: number;
  /** VMID of a running container derived from this template, if any. */
  vmid?: number;
}

/** A single entry from the Proxmox task log. */
export interface RecentTask {
  /** Short task identifier. */
  id: string;
  /** Node that executed the task. */
  node: string;
  /** Task start time (Unix epoch seconds). */
  starttime: number;
  /** Task end time (Unix epoch seconds), absent while the task is still running. */
  endtime?: number;
  /** Final status string (e.g. `"OK"`) once the task has finished. */
  status?: string;
  /** Task type key (e.g. `"qmstart"`, `"vzstop"`). */
  type: string;
  /** User that triggered the task. */
  user: string;
  /** Unique Process ID string used by Proxmox to track the task. */
  upid: string;
}

/**
 * Aggregated data returned by `load` to the SvelteKit page.
 * When the Proxmox API is unreachable, all list fields are empty and
 * `serverStatus` is `"unavailable"`.
 */
export interface ProxmoxResults {
  /** Hostname extracted from `PVE_BASE_URL` for display purposes. */
  apiHost: string;
  /** Value of the `PVE_NODE` environment variable (may be `"unknown"`). */
  configuredNode: string;
  /** `true` when `configuredNode` matches an online cluster node. */
  configuredNodeExists: boolean;
  /** Hostname of the cluster node actually used for API calls. */
  serverNode: string;
  /** Whether guest GUI/VNC access is configured via an external bridge (for containers and VMs). */
  guestGuiBridgeSupported: boolean;
  /** Human-readable server availability string (e.g. `"online"`, `"unavailable"`). */
  serverStatus: string;
  /** Default auto-refresh interval for the admin page (seconds). */
  refreshIntervalSeconds: number;
  /** Timestamp of the most recent successful data refresh, or `null` on first failure. */
  lastSuccessfulRefresh: number | null;
  /** Raw node list from the Proxmox `/nodes` endpoint. */
  nodes: unknown;
  /** Raw version object from the Proxmox `/version` endpoint. */
  version: unknown;
  /** Raw cluster status object from the Proxmox `/cluster/status` endpoint. */
  cluster: unknown;
  /** Sorted list of QEMU virtual machines across all nodes. */
  vms: Workload[];
  /** Sorted list of LXC containers across all nodes. */
  containers: Workload[];
  /** Available LXC container templates found in storage. */
  lxcTemplates: LxcTemplate[];
  /** Most-recent task log entries from the cluster. */
  recentTasks: RecentTask[];
  /** Server-generated notifications (e.g., DHCP→static IP conversions) for one-time display. */
  notifications: string[];
}
