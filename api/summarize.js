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
    return res.status(500).json({ error: "Thiếu AI_API_KEY trong environment" });
  }

  // ── BƯỚC 1: Lấy nội dung bài báo qua r.jina.ai (bypass Cloudflare) ──
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
        .slice(0, 6000);
    }
  } catch (_) {
    // Jina thất bại → thử direct fetch bên dưới
  }

  // ── BƯỚC 2: Fallback — direct fetch ──
  if (!articleText || articleText.length < 100) {
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

      if (
        html.includes("Just a moment") ||
        html.includes("cf-browser-verification") ||
        html.includes("_cf_chl")
      ) {
        return res.status(422).json({
          error: "Trang bị chặn bởi Cloudflare. Thử link từ: Zing, Tuổi Trẻ, Thanh Niên...",
        });
      }

      articleText = html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim()
        .slice(0, 6000);
    } catch (err) {
      return res.status(502).json({ error: "Không thể truy cập URL: " + err.message });
    }
  }

  if (!articleText || articleText.length < 100) {
    return res.status(422).json({ error: "Không đọc được nội dung bài báo." });
  }

  // ── BƯỚC 3: Gửi lên Claude API ──
  // Thử lần lượt các auth scheme vì proxy gwai.cloud có thể dùng Bearer thay x-api-key
  const endpoint = `${AI_BASE_URL}/v1/messages`;
  const body = JSON.stringify({
    model: AI_MODEL,
    max_tokens: 1000,
    messages: [
      {
        role: "user",
        content: `Hãy tóm tắt bài báo sau bằng tiếng Việt trong 4-5 câu ngắn gọn, súc tích:\n\n${articleText}`,
      },
    ],
  });

  const authSchemes = [
    // Scheme 1: chuẩn Anthropic
    { "x-api-key": AI_API_KEY, "anthropic-version": "2023-06-01" },
    // Scheme 2: Bearer (nhiều proxy dùng cái này)
    { Authorization: `Bearer ${AI_API_KEY}`, "anthropic-version": "2023-06-01" },
    // Scheme 3: Bearer không có anthropic-version (proxy tự thêm)
    { Authorization: `Bearer ${AI_API_KEY}` },
  ];

  let lastStatus = 0;
  let lastRaw = "";

  for (const authHeaders of authSchemes) {
    let claudeRes;
    try {
      claudeRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body,
      });
    } catch (err) {
      return res.status(502).json({ error: "Không kết nối được Claude API: " + err.message });
    }

    const rawText = await claudeRes.text();

    if (claudeRes.ok) {
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (_) {
        return res
          .status(500)
          .json({ error: "Claude trả về không phải JSON", raw: rawText.slice(0, 300) });
      }

      const summary =
        data?.content?.find((b) => b.type === "text")?.text ||
        data?.content?.[0]?.text ||
        "";

      if (!summary) {
        return res
          .status(500)
          .json({ error: "Claude không trả về nội dung", raw: rawText.slice(0, 300) });
      }

      return res.status(200).json({ summary });
    }

    lastStatus = claudeRes.status;
    lastRaw = rawText;

    // Chỉ retry nếu là lỗi auth (401/403)
    if (claudeRes.status !== 401 && claudeRes.status !== 403) break;
  }

  return res.status(lastStatus).json({
    error: `Claude API lỗi ${lastStatus} — Key không hợp lệ hoặc hết quota trên proxy ${AI_BASE_URL}`,
    detail: lastRaw.slice(0, 500),
  });
}
