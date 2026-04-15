#!/bin/bash
set -e

VPS_HOST="209.38.164.154"
VPS_USER="${VPS_USER:-root}"
RELAY_DIR="/opt/betfair-relay"

echo "=== Deploying VPS Relay to ${VPS_HOST} ==="

echo "1. Building locally..."
cd "$(dirname "$0")"
npm run build 2>/dev/null || npx tsc

echo "2. Syncing files to VPS..."
ssh -o StrictHostKeyChecking=no "${VPS_USER}@${VPS_HOST}" "mkdir -p ${RELAY_DIR}"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .git \
  ./ "${VPS_USER}@${VPS_HOST}:${RELAY_DIR}/"

echo "3. Installing dependencies on VPS..."
ssh "${VPS_USER}@${VPS_HOST}" "cd ${RELAY_DIR} && npm install --production"

echo "4. Setting up systemd service..."
ssh "${VPS_USER}@${VPS_HOST}" "cat > /etc/systemd/system/betfair-relay.service << 'EOF'
[Unit]
Description=Betfair VPS Relay Service
After=network.target

[Service]
Type=simple
WorkingDirectory=${RELAY_DIR}
ExecStart=/usr/bin/node ${RELAY_DIR}/dist/index.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=-/opt/betfair-relay/.env

[Install]
WantedBy=multi-user.target
EOF"

echo "5. Restarting service..."
ssh "${VPS_USER}@${VPS_HOST}" "systemctl daemon-reload && systemctl enable betfair-relay && systemctl restart betfair-relay"

echo "6. Checking status..."
sleep 2
ssh "${VPS_USER}@${VPS_HOST}" "systemctl status betfair-relay --no-pager -l | head -20"

echo "=== Deploy complete ==="
