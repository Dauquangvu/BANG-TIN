// api/news.js — Vercel Serverless Function
// Gọi Claude API + web_search để lấy tin mới nhất
// API key lưu trong Vercel Environment Variable: ANTHROPIC_API_KEY

export default async function handler(req, res) {
  // CORS — cho phép trình duyệt gọi trực tiếp
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const type = req.query.type || 'trongnuoc'; // 'thegioi' hoặc 'trongnuoc'

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Chưa cấu hình ANTHROPIC_API_KEY trên Vercel' });
  }

  const query = type === 'thegioi'
    ? 'tin tức thế giới quốc tế nổi bật mới nhất hôm nay'
    : 'tin tức trong nước Việt Nam thời sự nổi bật mới nhất hôm nay';

  const systemPrompt = `Bạn là trợ lý tìm tin tức. Tìm kiếm web và trả về ĐÚNG JSON sau, không thêm bất kỳ text nào khác bên ngoài JSON:
{"items":[{"title":"tiêu đề bài báo","link":"url đầy đủ","pubDate":"thời gian đăng","excerpt":"tóm tắt 1-2 câu nội dung chính"}]}
Yêu cầu:
- Đúng 6 bài mới nhất trong ngày hôm nay hoặc hôm qua
- Ưu tiên nguồn: VnExpress, Tuổi Trẻ, Thanh Niên, Dân Trí, Nhân Dân
- excerpt phải là tóm tắt ngắn gọn, súc tích bằng tiếng Việt
- link phải là URL đầy đủ, hợp lệ`;

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
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
      return res.status(claudeRes.status).json({
        error: err.error?.message || 'Lỗi Claude API: ' + claudeRes.status
      });
    }

    const data = await claudeRes.json();
    const textBlock = data.content?.find(b => b.type === 'text');
    if (!textBlock) return res.status(500).json({ error: 'Không có phản hồi từ Claude' });

    // Parse JSON từ response text
    const raw = textBlock.text.trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(500).json({ error: 'Phản hồi không đúng định dạng' });

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.items?.length) return res.status(500).json({ error: 'Không có tin tức' });

    // Cache 15 phút ở Vercel Edge
    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({ items: parsed.items, updatedAt: new Date().toISOString() });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
