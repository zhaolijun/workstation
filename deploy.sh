#!/usr/bin/env bash
# G3 Workstation 一键部署脚本（Ubuntu 22.04, 以 root 执行）
# 架构：nginx + Node.js + SQLite（文件数据库，免安装）
set -eo pipefail

APP_DIR=/opt/g3-workstation
NODE_PORT=3000

echo '==> 1/5 apt update + 安装 nginx / nodejs / git / curl / build-essential'
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx git curl ca-certificates build-essential python3

# Node 20 LTS（better-sqlite3 需要 Node 14+，自带 npm）
if ! command -v node >/dev/null 2>&1 || [ "$(node -v 2>/dev/null | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v; npm -v

echo '==> 2/5 安装后端依赖（better-sqlite3 auto build）'
cd "${APP_DIR}"
npm install --omit=dev

echo '==> 3/5 注册 systemd 服务'
cat >/etc/systemd/system/g3-workstation.service <<EOF
[Unit]
Description=G3 Workstation (Node.js + SQLite)
After=network.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=PORT=${NODE_PORT}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now g3-workstation
systemctl restart g3-workstation

echo '==> 4/5 配置 nginx 站点（静态 + /api 反代）'
cat >/etc/nginx/sites-available/g3-workstation <<EOF
server {
    listen 80 default_server;
    server_name _;

    root ${APP_DIR}/public;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:${NODE_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    }

    location / {
        try_files \$uri \$uri/ =404;
    }

    gzip on;
    gzip_types text/html application/javascript application/json;
}
EOF
ln -sf /etc/nginx/sites-available/g3-workstation /etc/nginx/sites-enabled/g3-workstation
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo '==> 5/5 校验'
sleep 2
curl -s http://127.0.0.1:${NODE_PORT}/api/data | head -c 200 && echo
curl -s -o /dev/null -w 'nginx / -> HTTP %{http_code}\n' http://127.0.0.1/
echo ''
echo '部署完成! 访问地址：http://$(curl -s ifconfig.me 2>/dev/null || hostname -I | awk "{print \$1}")/'
echo '数据文件: ${APP_DIR}/data.sqlite'
