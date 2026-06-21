// 仅匹配 /rss-proxy 路由
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
        "Accept": "application/rss+xml,application/xml;q=0.9"
      },
      signal: AbortSignal.timeout(10000)
    });
    const text = await res.text();
    if (text.includes("<!DOCTYPE html>")) throw new Error("目标非RSS");
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    return new Response("RSS代理失败：" + err.message, { status: 502 });
  }
}
