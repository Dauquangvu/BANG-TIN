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

const PREFERRED_MODELS = [
  "claude-3-haiku-20240307",
  "claude-3-5-haiku-20241022",
  "claude-haiku",
];

function uniqueNonEmpty(arr) {
  return [...new Set(arr.map((v) => (v || "").trim()).filter(Boolean))];
}

function parseModelEnv(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,;|]+/)
    .map((v) => v.trim())
    .filter(Boolean);
}

function getModelCandidates() {
  const envPrimary = process.env.AI_MODEL || process.env.ANTHROPIC_MODEL || "";
  const envList = parseModelEnv(process.env.AI_MODELS || process.env.ANTHROPIC_MODELS || "");
  return uniqueNonEmpty([envPrimary, ...envList, ...PREFERRED_MODELS]);
}

function buildAuthSchemes(apiKey) {
  return [
    {
      name: "x-api-key+version",
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    },
    {
      name: "bearer+version",
      headers: { Authorization: `Bearer ${apiKey}`, "anthropic-version": "2023-06-01" },
    },
    {
      name: "x-api-key",
      headers: { "x-api-key": apiKey },
    },
    {
      name: "bearer",
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  ];
}

function buildEndpointCandidates(baseUrl) {
  const trimmed = (baseUrl || "https://api.anthropic.com").replace(/\/+$/, "");
  const endpoints = [];

  if (/\/v1$/i.test(trimmed)) {
    endpoints.push(`${trimmed}/messages`);
  } else {
    endpoints.push(`${trimmed}/v1/messages`);
    endpoints.push(`${trimmed}/messages`);
  }

  return uniqueNonEmpty(endpoints);
}

function extractSummaryText(data) {
  if (!data) return "";

  // Anthropic Messages API
  const fromAnthropicArray = Array.isArray(data.content)
    ? data.content.find((b) => b?.type === "text")?.text || data.content[0]?.text || ""
    : "";
  if (typeof fromAnthropicArray === "string" && fromAnthropicArray.trim()) {
    return fromAnthropicArray.trim();
  }

  // Một số proxy trả content là string
  if (typeof data.content === "string" && data.content.trim()) {
    return data.content.trim();
  }

  // OpenAI-compatible proxy format
  const fromChoices = data?.choices?.[0]?.message?.content || data?.choices?.[0]?.text || "";
  if (typeof fromChoices === "string" && fromChoices.trim()) {
    return fromChoices.trim();
  }

  // Fallback generic
  if (typeof data.text === "string" && data.text.trim()) {
    return data.text.trim();
  }

  return "";
}

function shouldKeepTrying(status, rawText) {
  if ([400, 401, 403, 404, 408, 409, 422, 429].includes(status)) return true;
  const lower = (rawText || "").toLowerCase();
  if (lower.includes("model") || lower.includes("quota") || lower.includes("auth")) return true;
  return false;
}

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

  const AI_API_KEY = process.env.AI_API_KEY || process.env.ANTHROPIC_API_KEY;
  const AI_BASE_URL = (
    process.env.AI_BASE_URL || process.env.API_BASE_URL || process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com"
  ).replace(/\/+$/, "");

  if (!AI_API_KEY) {
    return res.status(500).json({ error: "Thiếu AI_API_KEY/ANTHROPIC_API_KEY trong environment" });
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
  } catch (err) {
    console.warn("[summarize] jina fetch failed:", err?.message || err);
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

  // ── BƯỚC 3: Gửi lên Claude API với fallback model/auth/endpoint ──
  const modelCandidates = getModelCandidates();
  const endpointCandidates = buildEndpointCandidates(AI_BASE_URL);
  const authSchemes = buildAuthSchemes(AI_API_KEY);

  console.log("[summarize] start request", {
    baseUrl: AI_BASE_URL,
    endpointCount: endpointCandidates.length,
    authCount: authSchemes.length,
    models: modelCandidates,
    articleChars: articleText.length,
  });

  let lastStatus = 500;
  let lastRaw = "";
  let attempt = 0;

  for (const endpoint of endpointCandidates) {
    for (const auth of authSchemes) {
      for (const model of modelCandidates) {
        attempt += 1;
        const body = JSON.stringify({
          model,
          max_tokens: 1000,
          messages: [
            {
              role: "user",
              content: `Hãy tóm tắt bài báo sau bằng tiếng Việt trong 4-5 câu ngắn gọn, súc tích:\n\n${articleText}`,
            },
          ],
        });

        console.log(`[summarize] attempt #${attempt}`, {
          endpoint,
          auth: auth.name,
          model,
        });

        let upstreamRes;
        try {
          upstreamRes = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...auth.headers },
            body,
          });
        } catch (err) {
          console.warn("[summarize] upstream fetch error", {
            endpoint,
            auth: auth.name,
            model,
            message: err?.message || String(err),
          });
          lastStatus = 502;
          lastRaw = err?.message || String(err);
          continue;
        }

        const rawText = await upstreamRes.text();
        lastStatus = upstreamRes.status;
        lastRaw = rawText;

        console.log("[summarize] upstream response", {
          endpoint,
          auth: auth.name,
          model,
          status: upstreamRes.status,
        });

        if (upstreamRes.ok) {
          let data;
          try {
            data = JSON.parse(rawText);
          } catch (_) {
            console.warn("[summarize] non-JSON success response", {
              endpoint,
              auth: auth.name,
              model,
            });
            return res.status(500).json({
              error: "API trả về không phải JSON",
              detail: rawText.slice(0, 300),
            });
          }

          const summary = extractSummaryText(data);
          if (summary) {
            return res.status(200).json({ summary, modelUsed: model });
          }

          console.warn("[summarize] empty summary text", {
            endpoint,
            auth: auth.name,
            model,
          });
          continue;
        }

        // Retry/fallback tiếp khi 403 hoặc các lỗi có thể do model/auth/proxy
        if (!shouldKeepTrying(upstreamRes.status, rawText)) {
          console.error("[summarize] stop retry due to non-retriable status", {
            endpoint,
            auth: auth.name,
            model,
            status: upstreamRes.status,
          });
          return res.status(upstreamRes.status).json({
            error: `Claude API lỗi ${upstreamRes.status}`,
            detail: rawText.slice(0, 500),
          });
        }
      }
    }
  }

  return res.status(lastStatus || 500).json({
    error: `Claude API lỗi ${lastStatus} — thử tất cả fallback model/auth/endpoint nhưng chưa thành công`,
    detail: (lastRaw || "").slice(0, 500),
    triedModels: modelCandidates,
  });
}
