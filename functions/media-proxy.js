export default {
  async fetch(request, env, ctx) {
    const urlObj = new URL(request.url);
    const path = urlObj.pathname;
    const targetUrl = urlObj.searchParams.get("url");

    // 跨域OPTIONS预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    if (!targetUrl) {
      return new Response("缺少url请求参数", { status: 400 });
    }

    // RSS代理 精确匹配 /rss-proxy
    if (path === "/rss-proxy") {
      try {
        const fetchRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
            "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
          },
          signal: AbortSignal.timeout(10000)
        });
        const rawText = await fetchRes.text();
        if(rawText.includes("<!DOCTYPE html>") || rawText.trim().length < 60) {
          throw new Error("目标返回非RSS XML");
        }
        const respHeaders = new Headers(fetchRes.headers);
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Cache-Control", "public, max-age=300");
        return new Response(rawText, { status: fetchRes.status, headers: respHeaders });
      } catch (err) {
        return new Response("RSS代理失败：" + err.message, { status: 502 });
      }
    }

    // 媒体代理 /media-proxy
    if (path === "/media-proxy") {
      const allowHosts = ["video.twimg.com", "pbs.twimg.com"];
      const targetHost = new URL(targetUrl).hostname;
      if (!allowHosts.includes(targetHost)) {
        return Response.redirect(targetUrl, 302);
      }
      try {
        const fetchRes = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
          },
          signal: AbortSignal.timeout(10000)
        });
        const respHeaders = new Headers(fetchRes.headers);
        respHeaders.set("Access-Control-Allow-Origin", "*");
        respHeaders.set("Cache-Control", "public, max-age=86400");
        return new Response(fetchRes.body, { status: fetchRes.status, headers: respHeaders });
      } catch (err) {
        return new Response("媒体代理失败：" + err.message, { status: 502 });
      }
    }

    // 核心修复：不匹配路由强制返回404，彻底禁止返回首页HTML
    return new Response("接口不存在", { status: 404 });
  }
};
