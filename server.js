/* G3 Workstation backend: Express + SQLite (kv JSON document store)
   + Admin session auth + /api/admin/* 路由 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.sqlite');

const KEYS = [
  'subjects', 'homework', 'mistakes',           // 学习主数据
  'points', 'streak', 'lastActive',             // 激励
  'days', 'tomato', 'sampleDone', 'eyeOn',      // 日常
  'pwdHash', 'adminPwdHash',                    // 家长/后台密码（fnv 哈希，明文不存）
  'courses',                                    // 课程表 [{day:'一'..'五', slots:[7门]}]
  'dailyNotes',                                 // 每日提醒 { 'YYYY-MM-DD': {text, show} }
  'schedule',                                   // 作息时间 { weekday:[{name,time}], friday:[{name,time}] }
  'checkins',                                   // 打卡 { 'YYYY-MM-DD': {morning:bool, reading:bool} }
  'rewards',                                    // 奖品 [{id,name,stars,emoji}]
  'redeemLog',                                  // 兑换记录 [{date,rewardId,stars,name}]
  'quiz',                                       // 每日一题 { 'YYYY-MM-DD': {subject:{type,question,options,answer,explain,stars}} }
  'quizLog',                                    // 答题记录 [{date,subject,chose,ok,stars,at}]
  'dict',                                       // 字典表 { hwStatus:[], reasons:[], quizTypes:[], quizSubjects:[] }
  'users',                                      // 用户列表 [{id,name,role,pwdHash,createdAt,updatedAt}]
  'meta'                                        // 迁移/版本标记
];
const KEY_SET = new Set(KEYS);

/* ---------------- 存储 ---------------- */
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS kv_store (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
)`);

const selectAll = db.prepare('SELECT k, v FROM kv_store');
const upsert = db.prepare(
  'INSERT INTO kv_store (k, v, updated_at) VALUES (?, ?, strftime(\'%s\',\'now\')) ' +
  'ON CONFLICT(k) DO UPDATE SET v=excluded.v, updated_at=excluded.updated_at'
);

function readAll(){
  const rows = selectAll.all();
  const map = {};
  for (const r of rows) { try { map[r.k] = JSON.parse(r.v); } catch (e) {} }
  const out = {};
  for (const k of KEYS) out[k] = map[k] !== undefined ? map[k] : null;
  return out;
}
function writeKey(k, v){
  if (!KEY_SET.has(k)) throw new Error('bad_key');
  upsert.run(k, JSON.stringify(v === undefined ? null : v));
}

/* ---------------- 简易密码哈希（与前台 fnv 兼容） ---------------- */
function fnv(str){
  let h = 2166136261;
  for (let i = 0; i < str.length; i++){ h ^= str.charCodeAt(i); h = (h * 16777619) >>> 0; }
  return ('0000000' + h.toString(16)).slice(-8);
}

/* ---------------- Session ---------------- */
const SESSION_TTL = 7 * 24 * 3600 * 1000; // 7 天
const sessions = new Map(); // sid -> { uid, name, role, expireAt }
function newSession(user){
  const sid = crypto.randomBytes(24).toString('base64url');
  sessions.set(sid, { uid: user.id, name: user.name, role: user.role, expireAt: Date.now() + SESSION_TTL });
  return sid;
}
function getSession(req){
  const h = req.headers.cookie || '';
  const m = h.match(/(?:^|;\s*)mumu_admin=([^;]+)/);
  if (!m) return null;
  const s = sessions.get(m[1]);
  if (!s) return null;
  if (s.expireAt < Date.now()){ sessions.delete(m[1]); return null; }
  return s;
}
function killSession(req){
  const h = req.headers.cookie || '';
  const m = h.match(/(?:^|;\s*)mumu_admin=([^;]+)/);
  if (m) sessions.delete(m[1]);
}
function ensureAdmin(req, res, next){
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.adminUser = s;
  next();
}
/* 首次启动种子：无任何用户时造 admin/admin123 */
function seedAdminUser(){
  const all = readAll();
  if (Array.isArray(all.users) && all.users.length) return;
  const u = { id: 'u_root', name: 'admin', role: 'admin', pwdHash: fnv('admin123'), createdAt: Date.now(), updatedAt: Date.now() };
  writeKey('users', [u]);
  console.log('[seed] default admin user created: admin / admin123');
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: '10mb', strict: false }));

/* 关闭 admin 静态页缓存 */
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/api/admin'))
    res.setHeader('Cache-Control', 'no-store');
  next();
});

/* -------- 公共 API：学生前台 -------- */
app.get('/api/data', (req, res) => {
  try { res.json(readAll()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'db_read_failed' }); }
});
app.post('/api/data/:key', (req, res) => {
  const k = req.params.key;
  if (!KEY_SET.has(k)) return res.status(400).json({ error: 'bad_key' });
  try { writeKey(k, req.body); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'db_write_failed' }); }
});

/* -------- 后台鉴权 -------- */
app.post('/api/admin/login', (req, res) => {
  const { name, pwd } = req.body || {};
  if (!name || !pwd) return res.status(400).json({ error: 'need_name_pwd' });
  const users = readAll().users || [];
  const u = users.find(x => x.name === name);
  if (!u || u.pwdHash !== fnv(pwd)) return res.status(401).json({ error: 'bad_credentials' });
  const sid = newSession(u);
  res.setHeader('Set-Cookie', `mumu_admin=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL/1000}`);
  res.json({ ok: true, user: { id: u.id, name: u.name, role: u.role } });
});
app.post('/api/admin/logout', (req, res) => {
  killSession(req);
  res.setHeader('Set-Cookie', 'mumu_admin=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/admin/me', ensureAdmin, (req, res) => {
  res.json({ ok: true, user: req.adminUser });
});

/* -------- 后台数据 API：读全量 / 读单 key / 写单 key / 批量 -------- */
app.get('/api/admin/data', ensureAdmin, (req, res) => {
  try { res.json(readAll()); }
  catch (e) { res.status(500).json({ error: 'db_read_failed' }); }
});
app.get('/api/admin/data/:key', ensureAdmin, (req, res) => {
  const k = req.params.key;
  if (!KEY_SET.has(k)) return res.status(400).json({ error: 'bad_key' });
  try { res.json({ [k]: readAll()[k] }); }
  catch (e) { res.status(500).json({ error: 'db_read_failed' }); }
});
app.post('/api/admin/data/:key', ensureAdmin, (req, res) => {
  const k = req.params.key;
  if (!KEY_SET.has(k)) return res.status(400).json({ error: 'bad_key' });
  try { writeKey(k, req.body); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'db_write_failed' }); }
});
/* 批量：{updates:{k1:v1,...}} */
app.post('/api/admin/batch', ensureAdmin, (req, res) => {
  const updates = (req.body && req.body.updates) || {};
  const bad = Object.keys(updates).find(k => !KEY_SET.has(k));
  if (bad) return res.status(400).json({ error: 'bad_key', key: bad });
  try {
    for (const k of Object.keys(updates)) writeKey(k, updates[k]);
    res.json({ ok: true, written: Object.keys(updates).length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'db_write_failed' }); }
});

/* -------- 静态文件：前台 + 后台 -------- */
app.use('/admin', express.static(path.join(__dirname, 'public', 'admin')));
app.use(express.static(path.join(__dirname, 'public')));

// 兜底：/admin 重定向到 /admin/ 让 express.static 解析到 index.html
app.get('/admin', (req, res) => res.redirect('/admin/'));

seedAdminUser();
app.listen(PORT, () => console.log(`g3-workstation listening on :${PORT} (sqlite: ${DB_FILE})`));
