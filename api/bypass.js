// Vercel serverless function — Node 18+
// Bypass nhiều shortener VN: link4m, link1s, link5s, yeumoney, shrinkme, shrinkearn

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
};

// ---- cấu hình theo domain ----
// mỗi entry: base URL, path POST, referer
const SITE_CONFIG = {
  "link4m.co":   { origin: "https://link4m.co",   goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "link4m.com":  { origin: "https://link4m.com",  goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "link1s.com":  { origin: "https://link1s.com",  goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "link5s.co":   { origin: "https://link5s.co",   goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "link5s.com":  { origin: "https://link5s.com",  goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "yeumoney.com":{ origin: "https://yeumoney.com",goPath: "/links/go", tokenNames: ["_token", "token", "hash"] },
  "shrinkme.io": { origin: "https://shrinkme.io", goPath: "/links/go", tokenNames: ["_token", "token"] },
  "shrinkearn.com":{origin: "https://shrinkearn.com",goPath:"/links/go",tokenNames:["_token","token"] },
};

// fallback nếu domain không có trong bảng
const GENERIC_CONFIG = {
  goPath: "/links/go",
  tokenNames: ["_token", "token", "hash", "csrf", "_csrf"],
};

// ---- regex trích link ----
const RE_WINDOW_LOC = /window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/i;
const RE_VAR_URL =
  /(?:var|let|const)\s+(?:url|link|target|dest|_url|real_url)\s*=\s*["']([^"']+)["']/i;
const RE_META_REFRESH =
  /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^;]+;\s*url=([^"']+)["']/i;
const RE_B64 = /(?:atob|decodeURIComponent)\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/;
const RE_RAW_URL = /https?:\/\/[^\s"'<>\\]+/g;

const BAD_DOMAINS = [
  "link4m.", "link1s.", "link5s.", "yeumoney.", "shrinkme.", "shrinkearn.",
  "google.", "gstatic.", "doubleclick.", "facebook.", "cloudflare.",
  "googleapis.", "ads", "banner", "gstatic", "googlesyndication",
  "cloudflareinsights",
];

function clean(url) {
  return url.trim().replace(/&amp;/g, "&");
}

function isGood(url) {
  if (!url || !url.startsWith("http")) return false;
  const low = url.toLowerCase();
  return !BAD_DOMAINS.some((b) => low.includes(b));
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function configFor(url) {
  const host = hostOf(url);
  // match chính xác
  if (SITE_CONFIG[host]) return { host, ...SITE_CONFIG[host] };
  // match theo suffix (sub-domain)
  for (const key of Object.keys(SITE_CONFIG)) {
    if (host.endsWith(key)) return { host: key, ...SITE_CONFIG[key] };
  }
  // fallback
  try {
    const u = new URL(url);
    return {
      host,
      origin: `${u.protocol}//${u.host}`,
      ...GENERIC_CONFIG,
    };
  } catch {
    throw new Error("URL không hợp lệ.");
  }
}

function extractFromHtml(html) {
  let m = html.match(RE_WINDOW_LOC);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_VAR_URL);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_META_REFRESH);
  if (m && isGood(clean(m[1]))) return clean(m[1]);

  m = html.match(RE_B64);
  if (m) {
    try {
      const decoded = Buffer.from(m[1], "base64").toString("utf-8");
      if (isGood(decoded)) return decoded;
    } catch { /* ignore */ }
  }

  const raws = html.match(RE_RAW_URL) || [];
  for (const raw of raws) {
    if (isGood(clean(raw))) return clean(raw);
  }
  return null;
}

function extractToken(html, tokenNames) {
  const data = { _method: "POST", adType: "", adUrl: "" };

  const inputRe = /<input\b[^>]*>/gi;
  const inputs = html.match(inputRe) || [];
  for (const tag of inputs) {
    const nameM = tag.match(/\bname\s*=\s*["']([^"']+)["']/i);
    const valM = tag.match(/\bvalue\s*=\s*["']([^"']*)["']/i);
    if (!nameM) continue;
    const name = nameM[1];
    const val = valM ? valM[1] : "";
    if (tokenNames.includes(name)) {
      data[name] = val;
      if (!data["_token"]) data["_token"] = val;
    } else if (name === "adType") {
      data["adType"] = val;
    } else if (name === "adUrl") {
      data["adUrl"] = val;
    }
  }

  // dò trong script
  for (const name of tokenNames) {
    const re = new RegExp(`${name}\\s*[:=]\\s*["']([^"']+)["']`);
    const tm = html.match(re);
    if (tm) {
      data[name] = tm[1];
      if (!data["_token"]) data["_token"] = tm[1];
      break;
    }
  }

  return data;
}

async function timedFetch(input, init, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function bypass(url) {
  const cfg = configFor(url);
  const baseHeaders = {
    ...DEFAULT_HEADERS,
    Referer: cfg.origin + "/",
  };

  let r;
  try {
    r = await timedFetch(url, {
      method: "GET",
      headers: baseHeaders,
      redirect: "follow",
    });
  } catch (e) {
    throw new Error(`Không request được: ${e.message}`);
  }

  const html1 = await r.text();
  const hit1 = extractFromHtml(html1);
  if (hit1) return { original: hit1, method: "html-parse", final_url: r.url };

  const tokenData = extractToken(html1, cfg.tokenNames);
  if (tokenData["_token"]) {
    const goUrl = cfg.origin + cfg.goPath;
    const body = new URLSearchParams(tokenData).toString();
    try {
      const r2 = await timedFetch(goUrl, {
        method: "POST",
        headers: {
          ...baseHeaders,
          "X-Requested-With": "XMLHttpRequest",
          Origin: cfg.origin,
          Referer: r.url,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        },
        body,
        redirect: "follow",
      });

      const text2 = await r2.text();
      try {
        const j = JSON.parse(text2);
        const target = j.url || j.link || j.target || j.result;
        if (target && isGood(target)) {
          return { original: target, method: "go-api", final_url: r2.url };
        }
      } catch { /* not json */ }

      const hit2 = extractFromHtml(text2);
      if (hit2) {
        return { original: hit2, method: "go-html", final_url: r2.url };
      }
    } catch { /* fallthrough */ }
  }

  for (const param of ["?get=true", "?go=1", "?short=1", "?api=1"]) {
    try {
      const r3 = await timedFetch(r.url + param, {
        method: "GET",
        headers: baseHeaders,
        redirect: "follow",
      });
      const html3 = await r3.text();
      const hit3 = extractFromHtml(html3);
      if (hit3) {
        return { original: hit3, method: `get${param}`, final_url: r3.url };
      }
    } catch { /* continue */ }
  }

  const finalHost = hostOf(r.url);
  if (isGood(r.url) && !BAD_DOMAINS.some((b) => finalHost.includes(b.replace(".", "")))) {
    return { original: r.url, method: "final-redirect", final_url: r.url };
  }

  throw new Error(
    `Không trích được link gốc từ ${cfg.host}. Site có thể đã đổi cấu trúc.`
  );
}

// ---- Vercel handler ----
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method === "GET") {
    res.status(200).json({
      ok: true,
      endpoint: "/api/bypass",
      method: "POST",
      supported: Object.keys(SITE_CONFIG),
    });
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ detail: "Chỉ hỗ trợ POST." });
    return;
  }

  const body = req.body || {};
  const url = (body.url || "").toString().trim();

  if (!url) {
    res.status(400).json({ detail: "Thiếu trường 'url'." });
    return;
  }

  try {
    const result = await bypass(url);
    res.status(200).json(result);
  } catch (e) {
    res.status(400).json({ detail: e.message || "Lỗi không xác định." });
  }
};
