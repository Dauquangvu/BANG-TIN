// api/news.js — Vercel Serverless Function
// GET /api/news?type=trongnuoc        → đọc cache (mọi thiết bị, không cần mật khẩu)
// GET /api/news?type=trongnuoc&pwd=324 → force cập nhật tin mới

const cache = { thegioi: null, trongnuoc: null };
const cacheTime = { thegioi: 0, trongnuoc: 0 };
const CACHE_TTL = 15 * 60 * 1000; // 15 phút

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = (req.query.type === 'thegioi') ? 'thegioi' : 'trongnuoc';
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const NEWS_PWD = process.env.NEWS_PWD || '324';
  const isForceRefresh = req.query.pwd === NEWS_PWD;

  // Còn cache và không force refresh → trả luôn (tất cả thiết bị đều thấy)
  if (!isForceRefresh && cache[type] && (Date.now() - cacheTime[type] < CACHE_TTL)) {
    return res.status(200).json({
      items: cache[type],
      updatedAt: new Date(cacheTime[type]).toISOString(),
      fromCache: true
    });
  }

  if (!ANTHROPIC_API_KEY) {
    if (cache[type]) {
      return res.status(200).json({ items: cache[type], updatedAt: new Date(cacheTime[type]).toISOString(), fromCache: true });
    }
    return res.status(500).json({ error: 'Chưa cấu hình ANTHROPIC_API_KEY trên Vercel' });
  }

  try {
    const items = await fetchFromClaude(type, ANTHROPIC_API_KEY);
    cache[type] = items;
    cacheTime[type] = Date.now();
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({ items, updatedAt: new Date().toISOString(), fromCache: false });
  } catch(e) {
    if (cache[type]) {
      return res.status(200).json({ items: cache[type], updatedAt: new Date(cacheTime[type]).toISOString(), fromCache: true, warning: e.message });
    }
    return res.status(500).json({ error: e.message });
  }
}

async function fetchFromClaude(type, apiKey) {
  const query = type === 'thegioi'
    ? 'tin tức thế giới quốc tế nổi bật mới nhất hôm nay'
    : 'tin tức trong nước Việt Nam thời sự nổi bật mới nhất hôm nay';

  const systemPrompt = `Bạn là trợ lý tìm tin tức. Tìm kiếm web và trả về ĐÚNG JSON sau, không thêm text nào khác:
{"items":[{"title":"tiêu đề","link":"url đầy đủ","pubDate":"thời gian đăng","excerpt":"tóm tắt 1-2 câu"}]}
- Đúng 6 bài mới nhất hôm nay hoặc hôm qua
- Ưu tiên: VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí, Nhân Dân`;

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: systemPrompt,
      messages: [{ role: 'user', content: query }]
    })
  });

  if (!claudeRes.ok) {
    const err = await claudeRes.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Claude API lỗi: ' + claudeRes.status);
  }
  const data = await claudeRes.json();
  const textBlock = data.content?.find(b => b.type === 'text');
  if (!textBlock) throw new Error('Không có phản hồi từ Claude');
  const jsonMatch = textBlock.text.trim().match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Phản hồi không đúng định dạng');
  const parsed = JSON.parse(jsonMatch[0]);
  if (!parsed.items?.length) throw new Error('Không có tin tức');
  return parsed.items;
}
