// api/news.js — Dùng Claude web_search để tự đọc và tóm tắt tin
const RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss'
};

function strip(html) {
  return (html || '')
    .replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function parseRSS(xml) {
  var items = [];
  var re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var b = m[1];
    function getTag(tag) {
      var r = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i');
      var f = r.exec(b);
      return f ? f[1].trim() : '';
    }
    var title   = strip(getTag('title'));
    var link    = (getTag('link') || getTag('guid')).trim();
    var desc    = strip(getTag('description'));
    var pubDate = getTag('pubDate');
    if (title && link) {
      items.push({ title, link, excerpt: desc.slice(0, 400), pubDate });
    }
    if (items.length >= 3) break;
  }
  return items;
}

// Dùng Claude với web_search tool để tự vào link, đọc và tóm tắt bài
async function summarizeWithWebSearch(item) {
  var key      = process.env.AI_API_KEY;
  var base     = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  var model    = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  var endpoint = base + '/v1/messages';

  var reqBody = JSON.stringify({
    model,
    max_tokens: 1024,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search'
    }],
    messages: [{
      role: 'user',
      content: `Hãy vào đọc bài báo tại link này: ${item.link}\n\nSau khi đọc xong toàn bộ nội dung bài báo, hãy viết phần tóm tắt gồm 4-5 câu tiếng Việt, nêu rõ: sự kiện gì xảy ra, ai liên quan, ở đâu, diễn biến chính và kết quả/ý nghĩa. Chỉ trả về đoạn tóm tắt, không thêm tiêu đề hay giải thích.`
    }]
  });

  var r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01'
    },
    body:   reqBody,
    signal: AbortSignal.timeout(45000)
  });

  if (!r.ok) {
    var errText = await r.text();
    throw new Error('AI ' + r.status + ': ' + errText.slice(0, 200));
  }

  var d = await r.json();
  // Lấy text block cuối cùng (sau khi AI đã dùng web_search xong)
  var textBlocks = (d.content || []).filter(b => b.type === 'text');
  if (textBlocks.length === 0) throw new Error('AI không trả về text');
  return textBlocks[textBlocks.length - 1].text.trim();
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  var type   = req.query.type;
  var withAI = req.query.ai === '1';

  if (!RSS[type]) {
    return res.status(400).json({ error: 'type phải là: thegioi hoặc trongnuoc' });
  }

  try {
    // 1. Lấy danh sách tin từ RSS
    var rssRes = await fetch(RSS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 BangTin/2.0' },
      signal:  AbortSignal.timeout(8000)
    });
    if (!rssRes.ok) throw new Error('RSS ' + rssRes.status);
    var xml   = await rssRes.text();
    var items = parseRSS(xml);
    if (items.length === 0) throw new Error('Không parse được tin từ RSS');

    // 2. Nếu yêu cầu AI → cho AI tự vào đọc từng bài (2 bài đầu)
    if (withAI && process.env.AI_API_KEY) {
      var toSum = items.slice(0, 2);
      // Chạy song song 2 bài
      var results = await Promise.allSettled(
        toSum.map(it => summarizeWithWebSearch(it))
      );
      results.forEach(function(result, i) {
        if (result.status === 'fulfilled' && result.value) {
          toSum[i].summary = result.value;
        } else {
          console.error('Bài', i + 1, 'lỗi:', result.reason?.message);
        }
      });
    }

    return res.status(200).json({ items });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
