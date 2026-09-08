// api/chat-history.js
// Lưu/đọc lịch sử Boxchat AI dùng Vercel KV (shared mọi thiết bị)
// ENV cần có: KV_REST_API_URL, KV_REST_API_TOKEN  (từ Vercel Storage → KV)
//
// GET  /api/chat-history          → trả về mảng lịch sử [{id,url,domain,summary,ts}]
// POST /api/chat-history          → body {item} → thêm 1 item, trả về danh sách mới
// DELETE /api/chat-history?id=xx  → xoá 1 item
// DELETE /api/chat-history?all=1  → xoá tất cả

const KV_KEY = 'bangtin_boxchat_v1';
const MAX_ITEMS = 50;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Vercel KV REST helpers ──────────────────────────────────────
async function kvGet(key) {
  const base  = (process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) return null;

  const res = await fetch(`${base}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const json = await res.json();
  // Vercel KV REST trả về { result: "..." } (JSON string) hoặc null
  if (json.result === null || json.result === undefined) return null;
  try { return JSON.parse(json.result); } catch { return null; }
}

async function kvSet(key, value) {
  const base  = (process.env.KV_REST_API_URL || '').replace(/\/+$/, '');
  const token = process.env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error('Thiếu KV_REST_API_URL / KV_REST_API_TOKEN trong Vercel environment');

  const res = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    // Giá trị phải là string với Vercel KV REST API
    body: JSON.stringify(value),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`KV set failed ${res.status}: ${txt.slice(0, 200)}`);
  }
  return true;
}

// ── Main handler ────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
    return res.status(200).end();
  }
  Object.entries(CORS).forEach(([k,v]) => res.setHeader(k,v));
  res.setHeader('Cache-Control', 'no-store');

  // ── GET: đọc lịch sử ──────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const items = (await kvGet(KV_KEY)) || [];
      return res.status(200).json({ items, ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message, items: [] });
    }
  }

  // ── POST: thêm item mới ───────────────────────────────────────
  if (req.method === 'POST') {
    const { item } = req.body || {};
    if (!item || !item.url) {
      return res.status(400).json({ error: 'Thiếu item.url' });
    }

    try {
      let items = (await kvGet(KV_KEY)) || [];

      // Loại bỏ duplicate URL cũ (nếu có), rồi thêm mới lên đầu
      items = items.filter(it => it.url !== item.url);
      items.unshift({
        id:      item.id      || Date.now().toString(36),
        url:     item.url,
        domain:  item.domain  || '',
        summary: item.summary || '',
        error:   item.error   || null,
        ts:      item.ts      || Date.now(),
      });

      // Giữ tối đa MAX_ITEMS
      if (items.length > MAX_ITEMS) items = items.slice(0, MAX_ITEMS);

      await kvSet(KV_KEY, items);
      return res.status(200).json({ items, ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── DELETE: xoá 1 item hoặc tất cả ───────────────────────────
  if (req.method === 'DELETE') {
    const { id, all } = req.query || {};
    try {
      let items = (await kvGet(KV_KEY)) || [];
      if (all === '1') {
        items = [];
      } else if (id) {
        items = items.filter(it => it.id !== id);
      } else {
        return res.status(400).json({ error: 'Cần ?id=xxx hoặc ?all=1' });
      }
      await kvSet(KV_KEY, items);
      return res.status(200).json({ items, ok: true });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
