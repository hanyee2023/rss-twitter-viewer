// ===== functions/hls-version.js =====
// 用途：向前端提供「hls.js 上游最新版本号」，供运行日志提醒更新自托管的 js/hls.min.js。
// 路由：GET /hls-version（Cloudflare Pages Functions 按文件路径自动注册，无需改 _redirects）
// 缓存：优先读 KV（绑定名 RSS_CACHE，与 rss-proxy 共用），键 hlsver:latest，TTL 12 小时；
//       未命中时回源 registry.npmjs.org（失败再试 jsDelivr），成功后写回 KV。
// 开销：每天最多 2 次 KV 写、若干次读（免费额度：1000 写/天、100000 读/天，可忽略）。
// 返回：200 {"version":"1.6.1","source":"npm","checkedAt":1696...,"cached":false}
//       502 {"error":"..."}（上游不可达且无缓存时）

const KV_KEY = "hlsver:latest";
const KV_TTL = 12 * 60 * 60; // 12 小时

const UPSTREAMS = [
  { url: "https://registry.npmjs.org/hls.js/latest", pick: (d) => d && d.version, name: "npm" },
  { url: "https://data.jsdelivr.com/v1/package/npm/hls.js", pick: (d) => d && d.tags && d.tags.latest, name: "jsdelivr" }
];

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra
  };
}

function jsonBody(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: corsHeaders({
      "Content-Type": "application/json;charset=utf-8",
      ...extraHeaders
    })
  });
}

async function fetchLatest() {
  for (const up of UPSTREAMS) {
    try {
      const res = await fetch(up.url, {
        headers: { "Accept": "application/json", "User-Agent": "rss-twitter-viewer-hls-version-check" }
      });
      if (!res.ok) continue;
      const data = await res.json();
      const v = up.pick(data);
      if (v) return { version: String(v), source: up.name };
    } catch (e) { /* 换下一个源 */ }
  }
  return null;
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const kv = env && env.RSS_CACHE;

  // 1) KV 命中：直接返回，避免频繁回源
  if (kv) {
    try {
      const cached = await kv.get(KV_KEY, { type: "json" });
      if (cached && cached.version) {
        return jsonBody(
          { version: cached.version, source: cached.source || "", checkedAt: cached.checkedAt || 0, cached: true },
          200,
          { "Cache-Control": "public, max-age=1800" }
        );
      }
    } catch (e) { /* 读失败则继续回源 */ }
  }

  // 2) 回源取最新版本
  const latest = await fetchLatest();
  if (latest) {
    const body = { version: latest.version, source: latest.source, checkedAt: Date.now() };
    if (kv) {
      try { await kv.put(KV_KEY, JSON.stringify(body), { expirationTtl: KV_TTL }); } catch (e) { /* 写失败不影响返回 */ }
    }
    return jsonBody({ ...body, cached: false }, 200, { "Cache-Control": "public, max-age=1800" });
  }

  // 3) 彻底失败
  return jsonBody({ error: "无法获取 hls.js 最新版本（上游不可达）" }, 502, { "Cache-Control": "no-store" });
}
