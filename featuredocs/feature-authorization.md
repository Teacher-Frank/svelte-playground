# Authorization — Requirements & Design

**Date:** 2026-07-01
**Scope:** Multi-user authorization layer for PxMxAdmin — authentication, role-based privileges, workload scoping, and ownership tracking.

---

## Problem Statement

PxMxAdmin currently has **no multi-user support** — it uses a single Proxmox credential (via environment variables) with unrestricted access. We need to:

1. **Authenticate** individual users (login, session, logout)
2. **Control what buttons they can push** — *privileges* (start, stop, deploy, destroy, terminal, VNC, etc.)
3. **Filter which workloads they can see** — per-user/workload visibility
4. **Track workload ownership** — so we can calculate resource usage per user

---

## Requirements

### R1 — External Authentication
- **Authentication is handled externally** — either by Proxmox itself or by an SSO provider
- **No passwords are stored** in the authorization database
- On successful external auth, the app receives an identity (username) and looks up that user's authorization data in the local DB
- Sessions and logout are managed by the external auth system (Proxmox token / SSO session)

### R2 — Privileges (Button Control)
- Each user has a set of privileges that determine which actions they can take
- Privileges are checked before rendering action buttons or before executing actions
- Privilege granularity:
  - **Global**: affects all workloads (e.g., "can deploy any VM")
  - **Scoped**: applies to specific workloads or groups (e.g., "can restart VM-101")

#### Known Privileges (working list)

| Privilege | Description | Scope |
|-----------|-------------|-------|
| `vm:start` | Start a VM | Scoped |
| `vm:stop` | Stop a VM (shutdown) | Scoped |
| `vm:shutdown` | Graceful shutdown | Scoped |
| `vm:reset` | Hard reset | Scoped |
| `vm:destroy` | Destroy a VM | Scoped |
| `vm:create` | Deploy a new VM | Global |
| `vm:terminal` | Access terminal | Scoped |
| `vm:vnc` | Access VNC console | Scoped |
| `lxc:start` | Start a container | Scoped |
| `lxc:stop` | Stop a container | Scoped |
| `lxc:shutdown` | Graceful shutdown | Scoped |
| `lxc:reset` | Hard reset | Scoped |
| `lxc:destroy` | Destroy a container | Scoped |
| `lxc:create` | Deploy a new container | Global |
| `lxc:terminal` | Access terminal | Scoped |
| `dashboard:view` | View dashboard | Global |
| `template:view` | View templates | Global |

### R3 — Workload Visibility (Filter)
- Each user sees only the workloads they are authorized to see
- Implemented as a filter on the workload list
- A user may be assigned to specific VMs/LXCs, or to groups that contain them

### R4 — Ownership & Resource Tracking
- Each workload has a clear owner (user)
- System can calculate total resources (CPU, RAM, disk) claimed by each user
- Resource usage reports/summaries can be generated per user

---

## Design — Options to Evaluate

### Option A: Proxmox ACL Integration (Native)

Proxmox already has a built-in PAM/ACL system with roles, users, and permissions mapped to paths (`/vms/101`, `/nodes`, etc.).

**Pros:**
- Already exists on Proxmox — single source of truth
- Can use Proxmox API (`/access/acl`, `/access/groups`, `/access/roles`, `/access/users`)
- No additional database needed for authZ data

**Cons:**
- Proxmox ACL paths may not map 1:1 to our privilege model (e.g., no concept of "can deploy")
- Proxmox roles are fixed (PVEVMUser, PVEVMAdmin, PVEDatastoreAdmin, etc.) — not fully customizable
- Need to query Proxmox API on every request or cache aggressively
- Proxmox PAM users ≠ app-level users (may need dual user stores)

### Option B: PostgreSQL — Custom AuthZ Database

Dedicated database to store users, roles, privileges, workload assignments, and audit history.

**Pros:**
- Full control over schema and privilege model
- Relational integrity for user → role → privilege chains
- Ownership tracking and resource calculations are natural with SQL
- Audit logging is straightforward
- Works alongside Proxmox (app-level layer)

**Cons:**
- New infrastructure to maintain
- Need to sync with Proxmox user store OR maintain separate users
- Synchronization complexity (if a workload is moved/destroyed in Proxmox)

### Option C: PostgreSQL + Proxmox ACL Hybrid

Use PostgreSQL for app-level authorization (privileges, ownership, history) while syncing Proxmox ACLs from it.

**Pros:**
- Best of both — custom privileges + Proxmox integration
- Single source of truth

**Cons:**
- Most complex to implement
- Sync logic must be reliable (drift detection, conflict resolution)

### Option D: External Auth (Keycloak / Authentik)

Use an IAM/SSO solution that provides both authentication and fine-grained authorization.

**Pros:**
- Enterprise-grade SSO (SAML, OIDC, MFA out of the box)
- Policy engine for complex rules
- Audit trails, user management UI

**Cons:**
- Heavy infrastructure overhead (Docker container, JVM, etc.)
- May be overkill for a datascale app
- Learning curve

---

## Design Decision

### Chosen Approach: **[TBD — evaluate options above]**

### Rationale:
- *To be determined after evaluation.*

---

## Schema (Working Draft)

> **This database stores authorization data only. Authentication (login/passwords/SSO) is handled externally by Proxmox or an SSO solution. No credentials or password hashes are ever stored here.**

### Authorization Tables

```sql
-- Core identity (authorization profile linked to externally-authenticated users)
users (
    id          SERIAL PRIMARY KEY,
    username    VARCHAR(100) UNIQUE NOT NULL,   -- matches Proxmox/SSO username
    email       VARCHAR(255),
    active      BOOLEAN DEFAULT TRUE,
    created_at  TIMESTAMP DEFAULT NOW()
);

roles (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) UNIQUE NOT NULL,   -- 'admin', 'operator', 'viewer'
    description TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);

user_roles (
    user_id     INT REFERENCES users(id) ON DELETE CASCADE,
    role_id     INT REFERENCES roles(id) ON DELETE CASCADE,
    granted_at  TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

-- Privileges are defined on roles
role_privileges (
    role_id         INT REFERENCES roles(id) ON DELETE CASCADE,
    privilege       VARCHAR(100) NOT NULL,      -- 'vm:start', 'vm:destroy', etc.
    scope_type      VARCHAR(50) DEFAULT 'global', -- 'global' | 'own' | 'scoped'
    scope_path      TEXT,                        -- '/vms/101' for scoped, NULL for global/own
    PRIMARY KEY (role_id, privilege, scope_path)
);
```

### Workload Tables

```sql
-- Cache of Proxmox workload state (read from Proxmox, not editable)
workload_config (
    vm_id          INT NOT NULL,
    workload_type  VARCHAR(10) NOT NULL,         -- 'vm' | 'lxc'
    node_name      VARCHAR(100) NOT NULL,
    name           VARCHAR(255),
    status         VARCHAR(20),                  -- 'running', 'stopped'
    -- Resource allocation (from config, not runtime)
    cpu_cores      INT,                          -- sockets * cores
    ram_mb         INT,                          -- memory field from config
    disk_gb        NUMERIC(10, 2),               -- sum of disk sizes
    -- Proxmox metadata
    has_guest_agent BOOLEAN DEFAULT FALSE,
    tags           TEXT,
    -- Sync metadata
    last_seen      TIMESTAMP DEFAULT NOW(),
    config_hash    TEXT,                         -- detect changes from Proxmox config digest
    created_at     TIMESTAMP DEFAULT NOW(),
    PRIMARY KEY (vm_id, workload_type)
);

-- Snapshot history: written before each config upsert when config_hash changes
workload_config_history (
    id            BIGSERIAL PRIMARY KEY,
    vm_id         INT NOT NULL,
    workload_type VARCHAR(10) NOT NULL,          -- 'vm' | 'lxc'
    node_name     VARCHAR(100) NOT NULL,
    name          VARCHAR(255),
    status        VARCHAR(20),
    cpu_cores     INT,
    ram_mb        INT,
    disk_gb       NUMERIC(10, 2),
    has_guest_agent BOOLEAN DEFAULT FALSE,
    tags          TEXT,
    config_hash   TEXT,
    event_type    VARCHAR(50) NOT NULL,          -- 'created', 'updated', 'orphaned'
    change_reason TEXT,                          -- 'periodic-sync', 'manual'
    recorded_at   TIMESTAMP DEFAULT NOW()
);

-- Ownership (managed entirely by our app)
workload_ownership (
    vm_id          INT NOT NULL,
    workload_type  VARCHAR(10) NOT NULL,         -- 'vm' | 'lxc'
    user_id        INT REFERENCES users(id) ON DELETE SET NULL,
    assigned_at    TIMESTAMP DEFAULT NOW(),
    assigned_by    INT REFERENCES users(id),     -- which admin assigned it
    PRIMARY KEY (vm_id, workload_type),
    FOREIGN KEY (vm_id, workload_type) REFERENCES workload_config(vm_id, workload_type) ON DELETE CASCADE
);

-- Ownership change trail
workload_ownership_history (
    id            BIGSERIAL PRIMARY KEY,
    vm_id         INT NOT NULL,
    workload_type VARCHAR(10) NOT NULL,          -- 'vm' | 'lxc'
    user_id       INT REFERENCES users(id),
    change_type   VARCHAR(50) NOT NULL,          -- 'assigned', 'reassigned', 'revoked'
    changed_by    INT REFERENCES users(id),      -- which admin made the change
    recorded_at   TIMESTAMP DEFAULT NOW()
);

-- Action audit log
audit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     INT REFERENCES users(id),
    action      VARCHAR(200) NOT NULL,           -- 'vm:start', 'vm:destroy'
    vm_id       INT,
    workload_type VARCHAR(10),
    result      VARCHAR(50),                     -- 'success' | 'denied' | 'error'
    details     TEXT,
    created_at  TIMESTAMP DEFAULT NOW()
);
```

### Queries

#### Resource Usage (Current)

```sql
-- Total CPU/RAM/disk claimed per user (current snapshot)
SELECT
    u.username,
    COUNT(vo.vm_id) AS workload_count,
    SUM(wc.cpu_cores) AS total_cpus,
    SUM(wc.ram_mb) AS total_ram_mb,
    SUM(wc.disk_gb) AS total_disk_gb
FROM workload_ownership vo
JOIN users u ON u.id = vo.user_id
JOIN workload_config wc ON wc.vm_id = vo.vm_id
                       AND wc.workload_type = vo.workload_type
GROUP BY u.username
ORDER BY total_ram_mb DESC;
```

#### Resource Usage (Historical)

```sql
-- Resource usage for a user over a time range (by config changes)
SELECT
    u.username,
    wc_hist.recorded_at,
    wc_hist.cpu_cores,
    wc_hist.ram_mb,
    wc_hist.disk_gb,
    wc_hist.status
FROM workload_config_history wc_hist
JOIN workload_ownership o ON o.vm_id = wc_hist.vm_id
                         AND o.workload_type = wc_hist.workload_type
JOIN users u ON u.id = o.user_id
WHERE u.username = 'bob'
  AND wc_hist.recorded_at BETWEEN '2026-01-01' AND '2026-07-01'
ORDER BY wc_hist.recorded_at;
```

#### Workload Lifecycle Timeline

```sql
-- Full lifecycle of a workload (create → config changes → ownership → destroy)
SELECT * FROM (
    -- Ownership events
    SELECT
        vm_id, workload_type,
        change_type AS event_type,
        user_id,
        NULL::INT AS cpu_cores, NULL::INT AS ram_mb,
        recorded_at,
        'ownership' AS category
    FROM workload_ownership_history
    UNION ALL
    -- Config/sync events
    SELECT
        vm_id, workload_type,
        event_type,
        NULL::INT AS user_id,
        cpu_cores, ram_mb,
        recorded_at,
        'config' AS category
    FROM workload_config_history
) AS timeline
WHERE vm_id = 101
ORDER BY recorded_at;
```

---

## Workload Sync Strategy

Proxmox has **no pub/sub or event stream** for workload changes. Sync happens in two layers:

### Layer 1 — Periodic Full Sync (Proxmox → DB)

Runs every **30–60 seconds** from a background task:

```
1. GET /cluster/resources?type=qemu   — VM list (vmid, node, name, status)
2. GET /cluster/resources?type=lxc    — LXC list (vmid, node, name, status)
3. For each workload:
     GET /nodes/{node}/{type}/{vmid}/config — detailed config (cores, memory, disks)
4. Compare config_hash → if changed, write snapshot to workload_config_history
5. Upsert workload_config
6. Mark workloads not found as "orphaned" after 5-minute grace period
7. Permanently delete orphaned workloads (CASCADE deletes ownership)
```

**This handles external changes** — workloads created/destroyed in Proxmox Web UI, CLI, or via other tools that bypass our app.

### Layer 2 — Immediate Sync on Our Actions (App → DB)

When **our app** performs an action through Proxmox, the DB is updated immediately:

| Our Action | Immediate DB Update | Then Periodic Sync Confirms |
|------------|---------------------|-----------------------------|
| Deploy VM/LXC | `INSERT workload_config` (pending) → `INSERT workload_ownership` | Confirms config from Proxmox |
| Destroy VM/LXC | `DELETE workload_ownership` (keep config for history) | `DELETE workload_config` if gone from Proxmox |
| Assign workload | `UPDATE workload_ownership SET user_id` | N/A |
| Revoke ownership | `UPDATE workload_ownership SET user_id = NULL` | N/A |
| Modify config | N/A — periodic sync picks it up next cycle | Updates config + writes history |

### Sync Flow

```
┌─────────────────────────────────────┐    ┌─────────────────────────────────────┐
│  periodic-sync.ts (every 30s)       │    │  action-executors.ts (user actions)  │
│                                     │    │                                     │
│  1. Fetch cluster resources         │    │  Deploy  → INSERT config + ownership  │
│  2. Fetch each workload config      │    │  Destroy → DELETE ownership then cfg  │
│  3. Write diffs to _history tables  │    │  Assign  → UPDATE ownership.user_id   │
│  4. Upsert workload_config          │    │  Revoke   → UPDATE user_id = NULL     │
│  5. Handle orphans                  │    │                                     │
└────────────┬────────────────────────┘    └───────────────────┬─────────────────┘
             │                                                  │
             │                     SQL upserts/deletes                   │
             ▼                                                  ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  PostgreSQL                                                                   │
│  — workload_config (Proxmox mirror)                                             │
│  — workload_config_history (change snapshots)                                   │
│  — workload_ownership (app-managed)                                             │
│  — workload_ownership_history (audit trail)                                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Svelte Client (UI Layer)                                   │
│  — Login (redirect to Proxmox SSO / external auth)          │
│  — Button visibility: disabled/hidden based on privileges   │
│  — Workload list: filtered by user's assigned workloads     │
│  — Resource usage dashboard (current + historical)          │
│  — Workload timeline viewer                                 │
└───────────────────────────┬─────────────────────────────────┘
                            │ /api/privileges, /api/workloads
                            │ /api/workloads/{id}/history
                            │ /api/user/{id}/resources
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  SvelteKit Server (Authorization Gateway)                   │
│  — Session middleware: validates external auth token        │
│  — canUser(userId, privilege, scope?): returns boolean      │
│  — getWorkloadsForUser(userId): returns filtered list       │
│  — Proxy to Proxmox API (only if authorized)               │
│  — Audit logging (write to audit_log)                       │
│  — Workload sync (write to workload_config + history)       │
└───────────────────────────┬─────────────────────────────────┘
                            │ SQL queries
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  PostgreSQL (Authorization Store)                           │
│  — users, roles, user_roles, role_privileges                │
│  — workload_config, workload_config_history                 │
│  — workload_ownership, workload_ownership_history           │
│  — audit_log                                                │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1 — Database & Auth Foundation
- [ ] PostgreSQL instance setup
- [ ] Apply schema (users, roles, role_privileges)
- [ ] External auth integration (Proxmox token or SSO)

### Phase 2 — Roles & Privileges
- [ ] Seed default roles (admin, operator, viewer)
- [ ] Role assignment (admin API)
- [ ] `canUser()` authorization check middleware
- [ ] Button visibility in UI based on privileges

### Phase 3 — Workload Sync
- [ ] `workload_config` table + periodic sync task (30s)
- [ ] `workload_config_history` — write snapshot on change
- [ ] Parse Proxmox config → extract CPU/RAM/disk
- [ ] Orphan detection (grace period + cleanup)
- [ ] Immediate sync on deploy/destroy actions

### Phase 4 — Workload Scoping & Ownership
- [ ] `workload_ownership` table
- [ ] `workload_ownership_history` — log ownership changes
- [ ] Assign/revoke workload ownership (admin API)
- [ ] Filter workload list per user
- [ ] Scoped privilege checks (canUser + ownership)

### Phase 5 — Resource Tracking
- [ ] Current resource usage per-user queries
- [ ] Resource usage dashboard (aggregated by user)
- [ ] Historical resource usage queries from `_history` tables

### Phase 6 — Audit & History Viewer
- [ ] Log all privileged actions to `audit_log`
- [ ] Audit log viewer UI
- [ ] Workload lifecycle timeline UI
- [ ] Historical resource trend viewer

---

## Open Questions

1. **SSO or local auth?** Can we integrate with an existing SSO (Keycloak, LDAP, etc.) or do users authenticate directly?
2. **Proxmox ACL sync?** Should we read/write Proxmox ACLs to keep them in sync, or is authorization purely app-level?
3. **Admin UI?** Do we need an admin panel for managing users/roles, or is this CLI-only?
4. **Organization/groups?** Do we need org/group scoping (e.g., a team owns a set of workloads)?
5. **Self-service?** Should users be able to invite other users, or is this admin-only?
6. **Sync interval?** Is 30s polling fast enough, or do we need a manual "sync now" trigger?
7. **External Proxmox changes?** Should the app warn admin if workloads are created/modified outside of PxMxAdmin (e.g., via Proxmox Web UI or CLI)?
