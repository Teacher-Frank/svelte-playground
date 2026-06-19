# Deploy Progress — Investigation Notes

**Date:** 2026-06-18 → Updated 2026-06-19
**Issue:** Ubuntu Desktop VM deployment stays stuck in "Deploying..." mode until the 10-minute hard cap expires.

## Root Cause: Guest Agent Not Installed

The deployment flow needs `qemu-guest-agent` running inside the guest OS to discover IP addresses. The current code does:

1. Clone VM template
2. Attach cloud-init disk (`ide2`) if missing
3. Set `ipconfig0=ip=dhcp` if missing
4. Set `agent=enabled=1` if not already set — **this only enables the virtio serial channel on the Proxmox side, does NOT install the agent inside the guest**
5. Set cloud-init username/password
6. Start the VM

Without the agent binary installed in the guest, `agent=enabled=1` does nothing — there's no process on the other end of the serial channel to respond to queries.

## ❌ Fabricated Fix Discovered — `cicommand` Does Not Exist

**Update 2026-06-19:** A previous fix attempted to set `cicommand` on the VM config body, intending to have cloud-init install the guest agent on first boot. **This parameter does not exist in the Proxmox API and is silently ignored.**

### Verification

1. **Official Proxmox API docs** — No `cicommand` parameter in `/nodes/{node}/qemu/{vmid}/config` (verified via [pve-docs](https://pve.proxmox.com/pve-docs/api-viewer/#/nodes/{node}/qemu/{vmid}/config))
2. **pve-client type definitions** (`types.ts`) — No `cicommand` type exists
3. **Existing test** (`proxmox-actions.spec.ts` line 285) — Already documented: *"no cicommand - not a supported Proxmox API parameter"*

### Canary Test Created

Added `c:\hrgit\pve-client\tests\unit\qemuConfigCloudInit.test.ts`:
- Compile-time assertion that `cicommand` is NOT in the type definitions (will break if someone adds it)
- Confirms all valid cloud-init params (`cicustom`, `cipassword`, `citype`, `ciupgrade`, `ciuser`, `ipconfig[n]`, `nameserver`, `searchdomain`, `sshkeys`) DO exist
- All 11 tests pass ✓

### Valid Cloud-Init Parameters

| Parameter | Purpose |
|-----------|---------|
| `cicustom` | Path to custom cloud-init ISO that replaces auto-generated files |
| `cipassword` | Password for ciuser |
| `citype` | Format: configdrive2 / nocloud / opennebula |
| `ciupgrade` | Boolean — run apt upgrade on first boot (Linux only) |
| `ciuser` | Username for cloud-init |
| `ipconfig[n]` | IP address/gateway configuration |
| `nameserver` | DNS server IP |
| `searchdomain` | DNS search domains |
| `sshkeys` | Public SSH keys |

### Resolution

**Completed 2026-06-19:** Removed the `cicommand` line from `action-template-deployers.ts`. Replaced with a comment documenting that `agent=enabled=1` only opens the virtio serial channel and linking to this file for full context.

**Completed 2026-06-19:** Consolidated duplicate `expect(mocks.request)` assertions in `proxmox-actions.spec.ts` into a single assertion with commentary confirming `cicommand` is intentionally absent.

## ✅ Working Solution: `cicustom` with cloud-init `runcmd`

**Discovered 2026-06-19** via Proxmox documentation:
- [Proxmox cloud-init docs](https://pve.proxmox.com/pve-docs/pve-admin-guide.html#qm_cloud_init)
- [Proxmox QEMU Guest Agent wiki](https://pve.proxmox.com/wiki/Qemu-guest-agent)

### Why the original approach was wrong

The fabricated `cicommand` parameter was a confusion with cloud-init's `runcmd` directive. Proxmox doesn't expose `runcmd` directly as a VM config parameter — instead, you use `cicustom` to point to a custom cloud-init user-data file.

### How `cicustom` works

1. Create a YAML file (cloud-init user-data) on a Proxmox storage that supports `snippets` content type
2. The YAML includes an `runcmd` section with shell commands to run on first boot
3. Set `cicustom` on the VM config to point to the snippet

Example user-data YAML (`install-agent.yaml`):

```yaml
#cloud-config
runcmd:
  - >-
    test -f /usr/sbin/qemu-ga ||
    (apt-get update -qq && apt-get install -y qemu-guest-agent) &&
    systemctl enable --now qemu-guest-agent
```

Then in the Proxmox config:
```
qm set <vmid> --cicustom "user=local:snippets/install-agent.yaml"
```

Or via API, in the config body:
```typescript
configBody.cicustom = 'user=local:snippets/install-agent.yaml';
```

### Steps to implement in deployment flow

1. **Create the snippet file** — Deploy `install-agent.yaml` to the Proxmox `local:snippets` storage (one-time setup, could be baked into the Proxmox host provisioning)
2. **Set `cicustom`** in `configBody` during deployment alongside existing cloud-init params
3. **Cloud-init runs `runcmd`** on first boot, installing and enabling the guest agent

### Alternative approaches (ranked)

| Approach | Effort | Reliability | Notes |
|----------|--------|-------------|-------|
| **Pre-bake agent in template** | Medium | ★★★★★ | Install `qemu-guest-agent` in the gold image before making it a template. Still the gold standard. |
| **`cicustom` + `runcmd`** | Medium | ★★★★ | Point to a custom cloud-init YAML snippet with install commands. Works without modifying the template. |
| **Post-start via SSH** | High | ★★★ | After first boot, SSH in and install. Requires password auth + timing. |
| **Hookscript** | High | ★★★ | Proxmox-side hook script runs after VM start. Still needs the agent. |
| ~~Post-start agent exec~~ | — | ✗ | `/nodes/{node}/qemu/{vmid}/agent/exec` requires agent already running (chicken/egg) |
| ~~`ciupgrade`~~ | — | ✗ | `ciupgrade=true` upgrades packages but won't *install* new ones |

**Recommended for immediate fix:** `cicustom` with `runcmd` — works with existing templates.
**Recommended long-term:** Pre-bake the agent in the Ubuntu template image.

## Deploying State Machine — Still to Investigate

The "deploying stuck" issue persists regardless. The deployment state machine in `PxMxAdmin.svelte` resolves when:
- Tasks complete (clone + start)
- Workload appears in server VM list
- Minimum 30 seconds elapsed (hard cap: 10 minutes)

The user reported it stays deployed until the 10-minute cap. Two likely causes remain:

1. **Workload not appearing in VM list**: The `isDeployResolved` check looks for the workload name in `vmWorkloadsFromServer`. If the VM name doesn't match or the VM fails to start, the workload won't appear and the deploying state persists until the 10-minute cap.

2. **Task stuck or failing silently**: `isTaskActive` returns `true` if a task has no `endtime` and status isn't `ok`/`stopped`/`error`/`warnings`. If task data is stale or missing from `recentTasks`, `isTaskActive` returns `undefined` which is neither `true` nor `false` — the code treats `undefined` as "not active" so `states.some(state => state === true)` is false.

3. **Name mismatch**: The workload name comparison is case-insensitive lowercase trimming. If the deployed name differs from the reported name, `workloadExists` will be false.

## Next Steps

- [x] Confirm `cicommand` is not a valid Proxmox API parameter
- [x] Create canary test in pve-client to prevent recurrence
- [x] Remove dead `cicommand` code from `action-template-deployers.ts`
- [x] Create `scripts/host/deploy-cloudinit-snippets.sh` host setup script
- [x] Add `configBody.cicustom` to deploy flow with `PVE_SNIPPET_STORAGE` env var
- [x] Update `PxMx-Admin-For-Datalab-Guide.md` §2.3 with correct guest agent instructions
- [ ] Test full deploy flow end-to-end (snippet install → cicustom → agent detected → IP shown)
- [ ] Install `qemu-guest-agent` in the Ubuntu Desktop template image (pre-bake approach)
- [ ] Check Proxmox task logs to see if clone/start tasks are actually completing
- [ ] Add debug logging to `isDeployResolved` to trace why the 10-minute cap is hit

## Policy Added

**P2c: Unknown API Surface Validation** — Added to `POLICIES.md`. Before using an external API parameter/endpoint that hasn't been verified, write a test that proves it exists.

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/proxmox/action-template-deployers.ts` | VM deployment logic (cicustom wired in, PVE_SNIPPET_STORAGE env var) |
| `scripts/host/deploy-cloudinit-snippets.sh` | Host setup script — deploys install-agent.yaml to /var/lib/vz/snippets (new) |
| `src/PxMxAdmin.svelte` | Deploying state machine and resolution logic |
| `src/routes/proxmox/helpers.ts` | Guest agent error detection, client creation |
| `src/routes/proxmox/loadData.ts` | Data loading and guest agent handling |
| `pve-client/tests/unit/qemuConfigCloudInit.test.ts` | Canary test for cloud-init API surface (new) |
| `tests/lib/server/proxmox-actions.spec.ts` | Playground test (consolidated assertions, updated comment) |
| `POLICIES.md` | P2c: Unknown API Surface Validation (new) |
| `PxMx-Admin-For-Datalab-Guide.md` | Admin guide §2.3 updated with cicustom option |
| `scripts/guest/install-guest-agent.sh` | Manual guest agent install script (fallback) |

## Implementation Details

### Deploy flow (action-template-deployers.ts)

```typescript
const snippetStorage = process.env.PVE_SNIPPET_STORAGE?.trim() || 'local';
// ...
configBody.cicustom = `user=${snippetStorage}:snippets/install-agent.yaml`;
```

### Host setup (scripts/host/deploy-cloudinit-snippets.sh)

```bash
# Default storage: local
sudo bash scripts/host/deploy-cloudinit-snippets.sh

# Custom storage
PVE_SNIPPET_STORAGE=fast-ssd sudo bash scripts/host/deploy-cloudinit-snippets.sh
```

### Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `PVE_SNIPPET_STORAGE` | `local` | Proxmox storage ID for cloud-init snippets |
| `PVE_VM_CLOUDINIT_STORAGE` | `local-lvm` | Proxmox storage ID for cloud-init disks (existing) |
