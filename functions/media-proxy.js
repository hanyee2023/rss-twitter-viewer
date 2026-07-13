const ALLOW_PROXY_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "nitter.net",
  "xxxfollow.com",
  "media.redgifs.com" 
  "redd.it"
  "770118.xyz"
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

function hostAllowed(rawUrl) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    return ALLOW_PROXY_HOSTS.some(rule => {
      const key = normalizeHost(rule);
      return host === key || host.endsWith("." + key);
    });
  } catch (e) {
    return false;
  }
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function buildProxyUrl(requestUrl, targetUrl) {
  const current = new URL(requestUrl);
  const proxy = new URL(current.pathname, current.origin);
  proxy.searchParams.set("url", targetUrl);
  return proxy.toString();
}

function resolveM3u8Url(line, baseUrl) {
  const value = String(line || "").trim();
  if (!value || value.startsWith("#")) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch (e) {
    return value;
  }
}

function rewriteUriAttributes(line, baseUrl, requestUrl) {
  return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
    try {
      const resolved = new URL(uri, baseUrl).toString();
      if (!hostAllowed(resolved)) return match;
      return `URI="${buildProxyUrl(requestUrl, resolved)}"`;
    } catch (e) {
      return match;
    }
  });
}

function rewriteM3u8Text(text, baseUrl, requestUrl) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#") && /URI="/i.test(trimmed)) {
        return rewriteUriAttributes(line, baseUrl, requestUrl);
      }
      if (trimmed.startsWith("#")) return line;

      const resolved = resolveM3u8Url(trimmed, baseUrl);
      if (!isHttpUrl(resolved) || !hostAllowed(resolved)) return line;
      return buildProxyUrl(requestUrl, resolved);
    })
    .join("\n");
}

function isLikelyM3u8(targetUrl, res) {
  const contentType = res.headers.get("content-type") || "";
  return /\.m3u8(?:$|\?)/i.test(targetUrl) ||
    /mpegurl|vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(contentType);
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,Content-Type",
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
  if (!hostAllowed(targetUrl)) {
    return new Response("该媒体域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }

  try {
    const fetchHeaders = new Headers();
    fetchHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36");
    fetchHeaders.set("Accept", "*/*");
    const range = request.headers.get("range");
    if (range) fetchHeaders.set("Range", range);

    const res = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(15000)
    });

    if (isLikelyM3u8(targetUrl, res)) {
      const text = await res.text();
      const rewritten = rewriteM3u8Text(text, targetUrl, request.url);
      return new Response(rewritten, {
        status: res.status,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
          "Cache-Control": "no-store"
        })
      });
    }

    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");
    headers.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type");
    headers.set("Cache-Control", "s-maxage=604800, public");
    headers.set("Vary", "Range");
    headers.delete("Transfer-Encoding");

    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return new Response("媒体代理失败：" + err.message, { status: 502, headers: corsHeaders() });
  }
}
