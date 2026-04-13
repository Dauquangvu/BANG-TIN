// api/news.js — Vercel Serverless Function
// Fetches VNExpress RSS and optionally summarizes with Claude AI
// ENV: ANTHROPIC_API_KEY (optional — if absent, returns raw excerpts only)

export const config = { runtime: 'edge' };

const RSS_URLS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss',
};

// ── Strip HTML tags ──────────────────────────────────────────────────────────
function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

// ── Parse RSS XML → array of { title, link, excerpt, pubDate } ───────────────
function parseRSS(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i');
      const found = r.exec(block);
      return found ? found[1].trim() : '';
    };
    const title   = stripHtml(get('title'));
    const link    = get('link') || get('guid');
    const desc    = stripHtml(get('description'));
    const pubDate = get('pubDate');
    if (title && link) {
      items.push({ title, link: link.trim(), excerpt: desc.slice(0, 220), pubDate });
    }
    if (items.length >= 3) break;
  }
  return items;
}

// ── Ask Claude to summarize 3 articles ───────────────────────────────────────
async function aiSummarize(items, apiKey) {
  const prompt = items.map((it, i) =>
    `BÀI ${i+1}: ${it.title}\nNỘI DUNG: ${it.excerpt}`
  ).join('\n\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `Tóm tắt ngắn gọn MỖI bài báo sau bằng 1-2 câu tiếng Việt súc tích, giữ nguyên thông tin chính. Trả về JSON array gồm 3 phần tử, mỗi phần tử là chuỗi tóm tắt. Chỉ trả JSON, không thêm gì khác.\n\n${prompt}`,
      }],
    }),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = data.content?.[0]?.text || '[]';
  // Strip possible markdown fences
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Handler ──────────────────────────────────────────────────────────────────
export default async function handler(req) {
  const url  = new URL(req.url);
  const type = url.searchParams.get('type');

  if (!RSS_URLS[type]) {
    return new Response(JSON.stringify({ error: 'type must be thegioi or trongnuoc' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    // 1. Fetch RSS
    const rssRes = await fetch(RSS_URLS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BangTin/1.0)' },
    });
    if (!rssRes.ok) throw new Error(`RSS fetch failed: ${rssRes.status}`);
    const xml = await rssRes.text();

    // 2. Parse
    const items = parseRSS(xml);

    // 3. AI summary (optional)
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey && items.length > 0) {
      try {
        const summaries = await aiSummarize(items, apiKey);
        items.forEach((it, i) => { it.summary = summaries[i] || null; });
      } catch (e) {
        console.warn('AI summarize failed:', e.message);
        // Non-fatal — continue without summary
      }
    }

    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
