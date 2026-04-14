export const config = {
  api: {
    bodyParser: true,
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const { url } = req.body || {};
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Missing or invalid URL" });
    }

    // ===== 1. FETCH via Jina Reader (bypasses Cloudflare, returns clean text) =====
    // Primary: https://r.jina.ai/<url>  → plain text/markdown, no HTML parsing needed
    // Fallback: direct fetch with browser headers
    let content = "";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);

    try {
      // --- Primary: Jina Reader ---
      const jinaRes = await fetch(`https://r.jina.ai/${url}`, {
        signal: controller.signal,
        headers: {
          Accept: "text/plain, text/markdown, */*",
          "X-Return-Format": "text",
          "User-Agent": "Mozilla/5.0",
        },
        redirect: "follow",
      });

      if (jinaRes.ok) {
        const raw = await jinaRes.text();
        // Jina returns markdown with metadata header — strip lines before first blank line
        const lines = raw.split("\n");
        const firstBlank = lines.findIndex((l) => l.trim() === "");
        content = (firstBlank > 0 ? lines.slice(firstBlank + 1) : lines)
          .join(" ")
          .replace(/\s{2,}/g, " ")
          .trim()
          .slice(0, 6000);
      }
    } catch (_) {
      // ignore — fall through to direct fetch
    } finally {
      clearTimeout(timer);
    }

    // --- Fallback: direct fetch (for sites not blocked) ---
    if (!content || content.length < 100) {
      const ctrl2 = new AbortController();
      const t2 = setTimeout(() => ctrl2.abort(), 12000);
      try {
        const htmlRes = await fetch(url, {
          signal: ctrl2.signal,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8",
            "Cache-Control": "no-cache",
            "Upgrade-Insecure-Requests": "1",
          },
          redirect: "follow",
        });
        const html = await htmlRes.text();

        // Detect Cloudflare challenge page
        if (/just a moment|cf-browser-verification|cf_clearance/i.test(html)) {
          return res.status(403).json({
            error:
              "Trang này dùng Cloudflare chặn bot. Hãy thử báo từ nguồn khác (Tuổi Trẻ, Thanh Niên, Dân Trí…).",
          });
        }

        // Extract article content
        let raw = "";
        const selectors = [
          /<article[^>]+class="[^"]*fck_detail[^"]*"[^>]*>([\s\S]*?)<\/article>/i,
          /<article[^>]*>([\s\S]*?)<\/article>/i,
          /<div[^>]+class="[^"]*(?:article-body|article__body|detail-content|content-detail|entry-content|post-content)[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
        ];
        for (const re of selectors) {
          const m = html.match(re);
          if (m && m[1].length > 300) { raw = m[1]; break; }
        }
        if (!raw) {
          const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
          raw = body ? body[1] : html;
        }

        content = raw
          .replace(/<script[\s\S]*?<\/script>/gi, "")
          .replace(/<style[\s\S]*?<\/style>/gi, "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<[^>]+>/g, " ")
          .replace(/&nbsp;/g, " ")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/\s{2,}/g, " ")
          .trim()
          .slice(0, 6000);
      } catch (fetchErr) {
        if (fetchErr.name === "AbortError") {
          return res.status(504).json({ error: "Trang web phản hồi quá chậm (timeout)" });
        }
        throw fetchErr;
      } finally {
        clearTimeout(t2);
      }
    }

    if (!content || content.length < 80) {
      return res.status(422).json({
        error: "Không trích xuất được nội dung (trang có thể chặn bot hoặc yêu cầu đăng nhập)",
      });
    }

    // ===== 2. CALL CLAUDE API =====
    // AI_BASE_URL = https://1gw.gwai.cloud  →  endpoint = /v1/messages
    const baseUrl = (process.env.AI_BASE_URL || "").replace(/\/+$/, "");
    const apiUrl = `${baseUrl}/v1/messages`;

    const claudeRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.AI_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [
          {
            role: "user",
            content: `Bạn là trợ lý tóm tắt tin tức.\n\nHãy:\n- Tóm tắt thành 4–5 câu NGẮN GỌN\n- Giữ ý chính, bỏ chi tiết phụ\n- Viết tiếng Việt rõ ràng\n\nNội dung:\n${content}`,
          },
        ],
      }),
    });

    // Read raw text first to handle non-JSON error bodies
    const rawText = await claudeRes.text();

    if (!claudeRes.ok) {
      let errMsg = `Claude API lỗi HTTP ${claudeRes.status}`;
      try {
        const errJson = JSON.parse(rawText);
        errMsg = errJson?.error?.message || errJson?.error || rawText.slice(0, 300);
      } catch {
        errMsg = rawText.slice(0, 300) || errMsg;
      }
      return res.status(502).json({ error: errMsg });
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch {
      return res.status(502).json({ error: "Claude API trả về dữ liệu không hợp lệ" });
    }

    const summary =
      data?.content?.find((b) => b.type === "text")?.text ||
      data?.content?.[0]?.text ||
      "Không có kết quả";

    return res.status(200).json({ summary });

  } catch (err) {
    if (err.name === "AbortError") {
      return res.status(504).json({ error: "Trang web phản hồi quá chậm (timeout 10s)" });
    }
    return res.status(500).json({ error: err.message || "Lỗi không xác định" });
  }
}
