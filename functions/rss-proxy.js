export async function onRequest({ request }) {
  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");

  // 跨域OPTIONS预检
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

  if (!targetUrl) {
    return new Response("缺少url参数", { status: 400 });
  }

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
        "Accept": "application/rss+xml,application/xml;q=0.9,*/*;q=0.8"
        // 删除固定推特Referer，避免其他RSS源被拦截
      },
      signal: AbortSignal.timeout(12000) // 8000 → 12000 延长超时
    });
    const text = await res.text();
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    // RSS内容缓存5分钟
    headers.set("Cache-Control", "public, max-age=300");
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    return new Response("RSS代理失败：" + err.message, { status: 502 });
  }
}
