# Akamai resources for CascadeIQ

**Status: proposed. Create nothing until Danny approves the region, size and price.** Prices are from the
workshop labs (02-linode, 03-database). Confirm them in Cloud Manager before clicking Create.

| Resource | Setting | Approx. cost | Why |
|---|---|---|---|
| Linode | Seattle, WA · Ubuntu 24.04 LTS · Shared CPU **Nanode 1 GB** · label `sea-cascadeiq-web` | ~$0.18/day | Hosts the public dashboard and API |
| Managed PostgreSQL | Seattle, WA · newest PostgreSQL · Shared CPU **Nanode 1 GB** · **1 node** · label `sea-cascadeiq-db` | ~$0.58/day | Saved audits behind `/runs/{uuid}` |
| Cloud Firewall | label `sea-cascadeiq-fw`, attached to the Linode | free | Limits inbound traffic |

Credits are not a spending cap. Delete everything after judging (bottom of this page).

## 1. Database (start first: ~8 min to become usable)

1. Cloud Manager → **Databases** → **Create Database Cluster** with the settings above.
2. **Manage Access → Specific Access**: add the venue's public IP (`echo "$(curl -s https://api.ipify.org)/32"`).
   After the Linode exists, add its IPv4 and IPv6 too.
3. When **Active** (+2 min for DNS), copy Host, Port, Password into `.env`:

```text
PGHOST=...
PGPORT=...
PGUSER=akmadmin
PGPASSWORD=...
PGDATABASE=defaultdb
PGSSLMODE=require
```

The `audit_runs` table is created automatically on the first save.

## 2. Linode

Cloud Manager → **Create → Linode** with the settings above. Add your SSH public key (`cat ~/.ssh/id_ed25519.pub`;
add Sahil's too if he will deploy). Under **Add User Data** paste:

```yaml
#cloud-config
ssh_pwauth: false
disable_root: false
runcmd:
  - curl -LsSf https://astral.sh/uv/0.13.8/install.sh | env HOME=/root sh
```

## 3. Firewall

**Different from the workshop default.** Judges open the link on their phones from other networks, so port 80
must be open to everyone. SSH stays limited to the team.

| Rule | Protocol | Port | Sources |
|---|---|---|---|
| Accept web | TCP | 80 | All IPv4, All IPv6 |
| Accept SSH | TCP | 22 | venue IP `/32` (and your home IP if needed) |
| Default inbound | | | **Drop** |

The app has no login and plain HTTP: use the demo data only, no real customer data.

## 4. Deploy

```bash
IP=<linode ipv4> bash deploy/deploy.sh
```

Logs: `ssh root@$IP journalctl -u cascadeiq -n 50`. Redeploy after changes with the same command.

## Cleanup after judging

1. Linodes → `sea-cascadeiq-web` → **Delete**.
2. Databases → `sea-cascadeiq-db` → Settings → **Delete Cluster**.
3. Firewalls → `sea-cascadeiq-fw` → **Delete**.
