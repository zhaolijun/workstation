/* G3 Workstation backend: Express + MySQL (kv JSON document store) */
const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');

const PORT = process.env.PORT || 3000;
const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || 'g3password',
  database: process.env.DB_NAME || 'g3_workspace',
  charset: 'utf8mb4'
};

const KEYS = ['subjects','homework','recites','mistakes','points','streak','lastActive','days','tomato','sampleDone','eyeOn'];

const pool = mysql.createPool(Object.assign({ connectionLimit: 5, supportBigNumbers: true }, DB));

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/data', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT k, v FROM kv_store');
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

app.post('/api/data/:key', async (req, res) => {
  const k = req.params.key;
  if (!KEYS.includes(k)) return res.status(400).json({ error: 'bad_key' });
  try {
    await pool.query(
      'INSERT INTO kv_store (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)',
      [k, JSON.stringify(req.body)]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'db_write_failed' });
  }
});

app.listen(PORT, () => console.log(`g3-workstation listening on :${PORT}`));
