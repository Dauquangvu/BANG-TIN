// api/unit-news.js — Vercel Serverless Function
// GET  /api/unit-news?week=2026-09-W2                → đọc nội dung "Tin Đơn Vị" của tuần đó
//                                                        (nếu chưa có ai cập nhật, trả về content:null
//                                                         và front-end tự hiện nội dung mặc định)
// POST /api/unit-news  body {week, content, pwd}      → lưu/ghi đè nội dung tuần đó (cần đúng mật khẩu)
//
// Dùng chung Vercel KV với api/chat-history.js:
// ENV cần có: KV_REST_API_URL, KV_REST_API_TOKEN
// ENV tuỳ chọn: NEWS_PWD (mặc định "324", phải khớp NEWS_PWD trong index.html)

const KV_PREFIX = 'bangtin_unitnews_';
const WEEK_KEY_RE = /^\d{4}-\d{2}-W\d$/;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Vercel KV REST helpers (giống api/chat-history.js) ──
async function kvGet(key) {
  const base  = (process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) return null;

  const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (json.result === null || json.result === undefined) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}

async function kvSet(key, value) {
  const base  = (process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error('Thiếu KV_REST_API_URL / KV_REST_API_TOKEN trong Vercel environment');

  const body = JSON.stringify(value);
  const res = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV set failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  res.setHeader('Cache-Control', 'no-store');

  const NEWS_PWD = process.env.NEWS_PWD || '324';

  // ── GET: đọc nội dung 1 tuần ──────────────────────────
  if (req.method === 'GET') {
    const week = req.query.week;
    if (!week || !WEEK_KEY_RE.test(week)) {
      return res.status(400).json({ error: 'Thiếu hoặc sai định dạng ?week=YYYY-MM-Wn' });
    }
    try {
      const saved = await kvGet(KV_PREFIX + week);
      if (saved) {
        return res.status(200).json({ week, content: saved.content, updatedAt: saved.updatedAt });
      }
      return res.status(200).json({ week, content: null, updatedAt: null });
    } catch (e) {
      return res.status(500).json({ error: e.message, week, content: null });
    }
  }

  // ── POST: lưu nội dung 1 tuần (cần mật khẩu) ──────────
  if (req.method === 'POST') {
    const { week, content, pwd } = req.body || {};
    if (!week || !WEEK_KEY_RE.test(week)) {
      return res.status(400).json({ error: 'Thiếu hoặc sai định dạng week (YYYY-MM-Wn)' });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ error: 'Nội dung không được để trống' });
    }
    if (pwd !== NEWS_PWD) {
      return res.status(401).json({ error: 'Sai mật khẩu' });
    }
    try {
      const updatedAt = Date.now();
      const value = { content: String(content).trim(), updatedAt };
      await kvSet(KV_PREFIX + week, value);
      return res.status(200).json({ week, content: value.content, updatedAt });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
