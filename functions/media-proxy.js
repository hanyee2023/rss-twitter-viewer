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

  // 【修改1】新增video.shturl.域名放行，不再直接302跳转
  const allowHost = ["video.twimg.com", "pbs.twimg.com", "video.shturl.fun"];
  const targetHost = new URL(targetUrl).hostname;
  if (!allowHost.includes(targetHost)) {
    return Response.redirect(targetUrl, 302);
  }

  try {
    // 【修改2】转发客户端Range分片请求，实现边下边播，解决长时间转圈缓冲
    const fetchHeaders = new Headers();
    fetchHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36");
    const range = request.headers.get("range");
    if (range) fetchHeaders.set("Range", range);

    const res = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(12000)
    });
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    // 【修改3】延长缓存至7天，同视频重复打开秒加载，24h太短
    headers.set("Cache-Control", "s-maxage=604800, public");
    headers.set("Vary", "Range"); // 分片缓存区分，必须加
    headers.set("Transfer-Encoding", "chunked");
    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return new Response("媒体加载失败：" + err.message, { status: 502 });
  }
}
