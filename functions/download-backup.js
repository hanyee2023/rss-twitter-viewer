export async function onRequestPost({ request }) {
  try {
    const { feeds } = await request.json();
    const jsonStr = JSON.stringify(feeds, null, 2);
    return new Response(jsonStr, {
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        "Content-Disposition": 'attachment; filename="rss订阅备份.json"',
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store"
      }
    })
  } catch (e) {
    return new Response("生成备份失败", { status: 400 });
  }
}

// 跨域OPTIONS预检请求
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400"
    }
  })
}
