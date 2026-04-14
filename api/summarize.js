/**
 * api/summarize.js — AI đọc & tóm tắt bài báo từ URL bất kỳ
 * Được gọi từ nút 🤖 AI bubble trong index.html.
 *
 * Logic đúng: server fetch URL → strip HTML → gửi text cho Claude
 *             (không dùng web_search — web_search là công cụ tìm kiếm, không phải đọc URL)
 */

function stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function extractTitle(html) {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(html);
  return m ? m[1].trim().replace(/\s*[|\-–—].*$/, '').trim() : '';
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const url = (req.query.url || '').trim();
  if (!url.startsWith('http')) {
    return res.status(400).json({ error: 'Thiếu hoặc sai tham số url' });
  }

  const key = process.env.AI_API_KEY;
  if (!key) {
    return res.status(503).json({ error: 'AI_API_KEY chưa được cấu hình trên server' });
  }

  try {
    // Bước 1: Fetch trang bài báo từ server
    const pageRes = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'Accept':     'text/html,application/xhtml+xml',
        'Accept-Language': 'vi-VN,vi;q=0.9'
      },
      signal: AbortSignal.timeout(9000)
    });
    if (!pageRes.ok) throw new Error('Không tải được trang: HTTP ' + pageRes.status);

    const html    = await pageRes.text();
    const title   = extractTitle(html);
    const content = stripHtml(html).slice(0, 6000); // giới hạn context

    // Bước 2: Gửi text cho Claude — không cần tool
    const base     = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    const model    = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
    const endpoint = base + '/v1/messages';

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model,
        max_tokens: 512,
        messages: [{
          role: 'user',
          content:
            `Tiêu đề bài báo: "${title || 'Không rõ'}"\n\n` +
            `Nội dung trang:\n${content}\n\n` +
            `Hãy viết tóm tắt 4-5 câu tiếng Việt, nêu rõ: sự kiện gì xảy ra, ` +
            `ai liên quan, ở đâu, diễn biến chính và kết quả/ý nghĩa. ` +
            `Chỉ trả về đoạn tóm tắt, không thêm tiêu đề hay giải thích.`
        }]
      }),
      signal: AbortSignal.timeout(28000)
    });

    if (!r.ok) {
      const errText = await r.text();
      throw new Error('Claude API ' + r.status + ': ' + errText.slice(0, 200));
    }

    const d = await r.json();
    const textBlock = (d.content || []).find(b => b.type === 'text');
    if (!textBlock) throw new Error('Claude không trả về kết quả');

    return res.status(200).json({ title, summary: textBlock.text.trim() });

  } catch(e) {
    console.error('[summarize] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
