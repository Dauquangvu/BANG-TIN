export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Missing URL" });
    }

    // 1. LẤY HTML BÀI BÁO
    const htmlRes = await fetch(url);
    const html = await htmlRes.text();

    // 2. TRÍCH TEXT (cách đơn giản cho VnExpress)
    const content = html
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 5000); // giới hạn để tiết kiệm token

    // 3. GỬI CHO CLAUDE
    const response = await fetch(`${process.env.AI_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.AI_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: `Tóm tắt nội dung sau thành 4-5 câu tiếng Việt:\n\n${content}`
          }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(500).json({ error: err });
    }

    const data = await response.json();
    const summary = data?.content?.[0]?.text || "Không có kết quả";

    return res.status(200).json({ summary });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
