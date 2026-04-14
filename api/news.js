/**
 * api/news.js — Lấy RSS VnExpress, fetch bài server-side, tóm tắt với Claude
 *
 * ĐÃ SỬA:
 *  1. Bỏ web_search tool — sai bản chất (tìm kiếm ≠ đọc URL cụ thể).
 *     Đúng logic: server fetch article → strip HTML → gửi text thẳng cho Claude.
 *  2. Tách getTag ra ngoài vòng lặp, nhận block làm tham số thay vì đóng gói biến.
 *  3. Timeout phù hợp với giới hạn Vercel (hobby 10s / pro 30s).
 */

const RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss'
};

/* ── Helpers ── */

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

/**
 * Tách tag từ một XML block — hàm thuần, không đóng gói biến ngoài scope.
 * @param {string} block  - chuỗi XML của một <item>
 * @param {string} tag    - tên tag cần lấy
 */
function getTag(block, tag) {
  const re = new RegExp(
    '<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>',
    'i'
  );
  const m = re.exec(block);
  return m ? m[1].trim() : '';
}

function parseRSS(xml, limit = 3) {
  const items = [];
  const re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const title   = stripHtml(getTag(b, 'title'));
    const link    = (getTag(b, 'link') || getTag(b, 'guid')).trim();
    const desc    = stripHtml(getTag(b, 'description'));
    const pubDate = getTag(b, 'pubDate');
    if (title && link) {
      items.push({ title, link, excerpt: desc.slice(0, 400), pubDate });
    }
    if (items.length >= limit) break;
  }
  return items;
}

/**
 * Fetch nội dung bài báo từ URL, trả về plain text (tối đa ~6000 ký tự).
 * Logic đúng: server gọi thẳng URL → không cần nhờ Claude "tìm kiếm".
 */
async function fetchArticleText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept':     'text/html,application/xhtml+xml',
      'Accept-Language': 'vi-VN,vi;q=0.9'
    },
    signal: AbortSignal.timeout(5000)
  });
  if (!res.ok) throw new Error('Fetch article HTTP ' + res.status);
  const html = await res.text();
  return stripHtml(html).slice(0, 6000);
}

/**
 * Tóm tắt bài báo bằng Claude — KHÔNG dùng tool.
 * Quy trình đúng: text đã có → gửi thẳng → nhận tóm tắt.
 */
async function summarizeArticle(item) {
  const key      = process.env.AI_API_KEY;
  const base     = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const model    = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  const endpoint = base + '/v1/messages';

  // Bước 1: lấy nội dung bài từ server (không qua Claude)
  const articleText = await fetchArticleText(item.link);

  // Bước 2: gửi text cho Claude tóm tắt — không cần tool nào
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
          `Tiêu đề bài báo: "${item.title}"\n\n` +
          `Nội dung:\n${articleText}\n\n` +
          `Hãy viết tóm tắt 4-5 câu tiếng Việt, nêu rõ: sự kiện gì xảy ra, ` +
          `ai liên quan, ở đâu, diễn biến chính và kết quả/ý nghĩa. ` +
          `Chỉ trả về đoạn tóm tắt, không thêm tiêu đề hay giải thích.`
      }]
    }),
    signal: AbortSignal.timeout(22000)
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error('Claude API ' + r.status + ': ' + errText.slice(0, 200));
  }

  const d = await r.json();
  const textBlock = (d.content || []).find(b => b.type === 'text');
  if (!textBlock) throw new Error('Claude không trả về text');
  return textBlock.text.trim();
}

/* ── Handler ── */

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  const type   = req.query.type;
  const withAI = req.query.ai === '1';

  if (!RSS[type]) {
    return res.status(400).json({ error: 'type phải là: thegioi hoặc trongnuoc' });
  }

  try {
    // 1. Lấy danh sách tin từ RSS
    const rssRes = await fetch(RSS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 BangTin/2.0' },
      signal:  AbortSignal.timeout(8000)
    });
    if (!rssRes.ok) throw new Error('RSS HTTP ' + rssRes.status);
    const xml   = await rssRes.text();
    const items = parseRSS(xml, 3);
    if (items.length === 0) throw new Error('Không parse được tin từ RSS');

    // 2. Nếu yêu cầu AI: fetch + tóm tắt 2 bài đầu song song
    if (withAI && process.env.AI_API_KEY) {
      const toSum = items.slice(0, 2);
      const results = await Promise.allSettled(
        toSum.map(it => summarizeArticle(it))
      );
      results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value) {
          toSum[i].summary = result.value;
        } else {
          console.error('[news] Bài', i + 1, 'lỗi:', result.reason?.message);
        }
      });
    }

    return res.status(200).json({ items });

  } catch(e) {
    console.error('[news] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
