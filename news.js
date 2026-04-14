// api/news.js — Vercel Serverless Function (Proxy-key compatible)
// ─────────────────────────────────────────────────────────────────
// Biến môi trường cần set trên Vercel:
//
//   AI_API_KEY      — key của bạn (proxy key hoặc Anthropic key gốc)
//   AI_BASE_URL     — base URL của proxy, ví dụ: https://your-proxy.com
//                     Nếu dùng Anthropic gốc thì để trống hoặc không set.
//   AI_MODEL        — (tuỳ chọn) tên model, mặc định claude-haiku-4-5-20251001
//
// Cách proxy thường hoạt động: thay https://api.anthropic.com bằng AI_BASE_URL,
// còn lại headers và body giữ nguyên format Anthropic.
// ─────────────────────────────────────────────────────────────────

export const config = { runtime: 'edge' };

const RSS_URLS = {
  thegioi:   'https://vnexpress.net/rss/the-gioi.rss',
  trongnuoc: 'https://vnexpress.net/rss/thoi-su.rss',
};

// ── Strip HTML tags ───────────────────────────────────────────────
function stripHtml(html = '') {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ').trim();
}

// ── Parse RSS XML ─────────────────────────────────────────────────
function parseRSS(xml) {
  const items = [];
  const itemRe = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = tag => {
      const r = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i'
      );
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

// ── AI summarize (proxy-compatible) ──────────────────────────────
async function aiSummarize(items) {
  const apiKey  = process.env.AI_API_KEY;
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  const model   = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';

  const endpoint = `${baseUrl}/v1/messages`;

  const prompt = items.map((it, i) =>
    `BÀI ${i+1}: ${it.title}\nNỘI DUNG: ${it.excerpt}`
  ).join('\n\n');

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      'x-api-key':       apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      messages: [{
        role: 'user',
        content:
          'Tóm tắt ngắn gọn MỖI bài báo sau bằng 1-2 câu tiếng Việt súc tích, giữ nguyên thông tin chính. ' +
          'Trả về JSON array gồm 3 phần tử, mỗi phần tử là chuỗi tóm tắt. Chỉ trả JSON, không thêm gì khác.\n\n' +
          prompt,
      }],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`AI API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data  = await res.json();
  const text  = data.content?.[0]?.text || '[]';
  const clean = text.replace(/```json|```/g, '').trim();
  return JSON.parse(clean);
}

// ── Handler ───────────────────────────────────────────────────────
export default async function handler(req) {
  const url  = new URL(req.url);
  const type = url.searchParams.get('type');

  if (!RSS_URLS[type]) {
    return new Response(
      JSON.stringify({ error: 'type must be: thegioi | trongnuoc' }),
      { status: 400, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } }
    );
  }

  try {
    // 1. Fetch RSS feed
    const rssRes = await fetch(RSS_URLS[type], {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BangTin/1.0)' },
    });
    if (!rssRes.ok) throw new Error(`RSS ${rssRes.status}`);
    const xml = await rssRes.text();

    // 2. Parse articles
    const items = parseRSS(xml);

    // 3. AI summary — chỉ chạy nếu AI_API_KEY được set
    if (process.env.AI_API_KEY && items.length > 0) {
      try {
        const summaries = await aiSummarize(items);
        items.forEach((it, i) => { it.summary = summaries[i] || null; });
      } catch (e) {
        // Non-fatal: vẫn trả tin, chỉ thiếu summary
        console.warn('AI summarize skipped:', e.message);
      }
    }

    return new Response(JSON.stringify({ items }), {
      status: 200,
      headers: {
        'Content-Type':             'application/json',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control':            'no-store',
      },
    });

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}
