# Deploy Progress — Investigation Notes

**Date:** 2026-06-18
**Issue:** Ubuntu Desktop VM deployment stays stuck in "Deploying..." mode until the 10-minute hard cap expires.

## Root Cause Found

The docs (`PxMx-Admin-For-Datalab-Guide.md` §2.3.1) state that cloud-init `cicommand` should auto-install `qemu-guest-agent` on first boot. **But the deployment code never sets `cicommand`.**

`action-template-deployers.ts` → `deployVmFromTemplate()` does:
1. Clone VM template
2. Attach cloud-init disk (`ide2`) if missing
3. Set `ipconfig0=ip=dhcp` if missing
4. Set `agent=enabled=1` if not already set — **this only enables the virtio serial channel on the Proxmox side, does NOT install the agent inside the guest**
5. Set cloud-init username/password
6. Start the VM

The `cicommand` parameter was never implemented.

## Fix Applied

**File:** `src/routes/proxmox/action-template-deployers.ts`

Added `cicommand` to `configBody` so cloud-init installs the guest agent on first boot:

```typescript
configBody.cicommand = JSON.stringify([
  {
    command:
      'test -f /usr/sbin/qemu-ga || (apt-get update -qq && apt-get install -y qemu-guest-agent) && systemctl enable --now qemu-guest-agent',
  },
]);
```

## What This Fixes

- Newly deployed VMs from Ubuntu templates will now have `qemu-guest-agent` auto-installed via cloud-init on first boot
- IP addresses will be discoverable after the VM boots and the agent starts
-breaks the cycle where the VM has no agent → no IP → shows as `?`

## What This Does NOT Fix

The "deploying stuck" issue itself — the deployment state machine in `PxMxAdmin.svelte` resolves when:
- Tasks complete (clone + start)
- Workload appears in server VM list
- Minimum 30 seconds elapsed (hard cap: 10 minutes)

The user reported it stays deployed until the 10-minute cap. Two likely causes remain:

### Still to Investigate

1. **Workload not appearing in VM list**: The `isDeployResolved` check looks for the workload name in `vmWorkloadsFromServer`. If the VM name doesn't match or the VM fails to start, the workload won't appear and the deploying state persists until the 10-minute cap.

2. **Task stuck or failing silently**: `isTaskActive` returns `true` if a task has no `endtime` and status isn't `ok`/`stopped`/`error`/`warnings`. If task data is stale or missing from `recentTasks`, `isTaskActive` returns `undefined` which is neither `true` nor `false` — the code treats `undefined` as "not active" so `states.some(state => state === true)` is false.

3. **Name mismatch**: The workload name comparison is case-insensitive lowercase trimming. If the deployed name differs from the reported name, `workloadExists` will be false.

## Next Steps

- [ ] Verify the `cicommand` fix works on next deployment (requires redeploying from template)
- [ ] Check Proxmox task logs to see if clone/start tasks are actually completing
- [ ] Add debug logging to `isDeployResolved` to trace why the 10-minute cap is hit
- [ ] Consider: should the `cicommand` only be set for Debian/Ubuntu templates (not Windows/others)?
- [ ] Test with the Ubuntu Desktop template specifically to confirm the agent gets installed

## Key Files

| File | Purpose |
|------|---------|
| `src/routes/proxmox/action-template-deployers.ts` | VM deployment logic (fix applied here) |
| `src/PxMxAdmin.svelte` | Deploying state machine and resolution logic |
| `src/routes/proxmox/helpers.ts` | Guest agent error detection, client creation |
| `src/routes/proxmox/loadData.ts` | Data loading and guest agent handling |
| `PxMx-Admin-For-Datalab-Guide.md` | Documentation (contains the incorrect claim about cicommand) |
| `scripts/guest/install-guest-agent.sh` | Manual guest agent install script |
