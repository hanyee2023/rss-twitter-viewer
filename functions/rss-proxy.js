// RSS 代理：提取/分析内容的源站转发。
// 仅对“生效 RSS 名单”内的域名提供服务（其余返回 403），与媒体代理保持一致的安全模型。
// 生效名单 = 内置默认白名单(BUILTIN_RSS_HOSTS)，不依赖 KV 用户名单。

// 与 core.js 的 FORCE_PROXY_HOSTS、media-proxy.js 的 ALLOW_PROXY_HOSTS 保持一致（见 core.js 注释）。
const BUILTIN_RSS_HOSTS = [
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
    "video.3go.fun",
    "rsshub.app",
    "venexa.site",
    "aguea.com",
    "htumeng.com",
    "642p.com",
    "tutu1.space",
    "freeshare58.com"
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

// 仅内置默认白名单，不依赖 KV 用户名单
function getRssAllowSet(env) {
  return new Set(BUILTIN_RSS_HOSTS.map(normalizeHost));
}

function hostInSet(rawUrl, allowSet) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    if (allowSet.has(host)) return true;
    for (const key of allowSet) {
      if (host.endsWith("." + key)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
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

export async function onRequest({ request, env }) {
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

  // 强制校验 RSS 代理名单（内置默认 ∪ KV 用户名单）
  const allowSet = await getRssAllowSet(env);
  if (!hostInSet(targetUrl, allowSet)) {
    return new Response("该 RSS 域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }

  // Cloudflare KV 缓存（绑定名 RSS_CACHE）。未绑定时 kv 为 undefined，
  // 自动降级为原来的实时代理，部署不报错、功能不受影响。
  const kv = env && env.RSS_CACHE;
  const cacheKey = targetUrl;

  // 命中 KV → 直接返回，毫秒级、不再回源，大幅提速并降源站压力
  if (kv) {
    try {
      const cached = await kv.get(cacheKey, { type: "json" });
      if (cached && typeof cached.body === "string") {
        return new Response(cached.body, {
          status: cached.status || 200,
          headers: corsHeaders({
            "Content-Type": cached.contentType || "application/xml;charset=utf-8",
            "Cache-Control": "public, max-age=1800",
            "X-Cache": "HIT"
          })
        });
      }
    } catch (e) {
      console.warn("RSS KV 读取失败，回退实时代理：", e);
    }
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
      "Cache-Control": res.ok ? "public, max-age=1800" : "no-store",
      "X-Cache": "MISS"
    });
    // 成功响应写入 KV，TTL 30 分钟（仅在绑定了 RSS_CACHE 时）
    if (kv && res.ok) {
      try {
        await kv.put(cacheKey, JSON.stringify({
          body: text,
          status: res.status,
          contentType: "application/xml;charset=utf-8"
        }), { expirationTtl: 1800 });
      } catch (e) {
        console.warn("RSS KV 写入失败（不影响本次返回）：", e);
      }
    }
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    // 源站失败时，若有 KV 旧数据则降级返回（即使已过期），保证可读
    if (kv) {
      try {
        const stale = await kv.get(cacheKey, { type: "json" });
        if (stale && typeof stale.body === "string") {
          return new Response(stale.body, {
            status: stale.status || 200,
            headers: corsHeaders({
              "Content-Type": stale.contentType || "application/xml;charset=utf-8",
              "Cache-Control": "public, max-age=300",
              "X-Cache": "STALE"
            })
          });
        }
      } catch (e) { /* ignore */ }
    }
    return new Response("RSS代理失败：" + err.message, { status: 502, headers: corsHeaders({ "Cache-Control": "no-store" }) });
  }
}
