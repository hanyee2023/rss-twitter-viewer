export async function onRequest({ request }) {
  const urlObj = new URL(request.url);
  const path = urlObj.pathname;
  const target = urlObj.searchParams.get("url");

  if (!target) {
    return new Response("缺少url参数", { status: 400 });
  }

  // ---------------- RSS订阅拉取代理接口 /rss-proxy ----------------
  if (path === "/rss-proxy") {
    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(10000)
      });
      const newHeaders = new Headers(res.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      newHeaders.set("Cache-Control", "public, max-age=300");
      return new Response(res.body, { status: res.status, headers: newHeaders });
    } catch (err) {
      return new Response("RSS代理拉取失败：" + err.message, { status: 502 });
    }
  }

  // ---------------- 推特图片视频媒体代理 /media-proxy ----------------
  if (path === "/media-proxy") {
    const allowDomains = ["video.twimg.com", "pbs.twimg.com"];
    const targetHost = new URL(target).hostname;
    if (!allowDomains.includes(targetHost)) {
      return Response.redirect(target, 302);
    }
    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(10000)
      });
      const newHeaders = new Headers(res.headers);
      newHeaders.set("Access-Control-Allow-Origin", "*");
      newHeaders.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      newHeaders.set("Cache-Control", "public, max-age=86400");
      return new Response(res.body, { status: res.status, headers: newHeaders });
    } catch (err) {
      return new Response("媒体代理转发失败：" + err.message, { status: 502 });
    }
  }

  return new Response("接口不存在", { status: 404 });
}

// 处理跨域OPTIONS预检请求
export async function onRequestOptions() {
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
