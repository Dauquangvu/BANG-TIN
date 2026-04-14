// api/news.js — Vercel Serverless Function (CommonJS, Hobby-compatible)
// Biến môi trường set trên Vercel:
//   AI_API_KEY   — proxy key
//   AI_BASE_URL  — https://1gw.gwai.cloud  (không có /v1 ở cuối)
//   AI_MODEL     — (tuỳ chọn, mặc định claude-haiku-4-5-20251001)

const RSS_URLS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss',
};

function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&nbsp;/g,' ')
    .replace(/\s{2,}/g,' ').trim();
}

function parseRSS(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp('<' + tag + '[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/' + tag + '>','i');
      const f = r.exec(block);
      return f ? f[1].trim() : '';
    };
    const title   = stripHtml(get('title'));
    const link    = get('link') || get('guid');
    const desc    = stripHtml(get('description'));
    const pubDate = get('pubDate');
    if (title && link) items.push({ title, link: link.trim(), excerpt: desc.slice(0,220), pubDate });
    if (items.length >= 3) break;
  }
  return items;
}

async function aiSummarize(items) {
  const apiKey   = process.env.AI_API_KEY;
  const baseUrl  = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/,'');
  const model    = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
  const endpoint = baseUrl + '/v1/messages';

  const prompt = items.map((it,i) =>
    'BAI ' + (i+1) + ': ' + it.title + '\nNOI DUNG: ' + it.excerpt
  ).join('\n\n');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: 'Tom tat ngan gon MOI bai bao sau bang 1-2 cau tieng Viet suc tich. Tra ve JSON array 3 phan tu string. Chi JSON, khong markdown.\n\n' + prompt,
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(function(){ return ''; });
    throw new Error('AI ' + res.status + ': ' + body.slice(0,150));
  }
  const data = await res.json();
  const text = (data.content && data.content[0] && data.content[0].text) ? data.content[0].text : '[]';
  return JSON.parse(text.replace(/```json|```/g,'').trim());
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const type = req.query.type;
  if (!RSS_URLS[type]) {
    return res.status(400).json({ error: 'type must be: thegioi or trongnuoc' });
  }

  try {
    var rssRes = await fetch(RSS_URLS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BangTin/1.0)' },
    });
    if (!rssRes.ok) throw new Error('RSS ' + rssRes.status);
    var xml   = await rssRes.text();
    var items = parseRSS(xml);

    if (process.env.AI_API_KEY && items.length > 0) {
      try {
        var summaries = await aiSummarize(items);
        items.forEach(function(it, i) { it.summary = summaries[i] || null; });
      } catch(e) {
        console.warn('AI skip:', e.message);
      }
    }

    return res.status(200).json({ items: items });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
