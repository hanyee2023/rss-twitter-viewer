// ===== functions/ping.js =====
// 用途：运行日志顶部的「代理是否在线 / 本机出口 IP / 接入节点」一站式探测接口。
// 路由：GET /ping（Cloudflare Pages Functions 按文件路径自动注册，无需改 _redirects）
// 返回：200 {
//         ok: true,
//         ip:   "2409:8a62:....",   // CF-Connecting-IP：Cloudflare 看到的访客公网 IP
//         colo: "LAX",              // 请求落地的 Cloudflare 边缘节点（机场三字码）
//         country: "CN", city: "Guangzhou", region: "Guangdong", timezone: "Asia/Shanghai",
//         asn: 56040, asOrg: "China Mobile ...",
//         ts: 1790647494000
//       }
//
// 【与 /cdn-cgi/trace 的区别】（前端做降级时两者都会用到）
//   · /cdn-cgi/trace 由 Cloudflare 边缘直接返回，**不经过 Functions**，只能证明「站点可达」；
//   · 本接口由 Pages Functions 执行，能成功返回就证明「代理函数本身在跑」——这是更有力的在线证据。
//   两者都不消耗 KV、不回源任何第三方，开销可忽略（10 分钟才被前端调用一次）。
//
// 说明：colo 只是三字码，CF 运行时不提供「节点城市名」，前端用一张 IATA 表把它翻成城市/国家。

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

  const cf = (request && request.cf) || {};
  const ip = request.headers.get("CF-Connecting-IP") || cf.clientIp || "";

  const body = {
    ok: true,
    ip: ip,
    colo: cf.colo || "",
    country: cf.country || "",
    city: cf.city || "",
    region: cf.region || "",
    timezone: cf.timezone || "",
    asn: cf.asn || 0,
    asOrg: cf.asOrganization || "",
    ts: Date.now()
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: corsHeaders({
      "Content-Type": "application/json;charset=utf-8",
      "Cache-Control": "no-store"
    })
  });
}
