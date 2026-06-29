const ALLOW_RSS_PROXY_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "nitter.net",
  "video.shturl",
  "video.3go.fun"
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function hostAllowed(rawUrl) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    return ALLOW_RSS_PROXY_HOSTS.some(rule => {
      const key = normalizeHost(rule);
      return host === key || host.endsWith("." + key);
    });
  } catch (e) {
    return false;
  }
}

function isBlockedPrivateHost(rawUrl) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    return host === "localhost" ||
      host === "0.0.0.0" ||
      host === "127.0.0.1" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  } catch (e) {
    return true;
  }
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra
  };
}

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");
  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return new Response("缺少或非法url参数", { status: 400, headers: corsHeaders() });
  }
  if (isBlockedPrivateHost(targetUrl)) {
    return new Response("不允许代理内网地址", { status: 403, headers: corsHeaders() });
  }
  if (!hostAllowed(targetUrl)) {
    return new Response("该RSS域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8"
      },
      signal: AbortSignal.timeout(12000)
    });

    const text = await res.text();
    const headers = corsHeaders({
      "Content-Type": "application/xml;charset=utf-8",
      "Cache-Control": res.ok ? "public, max-age=300" : "no-store"
    });
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    return new Response("RSS代理失败：" + err.message, { status: 502, headers: corsHeaders({ "Cache-Control": "no-store" }) });
  }
}
