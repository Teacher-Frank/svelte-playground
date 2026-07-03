# Ubuntu 24.04 LXC Template Issue

## Issue

The Proxmox Ubuntu 24.04 LXC template `vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst`
has known reports of containers coming up without a working interactive console and,
in some cases, without networking.

This matches the observed behavior in this playground: Debian template deployments
work, while Ubuntu 24.04 deployments can start without usable terminal interaction.

## Findings

- Proxmox added Ubuntu 24.04 support in `pve-container`.
- Proxmox also added a follow-up netplan-related fix for Ubuntu `>= 23.04`.
- In the Proxmox forum thread `Ubuntu 24.04 - unsupported Ubuntu version '24.04'`,
  staff and users reported that even the `24.04-2` template could still show
  `no network and no console` behavior.
- Proxmox staff reproduced the issue for privileged containers.
- Proxmox staff stated that recent Ubuntu 24.04 templates require the `nesting`
  feature because of newer `systemd` behavior.
- Proxmox staff also stated that for unprivileged containers, enabling `nesting`
  should not carry the same security concern as `privileged + nesting`.

## Practical Solution

For Ubuntu 24.04 template deployments in this app:

1. Explicitly create the CT as `unprivileged`.
2. Explicitly enable `features: nesting=1`.

This avoids relying on host defaults and aligns the deployment path with the
documented Proxmox workaround and guidance.

## Security Note

`privileged + nesting` is specifically warned against by Proxmox staff because it
weakens isolation substantially.

This app therefore avoids that combination for Ubuntu 24.04 template deployment
and forces the safer `unprivileged + nesting` combination instead.

## Related links

- Proxmox Container Toolkit documentation: https://pve.proxmox.com/pve-docs/chapter-pct.html
- Proxmox forum thread: https://forum.proxmox.com/threads/ubuntu-24-04-unsupported-ubuntu-version-24-04.146454/
- Proxmox commit adding Ubuntu 24.04 support: https://git.proxmox.com/?p=pve-container.git;a=commitdiff;h=3d800f832c25e4bf2435d88ab190fd8e681a67b1
- Proxmox commit adjusting Ubuntu netplan handling: https://git.proxmox.com/?p=pve-container.git;a=commit;h=dfcbad017361d4e3ded20af573fbaeacc05231eb
