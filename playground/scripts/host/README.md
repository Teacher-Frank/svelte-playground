# Host Scripts

These scripts run **on the Proxmox host** (SSH into your Proxmox machine), **not** inside a guest VM or container.

| Script | Purpose |
|---|---|
| `setup-hookscript.sh` | Creates the LXC post-create hook script that configures device passthrough for VNC |
| `setup-vm-template.sh` | Prepares a downloaded VM template with guest agent, network, and cloud-init drive |

## Usage

```bash
# Install LXC hook script
sudo bash setup-hookscript.sh

# Prepare a VM template (defaults: bridge=vmbr0, cloudinit-storage=local-lvm)
sudo bash setup-vm-template.sh 9001

# Prepare with custom bridge and storage
sudo bash setup-vm-template.sh 9001 vmbr1 fast-ssd
```
