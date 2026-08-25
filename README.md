# 小学三年级学习工作台

前版是纯前端 localStorage 单文件应用，本版本将数据迁移到服务器 **MySQL**，由后端 Node.js (Express + mysql2) 提供 `/api/data` 接口读写；前端页面仍零依赖、纯内联。

## 架构

- **前端** `public/index.html`：单文件 HTML，boot 时从 `GET /api/data` 拉取全部数据；任何变更走 `POST /api/data/:key` 写入
- **后端** `server.js`：Express + mysql2，KV JSON 文档存储
- **库表** `schema.sql`：数据库 `g3_workspace`，表 `kv_store (k, v, updated_at)`
- **部署**：nginx 托管 `public/` 静态文件，`/api/` 反代到 node :3000，systemd 常驻

## 本地运行

```bash
mysql -uroot -p < schema.sql
export DB_USER=root DB_PASS=xxx
npm install
npm start          # http://localhost:3000
```

## Ubuntu 一键部署（root）
```bash
bash deploy.sh     # 自动装 nginx/mysql/node/pm2、建库、起服务
```
