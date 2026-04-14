export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ error: "Missing URL" });
    }

    // ===== 1. FETCH HTML =====
    const htmlRes = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });
    const html = await htmlRes.text();

    // ===== 2. TRÍCH NỘI DUNG CHUẨN =====
    let content = "";

    // 🎯 Ưu tiên VnExpress
    const vnexpressMatch = html.match(
      /<article class="fck_detail[^>]*>([\s\S]*?)<\/article>/
    );

    if (vnexpressMatch) {
      content = vnexpressMatch[1];
    } else {
      // fallback: lấy body
      const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
      content = bodyMatch ? bodyMatch[1] : html;
    }

    // ===== 3. CLEAN HTML → TEXT =====
    content = content
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 6000); // giới hạn token

    // ===== 4. GỌI CLAUDE =====
    const response = await fetch(`${process.env.AI_BASE_URL}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.AI_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL,
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `
Bạn là trợ lý tóm tắt tin tức.

Hãy:
- Tóm tắt thành 4–5 câu NGẮN GỌN
- Giữ ý chính, bỏ chi tiết phụ
- Viết tiếng Việt rõ ràng

Nội dung:
${content}
`
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
