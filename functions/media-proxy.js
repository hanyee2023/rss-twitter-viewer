export async function onRequest({ request }) {
  const urlObj = new URL(request.url);
  const path = urlObj.pathname;
  const target = urlObj.searchParams.get("url");

  if (!target) {
    return new Response("缺少url参数", { status: 400 });
  }

  // RSS订阅代理 /rss-proxy
  if (path === "/rss-proxy") {
    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36",
          "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8",
          "Referer": "https://reddit.com/"
        },
        signal: AbortSignal.timeout(10000)
      });
      const rawText = await res.text();
      if(rawText.trim().length < 80 || rawText.includes("<!DOCTYPE html>")){
          throw new Error("目标返回非XML");
      }
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      headers.set("Cache-Control", "public, max-age=300");
      return new Response(rawText, { status: res.status, headers });
    } catch (err) {
      return new Response("RSS代理失败：" + err.message, { status: 502 });
    }
  }

  // 媒体代理 /media-proxy
  if (path === "/media-proxy") {
    const allowHosts = ["video.twimg.com", "pbs.twimg.com"];
    const targetHost = new URL(target).hostname;
    if (!allowHosts.includes(targetHost)) {
      return Response.redirect(target, 302);
    }
    try {
      const res = await fetch(target, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
        },
        signal: AbortSignal.timeout(10000)
      });
      const headers = new Headers(res.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "GET,OPTIONS");
      headers.set("Cache-Control", "public, max-age=86400");
      return new Response(res.body, { status: res.status, headers });
    } catch (err) {
      return new Response("媒体代理失败：" + err.message, { status: 502 });
    }
  }

  // 无匹配路由返回404，杜绝返回首页
  return new Response("接口不存在", { status: 404 });
}

// 跨域OPTIONS预检
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
