// api/news.js — VNExpress RSS + AI summarize
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

function getTag(block, tag) {
  // Handles CDATA and non-CDATA
  var r = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i');
  var f = r.exec(block);
  return f ? f[1].trim() : '';
}

function parseRSS(xml) {
  var items = [];
  var re = /<item[^>]*>([\s\S]*?)<\/item>/g;
  var m;
  while ((m = re.exec(xml)) !== null) {
    var b = m[1];
    var title   = strip(getTag(b, 'title'));
    var link    = (getTag(b, 'link') || getTag(b, 'guid')).trim();
    // VNExpress RSS description thường có nội dung khá đầy đủ
    var descRaw = getTag(b, 'description');
    var desc    = strip(descRaw);
    var pubDate = getTag(b, 'pubDate');

    if (title && link) {
      items.push({
        title:   title,
        link:    link,
        excerpt: desc.slice(0, 600),   // lấy tối đa 600 ký tự
        pubDate: pubDate
      });
    }
    if (items.length >= 3) break;
  }
  return items;
}

async function summarize(items) {
  var key      = process.env.AI_API_KEY;
  var base     = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  var model    = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  var endpoint = base + '/v1/messages';

  var prompt = items.map(function(it, i) {
    return 'BÀI ' + (i + 1) + ':\nTiêu đề: ' + it.title + '\nNội dung: ' + it.excerpt;
  }).join('\n\n---\n\n');

  var reqBody = JSON.stringify({
    model:      model,
    max_tokens: 1000,
    messages: [{
      role:    'user',
      content: 'Bạn là biên tập viên tin tức. Dựa vào tiêu đề và nội dung mỗi bài báo dưới đây, hãy viết phần tóm tắt gồm 4-5 câu tiếng Việt, nêu rõ: sự kiện gì xảy ra, ai liên quan, ở đâu, diễn biến chính, kết quả/ý nghĩa. Viết tự nhiên như biên tập viên, không liệt kê.\n\nTrả về JSON array gồm ' + items.length + ' chuỗi. Chỉ JSON thuần không markdown không giải thích thêm.\n\n' + prompt
    }]
  });

  var r = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         key,
      'anthropic-version': '2023-06-01'
    },
    body:   reqBody,
    signal: AbortSignal.timeout(30000)
  });

  if (!r.ok) {
    var errText = await r.text();
    throw new Error('AI ' + r.status + ': ' + errText.slice(0, 300));
  }
  var d = await r.json();
  var t = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '[]';
  var clean = t.replace(/```json|```/g, '').trim();

  // Safety: tìm array JSON trong response
  var arrMatch = clean.match(/\[[\s\S]*\]/);
  if (!arrMatch) throw new Error('AI response không phải JSON array');
  return JSON.parse(arrMatch[0]);
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
    // 1. Fetch RSS
    var rssRes = await fetch(RSS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 BangTin/2.0' },
      signal:  AbortSignal.timeout(8000)
    });
    if (!rssRes.ok) throw new Error('RSS ' + rssRes.status);
    var xml   = await rssRes.text();
    var items = parseRSS(xml);

    if (items.length === 0) throw new Error('Không parse được tin từ RSS');

    // 2. Nếu yêu cầu AI và có key → tóm tắt
    if (withAI && process.env.AI_API_KEY) {
      try {
        var toSum = items.slice(0, 2);   // chỉ tóm tắt 2 tin đầu
        var sums  = await summarize(toSum);
        toSum.forEach(function(it, i) {
          if (sums[i] && typeof sums[i] === 'string') {
            it.summary = sums[i];
          }
        });
      } catch (e) {
        // AI lỗi → vẫn trả tin bình thường, không crash
        console.error('AI error:', e.message);
        items[0] && (items[0].aiError = e.message.slice(0, 100));
      }
    }

    return res.status(200).json({ items: items });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
