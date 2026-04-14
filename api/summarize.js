export default async function handler(req, res) {
  // Chỉ cho phép POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'Thiếu URL bài báo' });
  }

  try {
    const response = await fetch('https://api-d-anthropic-d-com-s-cld.v.tuangouai.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [
          {
            role: 'user',
            content: `Hãy truy cập bài báo tại URL này và tóm tắt nội dung chính trong 4-5 câu bằng tiếng Việt, rõ ràng và súc tích:\n\n${url}`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json();
      return res.status(response.status).json({ error: err.error?.message || 'Lỗi API' });
    }

    const data = await response.json();

    // Lấy text từ response
    const summary = data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    return res.status(200).json({ summary });

  } catch (err) {
    return res.status(500).json({ error: 'Lỗi server: ' + err.message });
  }
}
