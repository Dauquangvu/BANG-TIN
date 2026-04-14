export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { url } = req.body;
  const r = await fetch('https://api-d-anthropic-d-com-s-cld.v.tuangouai.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514', max_tokens: 1000,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages: [{ role: 'user', content: 'Tóm tắt bài báo này 4-5 câu tiếng Việt:\n' + url }]
    })
  });
  const d = await r.json();
  const summary = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
  res.json({ summary });
}
