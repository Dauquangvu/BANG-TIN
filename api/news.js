// api/news.js — Vercel Serverless Function
// GET /api/news?type=thegioi|trongnuoc            → đọc cache dùng chung (mọi thiết bị thấy giống nhau)
// GET /api/news?type=thegioi|trongnuoc&pwd=324     → ép tải tin mới + AI đọc toàn văn, tự chọn 2 tin tốt nhất + tóm tắt
//
// Nguồn tin: RSS VnExpress (ổn định, không tốn phí, không phụ thuộc bên thứ 3).
// Cache dùng chung mọi thiết bị: Vercel KV (cùng ENV với api/chat-history.js — KV_REST_API_URL, KV_REST_API_TOKEN).
// Nếu chưa cấu hình KV, code vẫn chạy được với cache tạm trong bộ nhớ (không đồng bộ giữa các lần cold-start).
//
// ENV tùy chọn:
//   KV_REST_API_URL, KV_REST_API_TOKEN  → bật cache dùng chung mọi thiết bị (khuyến nghị)
//   ANTHROPIC_API_KEY                   → bật AI đọc + chọn + tóm tắt (chỉ chạy khi force-refresh, tiết kiệm chi phí)
//   AI_MODEL                            → mặc định 'claude-haiku-4-5-20251001'
//   NEWS_PWD                            → mặc định '324' (phải khớp NEWS_PWD trong index.html)

const RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss',
};
const DISPLAY_ITEMS   = 2;  // số tin hiện ra cho người xem
const CANDIDATE_ITEMS = 6;  // số tin ứng viên đưa AI đọc để chọn ra DISPLAY_ITEMS tin tốt nhất
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

function parseRSS(xml, limit) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null && items.length < limit) {
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
      if (cleaned.length > 200) return cleaned.slice(0, 4000);
    }
  } catch (e) { /* rơi xuống fallback */ }

  // 2) Fallback — tải HTML trực tiếp rồi bóc chữ thô
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 9000);
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
    return text.length > 200 ? text.slice(0, 4000) : null;
  } catch (e) {
    return null;
  }
}

function extractJsonArray(text) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch (e) {}
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) {}
  }
  throw new Error('AI trả về không đúng định dạng JSON: ' + cleaned.slice(0, 150));
}

// ── AI đọc toàn văn các tin ứng viên, TỰ CHỌN ra DISPLAY_ITEMS tin tốt nhất
//    (ưu tiên mới + có đủ ngày/địa điểm rõ ràng) rồi tóm tắt theo đúng mẫu 2 phần ──
async function aiSelectAndSummarize(candidates, apiKey, model) {
  const fullTexts = await Promise.all(candidates.map(it => fetchArticleText(it.link).catch(() => null)));

  const prompt = candidates
    .map((it, i) => {
      const body = fullTexts[i] || it.excerpt || '(không có nội dung)';
      return `BÀI SỐ ${i}:\nTIÊU ĐỀ: ${it.title}\nNGÀY ĐĂNG (RSS): ${it.pubDate || 'không rõ'}\nNỘI DUNG:\n${body}`;
    })
    .join('\n\n---\n\n');

  const instruction = `Dưới đây là ${candidates.length} bài báo, đánh số từ 0 đến ${candidates.length - 1}.

BƯỚC 1 — CHỌN: Chọn ra ĐÚNG ${DISPLAY_ITEMS} bài PHÙ HỢP NHẤT theo tiêu chí: vừa MỚI (ưu tiên bài có ngày đăng gần nhất) VỪA có đầy đủ THÔNG TIN NGÀY THÁNG CỤ THỂ và ĐỊA ĐIỂM CỤ THỂ ngay trong nội dung bài. Loại các bài mơ hồ, chung chung, thiếu ngày/địa điểm rõ ràng nếu còn bài khác đáp ứng tốt hơn.

BƯỚC 2 — TÓM TẮT: Với mỗi bài đã chọn, viết tóm tắt theo ĐÚNG cấu trúc gồm 2 phần, cách nhau bằng ký tự xuống dòng \\n:
Phần 1: TIÊU ĐỀ BÀI VIẾT, VIẾT IN HOA TOÀN BỘ (không thêm số thứ tự).
Phần 2: MỘT đoạn văn liền mạch (không xuống dòng, không tách câu riêng), khoảng 60-90 từ tiếng Việt, văn phong báo chí súc tích, BẮT BUỘC bắt đầu bằng cụm "Ngày [ngày/tháng cụ thể lấy đúng trong bài; nếu bài thật sự không nêu ngày thì dùng ngày đăng RSS đã cho ở trên, viết dạng d/m], tại [địa điểm cụ thể lấy đúng trong bài]," rồi tiếp tục kể lại đầy đủ diễn biến, nội dung chính, đúng trọng tâm. TUYỆT ĐỐI không được để trống bằng dấu ngoặc vuông hay ghi "không có/không rõ" — luôn phải điền một mốc thời gian và địa điểm cụ thể suy ra được từ bài.

Ví dụ đúng định dạng phần 2 (chỉ để tham khảo văn phong, không copy nội dung): "Ngày 7/9, tại phường Phước Tân, Đồng Nai, ôtô 7 chỗ lưu thông hướng Đồng Nai - TP HCM khi qua đoạn cao tốc đang sửa chữa đã tông biển cảnh báo, cọc tiêu rồi lao xuống phần đường bị đào thấp, sập hố ga. Vụ việc khiến hai bánh xe hư hỏng nặng, không gây thương vong. Cơ quan chức năng đang kiểm tra việc bố trí biển cảnh báo."

Trả về DUY NHẤT 1 JSON array gồm đúng ${DISPLAY_ITEMS} phần tử, mỗi phần tử là object dạng {"index": <số thứ tự bài đã chọn ở trên>, "summary": "<TIÊU ĐỀ IN HOA>\\n<đoạn văn phần 2>"}. BẮT BUỘC: không thêm bất kỳ chữ nào khác ngoài JSON, không giải thích, không xin lỗi, không từ chối, không dùng markdown — kể cả khi nội dung nhạy cảm hay khó tóm tắt thì vẫn phải chọn và tóm tắt khách quan theo đúng cấu trúc trên.

${prompt}`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`AI HTTP ${resp.status}: ${t.slice(0, 150)}`);
  }
  const data = await resp.json();
  const text = (data.content || []).find((b) => b.type === 'text')?.text || '[]';
  return extractJsonArray(text);
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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const willUseAI = forceRefresh && !!apiKey;

  // 2) Tải RSS mới — lấy nhiều tin ứng viên hơn khi sắp dùng AI để chọn lọc
  let candidates;
  try {
    const rssRes = await fetch(RSS[type], { headers: { 'User-Agent': 'BangTin/2.0' } });
    if (!rssRes.ok) throw new Error('RSS HTTP ' + rssRes.status);
    candidates = parseRSS(await rssRes.text(), willUseAI ? CANDIDATE_ITEMS : DISPLAY_ITEMS);
    if (!candidates.length) throw new Error('RSS không có bài viết nào');
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

  // 3) AI đọc toàn văn + tự chọn DISPLAY_ITEMS tin tốt nhất + tóm tắt
  //    (chỉ chạy khi force-refresh và có ANTHROPIC_API_KEY)
  let items = candidates.slice(0, DISPLAY_ITEMS); // mặc định: lấy top tin mới nhất, chưa có AI
  let aiUsed = false;
  let aiError = null;

  if (willUseAI) {
    try {
      const model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
      const selections = await aiSelectAndSummarize(candidates, apiKey, model);
      const picked = selections
        .map(sel => {
          const cand = candidates[sel.index];
          return cand ? { ...cand, summary: sel.summary } : null;
        })
        .filter(Boolean);
      if (!picked.length) throw new Error('AI không chọn được bài phù hợp');
      items = picked;
      aiUsed = true;
    } catch (e) {
      console.warn('[news] AI select/summarize skip:', e.message);
      aiError = e.message.slice(0, 200);
      // items vẫn giữ giá trị mặc định (top tin mới nhất, không có AI) — không để trắng trang
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
