#!/usr/bin/env bash
# G3 Workstation 一键部署脚本（Ubuntu 22.04, 以 root 执行）
set -eo pipefail

APP_DIR=/opt/g3-workstation
DB_NAME=g3_workspace
DB_PASS=g3password
NODE_PORT=3000

echo '==> 1/6 apt update + 安装 nginx / mysql-server / nodejs / npm / git'
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx mysql-server git curl ca-certificates
# 使用 NodeSource Node 20（Ubuntu 22.04 自带 node 为 12.x，太老）
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node -v; npm -v

echo '==> 2/6 初始化 MySQL 库表与 root 密码'
systemctl enable --now mysql
mysql -uroot <<SQL
ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY '${DB_PASS}';
FLUSH PRIVILEGES;
SQL
mysql -uroot -p"${DB_PASS}" < "${APP_DIR}/schema.sql"

echo '==> 3/6 安装后端依赖'
cd "${APP_DIR}"
export DB_USER=root DB_PASS="${DB_PASS}" DB_NAME="${DB_NAME}" PORT="${NODE_PORT}"
npm install --omit=dev

echo '==> 4/6 注册 systemd 服务'
cat >/etc/systemd/system/g3-workstation.service <<EOF
[Unit]
Description=G3 Workstation (Node.js + MySQL)
After=network.target mysql.service

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
Environment=DB_USER=root
Environment=DB_PASS=${DB_PASS}
Environment=DB_NAME=${DB_NAME}
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

echo '==> 5/6 配置 nginx 站点（静态 + /api 反代）'
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

echo '==> 6/6 校验'
sleep 1
curl -s http://127.0.0.1/api/data | head -c 200 && echo
curl -s -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1/
echo '部署完成，访问 http://虚拟机IP/ 即可使用'
