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
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com", 
  "redd.it",
  "770118.xyz",
  "phe69",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com",
  // Reddit CDN 域名
  "reddit.com",
  "redd.it",
  "i.redd.it",
  "v.redd.it",
  "preview.redd.it",
  "external-preview.redd.it",
  "thumbs.redditmedia.com",
  "redditmedia.com"
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function isBlockedPrivateHost(rawUrl) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    // 解析主机名，如果是 IP 则检查是否为内网
    const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a] = ipMatch;
      return host === "0.0.0.0" ||
        host === "127.0.0.1" ||
        a === "127" ||
        a === "10" ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
        a === "169"; // 169.254.x.x link-local
    }
    // 非IP主机名，阻止明显的内网域名
    return host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal");
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
      "Cache-Control": res.ok ? "public, max-age=1800" : "no-store"
    });
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    return new Response("RSS代理失败：" + err.message, { status: 502, headers: corsHeaders({ "Cache-Control": "no-store" }) });
  }
}
