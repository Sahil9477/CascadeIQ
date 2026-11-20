#!/usr/bin/env bash
# Copy the app to the Linode and (re)start it. Run from the repo root:
#   IP=203.0.113.10 bash deploy/deploy.sh
# Needs: your SSH key on the Linode, uv installed there (the cloud-init block in deploy/PROVISIONING.md does it),
# and a filled-in .env in the repo root. .env is copied over SSH and never committed.
set -euo pipefail
: "${IP:?set IP to the public IPv4 address of the Linode}"
[ -f .env ] || { echo "No .env in the repo root"; exit 1; }

ssh -o StrictHostKeyChecking=accept-new "root@$IP" "mkdir -p /root/cascadeiq"
# Copy code without .git, local envs or caches; then the .env separately.
tar --exclude=.git --exclude=.venv --exclude=__pycache__ --exclude=.env -czf - . | ssh "root@$IP" "tar -xzf - -C /root/cascadeiq"
scp -q .env "root@$IP:/root/cascadeiq/.env"
ssh "root@$IP" "chmod 600 /root/cascadeiq/.env && cp /root/cascadeiq/deploy/cascadeiq.service /etc/systemd/system/ \
  && systemctl daemon-reload && systemctl enable --now cascadeiq && systemctl restart cascadeiq"

echo "Waiting for the app (first start downloads packages)..."
for _ in $(seq 1 30); do
  if curl -fsS "http://$IP/api/health"; then echo; echo "Live: http://$IP/"; exit 0; fi
  sleep 3
done
echo "Not answering yet. Check: ssh root@$IP journalctl -u cascadeiq -n 50"
exit 1
