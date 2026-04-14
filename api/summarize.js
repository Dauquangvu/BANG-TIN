export const config = {
  api: {
    bodyParser: { sizeLimit: "1mb" },
  },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return res.status(200).set(CORS_HEADERS).end();
  }

  Object.entries(CORS_HEADERS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { url } = req.body || {};
  if (!url || !/^https?:\/\/.+/.test(url)) {
    return res.status(400).json({ error: "URL không hợp lệ" });
  }

  const AI_API_KEY = process.env.AI_API_KEY;
  const AI_BASE_URL = (process.env.AI_BASE_URL || "https://api.anthropic.com").replace(/\/$/, "");
  const AI_MODEL = process.env.AI_MODEL || "claude-haiku-4-5-20251001";

  if (!AI_API_KEY) {
    return res.status(500).json({ error: "Thiếu AI_API_KEY" });
  }

  // ── BƯỚC 1: Lấy nội dung bài báo (bypass Cloudflare bằng r.jina.ai) ──
  let articleText = "";

  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const jinaRes = await fetch(jinaUrl, {
      signal: controller.signal,
      headers: {
        Accept: "text/plain, */*",
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)",
      },
    });
    clearTimeout(timeout);

    if (jinaRes.ok) {
      const text = await jinaRes.text();
      // Jina trả về Markdown — loại bỏ dòng metadata đầu
      articleText = text
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("Title:") &&
            !line.startsWith("URL Source:") &&
            !line.startsWith("Published Time:") &&
            !line.startsWith("Markdown Content:")
        )
        .join("\n")
        .trim()
        .slice(0, 6000); // giới hạn token
    }
  } catch (_) {
    // Jina thất bại → thử direct fetch
  }

  // ── BƯỚC 2: Fallback — direct fetch nếu Jina thất bại ──
  if (!articleText) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const directRes = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml",
          "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
          "Sec-Fetch-Dest": "document",
          "Sec-Fetch-Mode": "navigate",
          "Sec-Fetch-Site": "none",
          "Cache-Control": "no-cache",
        },
      });
      clearTimeout(timeout);

      const html = await directRes.text();

      // Kiểm tra Cloudflare block
      if (
        html.includes("Just a moment") ||
        html.includes("cf-browser-verification") ||
        html.includes("_cf_chl")
      ) {
        return res.status(422).json({
          error:
            "Trang báo được bảo vệ bởi Cloudflare. Hãy thử link từ nguồn khác (Zing, Tuổi Trẻ, Thanh Niên...).",
        });
      }

      // Trích nội dung thô
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 6000);

      articleText = stripped;
    } catch (err) {
      return res.status(502).json({ error: "Không thể truy cập URL: " + err.message });
    }
  }

  if (!articleText || articleText.length < 100) {
    return res.status(422).json({ error: "Không đọc được nội dung bài báo." });
  }

  // ── BƯỚC 3: Gửi lên Claude API ──
  const endpoint = `${AI_BASE_URL}/v1/messages`;

  let claudeRes;
  try {
    claudeRes = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": AI_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1000,
        messages: [
          {
            role: "user",
            content: `Hãy tóm tắt bài báo sau bằng tiếng Việt trong 4-5 câu ngắn gọn, súc tích:\n\n${articleText}`,
          },
        ],
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: "Không kết nối được Claude API: " + err.message });
  }

  const rawText = await claudeRes.text();

  if (!claudeRes.ok) {
    return res.status(claudeRes.status).json({
      error: `Claude API lỗi ${claudeRes.status}`,
      detail: rawText.slice(0, 500),
    });
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (_) {
    return res.status(500).json({ error: "Claude trả về không phải JSON", raw: rawText.slice(0, 300) });
  }

  const summary =
    data?.content?.find((b) => b.type === "text")?.text ||
    data?.content?.[0]?.text ||
    "";

  if (!summary) {
    return res.status(500).json({ error: "Claude không trả về nội dung", raw: rawText.slice(0, 300) });
  }

  return res.status(200).json({ summary });
}
