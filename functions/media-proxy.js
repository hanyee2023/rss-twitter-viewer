export async function onRequest({ request }) {
  const urlParams = new URL(request.url).searchParams;
  const target = urlParams.get("url");

  if (!target) {
    return new Response("缺少url参数：/media-proxy?url=媒体链接", { status: 400 });
  }

  // 仅放行推特媒体域名，其他域名直接302跳转原生链接，不占用代理额度
  const allowDomains = ["video.twimg.com", "pbs.twimg.com"];
  const targetHost = new URL(target).hostname;
  if (!allowDomains.includes(targetHost)) {
    return Response.redirect(target, 302);
  }

  try {
    const res = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });

    const newHeaders = new Headers(res.headers);
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET,OPTIONS");
    newHeaders.set("Cache-Control", "public, max-age=86400");

    return new Response(res.body, {
      status: res.status,
      headers: newHeaders
    });
  } catch (err) {
    return new Response("代理转发失败：" + err.message, { status: 502 });
  }
}
