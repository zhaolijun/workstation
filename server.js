/* G3 Workstation backend: Express + SQLite (kv JSON document store) */
const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data.sqlite');

const KEYS = [
  'subjects', 'homework', 'mistakes',           // 学习主数据
  'points', 'streak', 'lastActive',             // 激励
  'days', 'tomato', 'sampleDone', 'eyeOn',      // 日常
  'pwdHash', 'adminPwdHash',                    // 家长/后台密码
  'courses',                                    // 课程表 [{day:'一'..'五', slots:[7门]}]
  'dailyNotes',                                 // 每日提醒 { 'YYYY-MM-DD': {text, show} }
  'schedule',                                   // 作息时间 { weekday:[{name,time}], friday:[{name,time}] }
  'checkins',                                   // 打卡 { 'YYYY-MM-DD': {morning:bool, reading:bool} }
  'rewards',                                    // 奖品 [{id,name,stars,emoji}]
  'redeemLog',                                  // 兑换记录 [{date,rewardId,stars,name}]
  'meta'                                        // 迁移/版本标记 { pointsMigrated:bool, seeded:bool }
];

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

const app = express();
app.use(express.json({ limit: '10mb', strict: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', (req, res) => {
  try {
    const rows = selectAll.all();
    const map = {};
    for (const r of rows) { try { map[r.k] = JSON.parse(r.v); } catch (e) {} }
    const out = {};
    for (const k of KEYS) out[k] = map[k] !== undefined ? map[k] : null;
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_read_failed' });
  }
});

app.post('/api/data/:key', (req, res) => {
  const k = req.params.key;
  if (!KEYS.includes(k)) return res.status(400).json({ error: 'bad_key' });
  try {
    upsert.run(k, JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_write_failed' });
  }
});

app.listen(PORT, () => console.log(`g3-workstation listening on :${PORT} (sqlite: ${DB_FILE})`));
