// api/news.js — Vercel Serverless Function
// GET /api/news?type=thegioi|trongnuoc            → đọc cache dùng chung (mọi thiết bị thấy giống nhau)
// GET /api/news?type=thegioi|trongnuoc&pwd=324     → ép tải tin mới + tóm tắt AI (nếu có ANTHROPIC_API_KEY)
//
// Nguồn tin: RSS VnExpress (ổn định, không tốn phí, không phụ thuộc bên thứ 3).
// Cache dùng chung mọi thiết bị: Vercel KV (cùng ENV với api/chat-history.js — KV_REST_API_URL, KV_REST_API_TOKEN).
// Nếu chưa cấu hình KV, code vẫn chạy được với cache tạm trong bộ nhớ (không đồng bộ giữa các lần cold-start).
//
// ENV tùy chọn:
//   KV_REST_API_URL, KV_REST_API_TOKEN  → bật cache dùng chung mọi thiết bị (khuyến nghị)
//   ANTHROPIC_API_KEY                   → bật tóm tắt AI (chỉ chạy khi force-refresh, tiết kiệm chi phí)
//   AI_MODEL                            → mặc định 'claude-haiku-4-5-20251001'
//   NEWS_PWD                            → mặc định '324' (phải khớp NEWS_PWD trong index.html)

const RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss',
};
const MAX_ITEMS   = 2;
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 phút
const KV_PREFIX = 'bangtin_news_';

// Cache tạm trong bộ nhớ — dùng khi chưa cấu hình KV (fallback, không đồng bộ nhiều thiết bị)
const MEM_CACHE = {};

function strip(h) {
  return (h || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseRSS(xml) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < MAX_ITEMS) {
    const b = m[1];
    const get = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
      const f = r.exec(b);
      return f ? f[1].trim() : '';
    };
    const title   = strip(get('title'));
    const link    = strip(get('link') || get('guid'));
    const excerpt = strip(get('description')).slice(0, 350);
    const pubDate = get('pubDate');
    if (title && link) items.push({ title, link, excerpt, pubDate });
  }
  return items;
}

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
  if (!base || !token) return false;
  const res = await fetch(`${base}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  });
  return res.ok;
}

async function cacheGet(type) {
  const kv = await kvGet(KV_PREFIX + type).catch(() => null);
  if (kv) return kv;
  return MEM_CACHE[type] || null;
}
async function cacheSet(type, value) {
  MEM_CACHE[type] = value;
  await kvSet(KV_PREFIX + type, value).catch(() => {});
}

// ── Tải toàn văn bài báo (ưu tiên r.jina.ai — bóc nội dung sạch; dự phòng tải HTML trực tiếp) ──
async function fetchArticleText(url) {
  // 1) r.jina.ai — reader bóc nội dung chính, vượt được Cloudflare của một số báo
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(`https://r.jina.ai/${url}`, {
      signal: controller.signal,
      headers: { Accept: 'text/plain, */*', 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
    });
    clearTimeout(timeout);
    if (res.ok) {
      const raw = await res.text();
      const cleaned = raw.split('\n')
        .filter(l => !l.startsWith('Title:') && !l.startsWith('URL Source:') &&
                     !l.startsWith('Published Time:') && !l.startsWith('Markdown Content:'))
        .join('\n').trim();
      if (cleaned.length > 200) return cleaned.slice(0, 5000);
    }
  } catch (e) { /* rơi xuống fallback */ }

  // 2) Fallback — tải HTML trực tiếp rồi bóc chữ thô
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'vi-VN,vi;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timeout);
    const html = await res.text();
    if (html.includes('Just a moment') || html.includes('cf-browser-verification') || html.includes('_cf_chl')) {
      return null; // bị Cloudflare chặn
    }
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s{2,}/g, ' ').trim();
    return text.length > 200 ? text.slice(0, 5000) : null;
  } catch (e) {
    return null;
  }
}

// ── Tóm tắt AI (tuỳ chọn, chỉ gọi khi force-refresh) — đọc TOÀN VĂN bài báo trước khi tóm tắt ──
async function aiSummarize(items, apiKey, model) {
  // Tải toàn văn từng bài song song; bài nào tải lỗi thì dùng excerpt RSS làm dự phòng
  const fullTexts = await Promise.all(items.map(it => fetchArticleText(it.link).catch(() => null)));

  const prompt = items
    .map((it, i) => {
      const body = fullTexts[i] || it.excerpt || '(không có nội dung)';
      return `BÀI ${i + 1}:\nTIÊU ĐỀ: ${it.title}\nNỘI DUNG:\n${body}`;
    })
    .join('\n\n---\n\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `Đọc kỹ TOÀN VĂN mỗi bài báo sau. Với MỖI bài, viết lại phần tóm tắt theo ĐÚNG cấu trúc 3 dòng sau, mỗi dòng cách nhau bằng ký tự xuống dòng \\n (không thêm tiêu đề phụ, không đánh số dòng):
Dòng 1: TIÊU ĐỀ BÀI VIẾT, VIẾT IN HOA TOÀN BỘ.
Dòng 2: Bắt đầu bằng "Ngày [ngày/tháng/năm cụ thể lấy đúng trong bài, nếu không có ngày cụ thể thì dùng ngày đăng bài]" rồi đến ", tại [địa điểm chính của sự việc — bỏ qua phần này nếu bài không nêu rõ địa điểm]" rồi nêu NGẮN GỌN trong 1 câu nội dung chính, trọng tâm nhất của bài.
Dòng 3: Đoạn tóm tắt đầy đủ nội dung bài báo, khoảng 60-80 từ tiếng Việt, súc tích, đúng trọng tâm, không lặp lại y nguyên dòng 2.

Trả về DUY NHẤT 1 JSON array gồm ${items.length} chuỗi theo thứ tự (mỗi chuỗi gồm đủ 3 dòng nối bằng \\n). BẮT BUỘC: không thêm bất kỳ chữ nào khác ngoài JSON, không giải thích, không xin lỗi, không từ chối, không dùng markdown — kể cả khi nội dung bài báo nhạy cảm hay khó tóm tắt thì vẫn phải tóm tắt khách quan theo đúng cấu trúc trên.\n\n${prompt}`,
      }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI HTTP ${resp.status}: ${t.slice(0, 150)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '[]';
  const cleaned = text.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // AI lỡ thêm chữ thừa trước/sau JSON → tự tách phần mảng [ ... ] ra rồi thử lại
    const m = cleaned.match(/\[[\s\S]*\]/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (e2) { /* rơi xuống throw bên dưới */ }
    }
    throw new Error('AI trả về không đúng định dạng JSON: ' + cleaned.slice(0, 150));
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const type = req.query.type === 'thegioi' ? 'thegioi'
             : req.query.type === 'trongnuoc' ? 'trongnuoc'
             : null;
  if (!type) return res.status(400).json({ error: 'type phải là "thegioi" hoặc "trongnuoc"' });

  const NEWS_PWD = process.env.NEWS_PWD || '324';
  const forceRefresh = req.query.pwd === NEWS_PWD;

  // 1) Không force-refresh → thử đọc cache dùng chung trước (mọi thiết bị thấy giống nhau)
  if (!forceRefresh) {
    const cached = await cacheGet(type).catch(() => null);
    if (cached && (Date.now() - cached.ts < CACHE_TTL_MS)) {
      return res.status(200).json({
        items: cached.items,
        updatedAt: new Date(cached.ts).toISOString(),
        fromCache: true,
        aiUsed: !!cached.aiUsed,
      });
    }
  }

  // 2) Tải RSS mới
  let items;
  try {
    const rssRes = await fetch(RSS[type], { headers: { 'User-Agent': 'BangTin/2.0' } });
    if (!rssRes.ok) throw new Error('RSS HTTP ' + rssRes.status);
    items = parseRSS(await rssRes.text());
    if (!items.length) throw new Error('RSS không có bài viết nào');
  } catch (e) {
    // RSS lỗi → dùng lại cache cũ (kể cả hết hạn) nếu có, để không "trắng trang"
    const stale = await cacheGet(type).catch(() => null);
    if (stale && stale.items && stale.items.length) {
      return res.status(200).json({
        items: stale.items,
        updatedAt: new Date(stale.ts).toISOString(),
        fromCache: true,
        warning: e.message,
      });
    }
    return res.status(502).json({ error: 'Không tải được tin RSS: ' + e.message });
  }

  // 3) Tóm tắt AI — chỉ khi force-refresh (nhập đúng mật khẩu) VÀ có ANTHROPIC_API_KEY
  let aiUsed = false;
  let aiError = null;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (forceRefresh && apiKey) {
    try {
      const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
      const sums = await aiSummarize(items, apiKey, model);
      items.forEach((it, i) => { if (sums[i]) it.summary = sums[i]; });
      aiUsed = true;
    } catch (e) {
      console.warn('[news] AI summarize skip:', e.message);
      aiError = e.message.slice(0, 200);
    }
  } else if (forceRefresh && !apiKey) {
    aiError = 'Chưa cấu hình ANTHROPIC_API_KEY trên Vercel';
  }

  const now = Date.now();
  await cacheSet(type, { items, ts: now, aiUsed });

  return res.status(200).json({
    items,
    updatedAt: new Date(now).toISOString(),
    fromCache: false,
    aiUsed,
    aiError,
  });
};
