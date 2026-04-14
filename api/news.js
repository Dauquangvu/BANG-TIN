// api/news.js
const RSS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss'
};

function strip(html) {
  return (html || '')
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
    function get(tag) {
      var r = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>', 'i');
      var f = r.exec(b);
      return f ? f[1].trim() : '';
    }
    var title   = strip(get('title'));
    var link    = get('link') || get('guid');
    var desc    = strip(get('description'));
    var pubDate = get('pubDate');
    if (title && link) {
      items.push({ title: title, link: link.trim(), excerpt: desc.slice(0, 400), pubDate: pubDate });
    }
    if (items.length >= 3) break;
  }
  return items;
}

async function fetchArticleContent(url) {
  try {
    var r = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BangTin/1.0)', 'Accept': 'text/html' },
      signal: AbortSignal.timeout(6000)
    });
    if (!r.ok) return null;
    var html = await r.text();

    var paragraphs = [];

    var sapoMatch = html.match(/class="description"[^>]*>([\s\S]*?)<\/p>/i);
    if (sapoMatch) paragraphs.push(strip(sapoMatch[1]));

    var articleMatch = html.match(/class="(?:fck_detail|article-body)[^"]*"[^>]*>([\s\S]{100,5000}?)(?=<div class="article-relate|<div class="tags|<footer)/i);
    if (articleMatch) {
      var pRe = /<p[^>]*>([\s\S]*?)<\/p>/g;
      var pm, count = 0;
      while ((pm = pRe.exec(articleMatch[1])) !== null && count < 6) {
        var txt = strip(pm[1]);
        if (txt.length > 40) { paragraphs.push(txt); count++; }
      }
    }

    if (paragraphs.length === 0) {
      var descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
                   || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
      if (descMatch) paragraphs.push(descMatch[1].trim());
    }

    return paragraphs.join(' ').slice(0, 1500) || null;
  } catch (e) {
    return null;
  }
}

async function summarize(items) {
  var key   = process.env.AI_API_KEY;
  var base  = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  var model = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  var endpoint = base + '/v1/messages';

  var prompt = items.map(function(it, i) {
    var body = it.fullContent || it.excerpt || it.title;
    return 'BÀI ' + (i + 1) + ': ' + it.title + '\nNỘI DUNG: ' + body;
  }).join('\n\n---\n\n');

  var reqBody = JSON.stringify({
    model: model,
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: 'Bạn là trợ lý tóm tắt tin tức quân sự. Hãy tóm tắt mỗi bài báo dưới đây thành 3-4 câu tiếng Việt rõ ràng, nêu đủ thông tin chính (ai, làm gì, ở đâu, kết quả). Trả về JSON array gồm ' + items.length + ' chuỗi. Chỉ JSON thuần, không markdown, không giải thích.\n\n' + prompt
    }]
  });

  var r = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: reqBody,
    signal: AbortSignal.timeout(25000)
  });

  if (!r.ok) {
    var errText = await r.text();
    throw new Error('AI ' + r.status + ': ' + errText.slice(0, 300));
  }
  var d = await r.json();
  var t = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '[]';
  return JSON.parse(t.replace(/```json|```/g, '').trim());
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
    var rss = await fetch(RSS[type], {
      headers: { 'User-Agent': 'BangTin/1.0' },
      signal: AbortSignal.timeout(8000)
    });
    if (!rss.ok) throw new Error('RSS ' + rss.status);
    var xml   = await rss.text();
    var items = parseRSS(xml);

    if (withAI && process.env.AI_API_KEY && items.length > 0) {
      try {
        var toSum = items.slice(0, 2);
        var contents = await Promise.all(toSum.map(it => fetchArticleContent(it.link)));
        toSum.forEach(function(it, i) { if (contents[i]) it.fullContent = contents[i]; });

        var sums = await summarize(toSum);
        toSum.forEach(function(it, i) {
          it.summary = sums[i] || null;
          delete it.fullContent;
        });
      } catch (e) {
        console.warn('AI lỗi:', e.message);
        // Trả về items bình thường, không crash
      }
    }

    return res.status(200).json({ items: items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
