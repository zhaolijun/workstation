# 小学三年级学习工作台

纯前端的 localStorage 版本已迁移为「**Node.js + SQLite**」后端持久化方案，前端页面零依赖纯内联。

## 架构

- **前端** `public/index.html`：单文件 HTML，启动时 `GET /api/data` 拉取全量数据，变更走 `POST /api/data/:key`
- **后端** `server.js`：Express + better-sqlite3，KV JSON 文档存储
- **存储** `data.sqlite`：SQLite 文件数据库（首次启动自动建表，免安装）
- **部署**：nginx 托管静态文件，`/api/` 反代到 node :3000，systemd 常驻

## 本地运行

```bash
npm install
npm start          # http://localhost:3000
# 数据落在 ./data.sqlite
```

## Ubuntu 一键部署（root）

```bash
bash deploy.sh     # 自动装 nginx / node20，起服务，开放 80 端口
```
