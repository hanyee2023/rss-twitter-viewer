export async function onRequest({ request }) {
  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");

  // 跨域预检
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,OPTIONS",
        "Access-Control-Allow-Headers": "*"
      }
    });
  }

  if (!targetUrl) return new Response("缺少url参数", { status: 400 });

  // 仅放行推特媒体域名
  const allowHost = ["video.twimg.com", "pbs.twimg.com"];
  const targetHost = new URL(targetUrl).hostname;
  if (!allowHost.includes(targetHost)) {
    return Response.redirect(targetUrl, 302);
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36"
      },
      signal: AbortSignal.timeout(12000)
    });
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    // 媒体资源缓存24小时，大幅减少重复缓冲
    headers.set("Cache-Control", "public, max-age=86400");
    // 开启流式传输，视频边下载边播放，减少等待缓冲
    headers.set("Transfer-Encoding", "chunked");
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return new Response("媒体加载失败：" + err.message, { status: 502 });
  }
}
