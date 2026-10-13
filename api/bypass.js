// Vercel serverless function — Node 18+
// Bypass link4m.net với proxy rotation

import { ProxyAgent, fetch as undiciFetch } from "undici";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";

// ---- danh sách proxy ----
// xoay vòng, thử hết. con nào chết thì bỏ qua.
const PROXIES = [
  "http://185.135.69.34:80",
  "http://47.91.65.23:3128",
  "http://103.237.102.191:11111",
  "http://141.144.206.124:1080",
  "http://94.78.67.171:80",
  "http://195.26.224.135:80",
  "http://109.199.119.160:80",
  "http://195.114.209.50:80",
  "http://66.151.34.89:80",
  "http://108.61.29.163:10001",
];

// đọc env PROXY_URL nếu có (ưu tiên cao nhất — proxy trả tiền)
const ENV_PROXY = process.env.PROXY_URL || "";

const CAPSOLVER_KEY = process.env.CAPSOLVER_KEY || "";

function allProxies() {
  const list = ENV_PROXY ? [ENV_PROXY, ...PROXIES] : [...PROXIES];
  // shuffle
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function agentFor(proxyUrl) {
  return new ProxyAgent({
    uri: proxyUrl,
    requestTls: { rejectUnauthorized: false },
    connect: { timeout: 8000 },
  });
}

// fetch với retry qua nhiều proxy
async function fetchRetry(url, init = {}, { tries = 5, timeoutMs = 12000 } = {}) {
  const proxies = allProxies().slice(0, tries);
  let lastErr = null;

  for (const proxy of proxies) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await undiciFetch(url, {
        ...init,
        dispatcher: agentFor(proxy),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (r.ok) return { response: r, proxy };
      lastErr = new Error(`HTTP ${r.status} via ${proxy}`);
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
    }
  }
  throw lastErr || new Error("Tất cả proxy fail");
}

function parseAttrs(html) {
  const aliasM = html.match(/data-alias\s*=\s*["']([^"']+)["']/);
  const codeM = html.match(/data-code\s*=\s*["']([^"']+)["']/);
  const apiM = html.match(/api_domain\s*=\s*['"]([^'"]+)['"]/);
  const sitekeyM = html.match(/recaptcha_key\s*=\s*['"]([^'"]+)['"]/);
  return {
    alias: aliasM?.[1] || null,
    code: codeM?.[1] || null,
    apiDomain: apiM?.[1] || "https://s1.link4m.app",
    sitekey: sitekeyM?.[1] || "6LcQsTQgAAAAADNQ_pCfukfvS0i9lk4oJTVSs5bZ",
  };
}

function setCookiesFromResponse(r) {
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  return sc.map((c) => c.split(";")[0]).join("; ");
}

async function getAdvertise(apiDomain, alias, code, cookies) {
  const { response } = await fetchRetry(`${apiDomain}/api/campaign/get-advertise`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://link4m.net",
      Referer: "https://link4m.net/",
      Cookie: cookies || "",
    },
    body: new URLSearchParams({ alias, codes: code }).toString(),
  });
  return response.json();
}

async function checkCaptcha(apiDomain, alias, code, token, cookies) {
  const { response } = await fetchRetry(`${apiDomain}/links/check-captcha`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      "X-Requested-With": "XMLHttpRequest",
      Origin: "https://link4m.net",
      Referer: `https://link4m.net/go/${alias}`,
      Cookie: cookies || "",
    },
    body: new URLSearchParams({
      alias,
      code,
      "g-recaptcha-response": token,
    }).toString(),
  });
  return response.json();
}

async function solveRecaptcha(sitekey, pageUrl) {
  if (!CAPSOLVER_KEY) throw new Error("Chưa set CAPSOLVER_KEY");

  const create = await fetch("https://api.capsolver.com/createTask", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: CAPSOLVER_KEY,
      task: {
        type: "ReCaptchaV2TaskProxyLess",
        websiteURL: pageUrl,
        websiteKey: sitekey,
      },
    }),
  }).then((r) => r.json());

  if (!create.taskId) throw new Error(`CapSolver: ${JSON.stringify(create)}`);

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch("https://api.capsolver.com/getTaskResult", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientKey: CAPSOLVER_KEY, taskId: create.taskId }),
    }).then((r) => r.json());

    if (res.status === "ready") {
      return res.solution.gRecaptchaResponse || res.solution.token;
    }
    if (res.errorId) throw new Error(`CapSolver: ${JSON.stringify(res)}`);
  }
  throw new Error("CapSolver timeout");
}

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method === "GET")
    return res.json({ ok: true, endpoint: "POST /api/bypass", body: { url: "..." } });
  if (req.method !== "POST") return res.status(405).json({ detail: "Chỉ POST." });

  const body = req.body || {};
  const url = (body.url || "").toString().trim();

  if (!/^https?:\/\/link4m\.(net|com|co)\//.test(url)) {
    return res.status(400).json({ detail: "Chỉ hỗ trợ link4m.net/.com/.co" });
  }

  try {
    // 1. GET page với proxy rotation
    const { response: r1, proxy: usedProxy } = await fetchRetry(url, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "vi-VN,vi;q=0.9,en;q=0.8",
      },
      redirect: "follow",
    });

    const html1 = await r1.text();
    const cookies = setCookiesFromResponse(r1);
    const { alias, code, apiDomain, sitekey } = parseAttrs(html1);

    if (!alias || !code) {
      const direct = html1.match(/window\.location(?:\.href)?\s*=\s*["']([^"']+)["']/);
      if (direct && !direct[1].includes("link4m.")) {
        return res.json({ original: direct[1], method: "direct-html", final_url: url, proxy: usedProxy });
      }
      throw new Error("Không có alias/code trong HTML. Có thể proxy bị CF chặn.");
    }

    // 2. get-advertise
    const adv = await getAdvertise(apiDomain, alias, code, cookies);

    if (adv.window_url && !/link4m\./.test(adv.window_url)) {
      return res.json({
        original: adv.window_url,
        method: "get-advertise-window-url",
        final_url: url,
        proxy: usedProxy,
      });
    }

    if (adv.html) {
      const m = adv.html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/);
      if (m && !/link4m\./.test(m[1])) {
        return res.json({ original: m[1], method: "advertise-html", final_url: url, proxy: usedProxy });
      }
    }

    // 3. captcha
    if (!CAPSOLVER_KEY) {
      throw new Error("Server yêu cầu captcha. Cần set CAPSOLVER_KEY.");
    }

    const token = await solveRecaptcha(sitekey, `https://link4m.net/go/${alias}`);
    const check = await checkCaptcha(apiDomain, alias, code, token, cookies);

    if (check.success && check.url && !/link4m\./.test(check.url)) {
      return res.json({ original: check.url, method: "captcha-solved", final_url: url, proxy: usedProxy });
    }

    if (check.html) {
      const m = check.html.match(/href\s*=\s*["'](https?:\/\/[^"']+)["']/);
      if (m && !/link4m\./.test(m[1])) {
        return res.json({ original: m[1], method: "captcha-html", final_url: url, proxy: usedProxy });
      }
    }

    throw new Error(`Không trích được link. Response: ${JSON.stringify(check).slice(0, 300)}`);
  } catch (e) {
    res.status(400).json({ detail: e.message || "Lỗi không xác định" });
  }
}
