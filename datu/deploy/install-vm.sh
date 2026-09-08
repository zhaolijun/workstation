#!/usr/bin/env bash
set -euo pipefail
APP_DIR=${APP_DIR:-/opt/datu}
HOST=${1:-127.0.0.1}
PORT=${PORT:-8800}
mkdir -p "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone https://github.com/zhaolijun/workstation.git "$APP_DIR"
fi
cd "$APP_DIR/datu"
git pull --ff-only
mkdir -p data
cat > /etc/systemd/system/datu.service <<"EOF"
[Unit]
Description=DATU Workbench Backend
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR/datu
Environment=DATU_DB=$APP_DIR/datu/data/datu.db
Environment=DATU_ADMIN_USER=${DATU_ADMIN_USER:-ops}
Environment=DATU_ADMIN_PASSWORD=${DATU_ADMIN_PASSWORD:?set DATU_ADMIN_PASSWORD}
ExecStart=/usr/bin/python3 $APP_DIR/datu/backend/server.py --host $HOST --port $PORT
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now datu
systemctl restart datu
systemctl --no-pager --full status datu
