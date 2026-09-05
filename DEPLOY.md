# 部署 v3.0 到 VM（在 VM 终端依次执行）

## 前提
- VM 上项目路径：`/opt/g3-workstation`（沿用）
- Git 已配置好 SSH key 拉到 origin

## 拉代码 + 重启

```bash
cd /opt/g3-workstation && \
git fetch origin && \
git reset --hard origin/main && \
sudo systemctl restart g3-workstation && \
sleep 2 && \
curl -s http://127.0.0.1:3000/api/admin/me | head -c 120 ; echo
```

预期：第二行输出 `{"error":"unauthorized"}` 表示 API 通了且鉴权生效。

## 更新 nginx 配置（新增 /admin/ 反代）

```bash
sudo bash deploy.sh 2>&1 | tail -25
```

deploy.sh 是幂等的（apt 已装的会跳过），它会重写 nginx 配置加上 `/admin/` location，然后 reload nginx，最后做 curl 校验。

## 验证

```bash
# 1. 前台首页
curl -s http://127.0.0.1/ | grep -o '沐沐学习乐园' | head -1

# 2. 后台登录页
curl -s -o /dev/null -w 'login: %{http_code}\n' http://127.0.0.1/admin/login.html

# 3. 后台数据 API（未登录应 401）
curl -s -o /dev/null -w 'admin api: %{http_code}\n' http://127.0.0.1/api/admin/data
```

预期：`沐沐学习乐园`、`login: 200`、`admin api: 401`。

## 浏览器登录

打开：
- 前台：`http://<VM_IP>/`
- 后台：`http://<VM_IP>/admin/login.html`

**默认账号 `admin` / 密码 `admin123`**，登录后**第一时间到「系统配置 → 用户管理」改掉默认密码**。

## 首次启动注意事项

1. VM 上的 `data.sqlite` 还在跑着老版，首次启动新版时会**自动 seed admin 用户**到 `users` key，不会动其它数据。
2. 老的 `pwdHash`（前台家长密码）已经不再使用——后台登录走 `users` 集合。可以忽略老 `pwdHash`（不会报错，只是没用了）。
3. 新引入的 key（quiz/quizLog/dict/users）首次访问时是 `null`，前台 normalize 会兜底为默认值。

## 如果出错

```bash
# Princeton node 日志
sudo journalctl -u g3-workstation -n 80 --no-pager

# nginx 配置语法
sudo nginx -t

# nginx 错误日志
sudo tail -30 /var/log/nginx/error.log
```
