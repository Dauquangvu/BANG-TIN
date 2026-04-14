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
      items.push({ title: title, link: link.trim(), excerpt: desc.slice(0, 220), pubDate: pubDate });
    }
    if (items.length >= 3) break;
  }
  return items;
}

async function summarize(items) {
  var key     = process.env.AI_API_KEY;
  var base    = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  var model   = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  var url     = base + '/v1/messages';

  var prompt = items.map(function(it, i) {
    return 'BAI ' + (i + 1) + ': ' + it.title + '\nMO TA: ' + it.excerpt;
  }).join('\n\n');

  var body = JSON.stringify({
    model: model,
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: 'Tom tat ngan gon moi bai bang 1-2 cau tieng Viet. Tra ve JSON array 3 chuoi. Chi JSON.\n\n' + prompt
    }]
  });

  var r = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    },
    body: body
  });

  if (!r.ok) throw new Error('AI ' + r.status);
  var d = await r.json();
  var t = (d.content && d.content[0] && d.content[0].text) ? d.content[0].text : '[]';
  return JSON.parse(t.replace(/```json|```/g, '').trim());
}

module.exports = async function(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');

  var type = req.query.type;
  if (!RSS[type]) {
    return res.status(400).json({ error: 'type phai la: thegioi hoac trongnuoc' });
  }

  try {
    var rss = await fetch(RSS[type], {
      headers: { 'User-Agent': 'BangTin/1.0' }
    });
    if (!rss.ok) throw new Error('RSS ' + rss.status);
    var xml   = await rss.text();
    var items = parseRSS(xml);

    if (process.env.AI_API_KEY && items.length > 0) {
      try {
        var sums = await summarize(items);
        items.forEach(function(it, i) { it.summary = sums[i] || null; });
      } catch (e) {
        console.warn('AI bo qua:', e.message);
      }
    }

    return res.status(200).json({ items: items });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
