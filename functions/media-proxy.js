export async function onRequest({ request }) {
  const urlObj = new URL(request.url);
  const path = urlObj.pathname;
  const targetUrl = urlObj.searchParams.get("url");

  if (!targetUrl) {
    return new Response("缺少url请求参数", { status: 400 });
  }

  // RSS代理路由
  if (path === "/rss-proxy") {
    try {
      const fetchRes = await fetch(targetUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        signal: AbortSignal.timeout(10000)
      });
      const rawText = await fetchRes.text();
      // 拦截HTML拦截页面
      if(rawText.includes("<!DOCTYPE html>") || rawText.trim().length < 60) {
        throw new Error("目标服务器返回非RSS XML内容");
      }
      const respHeaders = new Headers(fetchRes.headers);
      respHeaders.set("Access-Control-Allow-Origin", "*");
      respHeaders.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      respHeaders.set("Cache-Control", "public, max-age=300");
      return new Response(rawText, { status: fetchRes.status, headers: respHeaders });
    } catch (err) {
      return new Response("RSS代理请求失败：" + err.message, { status: 502 });
    }
  }

  // 媒体图片/视频代理路由
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
      respHeaders.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      respHeaders.set("Cache-Control", "public, max-age=86400");
      return new Response(fetchRes.body, { status: fetchRes.status, headers: respHeaders });
    } catch (err) {
      return new Response("媒体代理请求失败：" + err.message, { status: 502 });
    }
  }

  // 无匹配路由强制返回404，杜绝返回首页
  return new Response("接口不存在", { status: 404 });
}

// 跨域OPTIONS预检请求处理
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
