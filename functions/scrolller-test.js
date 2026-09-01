/**
 * scrolller-test.js — Scrolller GraphQL 诊断接口（v5 极简重写版）
 *
 * 整个文件只有一个超简单的 onRequest：
 *   1. POST 调用 Scrolller GraphQL 拿 3 条视频
 *   2. 对每个 mediaSources URL 服务端实测可访问性
 *   3. 输出 HTML 表格，手机友好
 *
 * v5 与之前最大区别：把所有逻辑写成顺序 await，不再有
 * 函数嵌套 / 闭包引用 / 多次参数传递，根除"变量未定义"这类 bug。
 */

const SCROLLLER_API = "https://api.scrolller.com/api/v2/graphql";
const VERSION = "scrolller-test v5 (极简重写版)";

// CF Pages Functions 标准入口
export async function onRequest({ request }) {
  const reqUrl = new URL(request.url);
  const sub  = (reqUrl.searchParams.get("sub")  || "interestingasfuck").trim();
  const flt  = (reqUrl.searchParams.get("filter") || "").trim();
  const lim  = Math.min(10, Math.max(1, parseInt(reqUrl.searchParams.get("limit") || "3", 10) || 3));

  // 1. 组装并发送 GraphQL 查询
  const query = `query SubredditQuery($url: String!, $filter: SubredditPostFilter, $iterator: String) {
    getSubreddit(url: $url) {
      children(limit: ${lim}, iterator: $iterator, filter: $filter, disabledHosts: null) {
        iterator
        items {
          url
          title
          subredditTitle
          isNsfw
          mediaSources { url width height isOptimized }
        }
      }
    }
  }`;
  const payload = { query, variables: { url: sub.startsWith("/r/") ? sub : "/r/" + sub, filter: flt || null } };

  // 准备请求头（带 Origin/Referer 防 Scrolller 404）
  const reqHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Origin": (request.headers.get("origin") || "https://api.scrolller.com"),
    "Referer": (request.headers.get("referer") || "https://api.scrolller.com/")
  };

  // 2. 调 Scrolller
  let apiStatus = 0, apiOk = false, apiItems = [], apiError = "";
  try {
    const apiRes = await fetch(SCROLLLER_API, { method: "POST", headers: reqHeaders, body: JSON.stringify(payload) });
    apiStatus = apiRes.status;
    const apiText = await apiRes.text();
    let apiJson;
    try { apiJson = JSON.parse(apiText); } catch (e) { apiJson = null; }
    if (apiJson && apiJson.data && apiJson.data.getSubreddit && apiJson.data.getSubreddit.children) {
      apiOk = true;
      apiItems = apiJson.data.getSubreddit.children.items || [];
    } else {
      apiError = "API 未返回预期数据 (HTTP " + apiStatus + "): " + apiText.slice(0, 200);
    }
  } catch (e) {
    apiError = "网络请求失败: " + (e && e.message ? e.message : e);
  }

  // 3. 实测媒体 URL（服务端带 Range 头 GET）
  const probes = [];
  if (apiOk) {
    for (const it of apiItems) {
      for (const src of (it.mediaSources || [])) {
        if (probes.length >= 8 || !src || !src.url) continue;
        const probeUrl = src.url;
        let probeResult = { url: probeUrl, width: src.width, height: src.height, ok: false, status: "ERR", contentType: "", acceptRanges: "", contentLength: "", head: "", denied: false, isVideo: false, seekable: false, error: "" };
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10000);
          const r = await fetch(probeUrl, {
            method: "GET",
            headers: {
              "Range": "bytes=0-2047",
              "User-Agent": reqHeaders["User-Agent"],
              "Referer": "https://scrolller.com/",
              "Accept": "*/*"
            },
            signal: controller.signal,
            redirect: "follow"
          });
          clearTimeout(timer);
          probeResult.status = r.status;
          probeResult.contentType = r.headers.get("content-type") || "";
          probeResult.contentLength = r.headers.get("content-length") || "";
          probeResult.acceptRanges = r.headers.get("accept-ranges") || "";
          // 只读前 300 字节判断是否是 AccessDenied，随即中断避免下载整个视频
          let headBuf = "";
          try {
            const reader = r.body && r.body.getReader ? r.body.getReader() : null;
            if (reader) {
              const { value } = await reader.read();
              headBuf = new TextDecoder().decode(value || new Uint8Array()).slice(0, 300);
              reader.cancel().catch(() => {});
            }
          } catch (e) {}
          probeResult.head = headBuf;
          probeResult.denied = /AccessDenied|access denied|Blocked/i.test(headBuf);
          probeResult.isVideo = /video|mp4|webm/i.test(probeResult.contentType) || /\.mp4(\?|$)/i.test(probeUrl);
          probeResult.seekable = !!probeResult.acceptRanges;
          probeResult.ok = (r.status === 200 || r.status === 206) && !probeResult.denied;
        } catch (e) {
          probeResult.error = (e && e.message ? e.message : String(e));
        }
        probes.push(probeResult);
      }
    }
  }

  // 4. 统计
  const domainMap = {};
  for (const p of probes) {
    try { const h = new URL(p.url).hostname; domainMap[h] = (domainMap[h] || 0) + 1; } catch (e) {}
  }
  const videoProbes = probes.filter(p => p.isVideo);
  const videoOk = videoProbes.filter(p => p.ok).length;
  const allOk = probes.filter(p => p.ok).length;

  // 5. 渲染 HTML
  const esc = (s) => String(s == null ? "" : s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const badge = (ok, txt) => `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;color:${ok?'#0a7d34':'#b3261e'};background:${ok?'#e6f4ea':'#fce8e6'}">${esc(txt)}</span>`;

  const probeBlock = probes.map(p => {
    let v;
    if (p.status === "ERR") v = badge(false, "请求异常") + ` <span style="color:#666">${esc(p.error)}</span>`;
    else if (p.denied) v = badge(false, "❌ 被拒绝 (AccessDenied)") + ` <span style="color:#b3261e">和 redlib 那条死路一样 —— 无签名直链被 S3 拒绝</span>`;
    else if (p.ok && p.isVideo) v = badge(true, "✅ 视频可播" + (p.seekable ? " · 可拖动" : "")) + ` <span style="color:#0a7d34">HTTP ${p.status} · ${esc(p.contentType)}</span>`;
    else if (p.ok) v = badge(true, "✅ 图片可显示") + ` <span style="color:#0a7d34">HTTP ${p.status} · ${esc(p.contentType)}</span>`;
    else v = badge(false, "❌ HTTP " + p.status) + ` <span style="color:#b3261e">${esc(p.contentType || "无响应")}</span>`;

    let dom = "(?)"; try { dom = new URL(p.url).hostname; } catch (e) {}
    const urlShort = p.url.length > 110 ? p.url.slice(0, 110) + "…" : p.url;
    return `<div style="margin:8px 0;padding:10px;background:#fff;border:1px solid #e3e3e3;border-radius:8px">
      <div style="margin-bottom:6px">${v}</div>
      <div style="font-size:11px;color:#888;margin-bottom:4px">
        域名 <b style="color:#333">${esc(dom)}</b>${p.width?` · ${p.width}×${p.height}`:""}${p.contentLength?` · ${p.contentLength}B`:""}${p.acceptRanges?` · Range:${esc(p.acceptRanges)}`:""}
      </div>
      <div style="word-break:break-all;font-size:11px;font-family:monospace;background:#fafafa;padding:6px;border-radius:4px">
        <a href="${esc(p.url)}" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">${esc(urlShort)} ↗</a>
      </div>
      ${p.head && p.denied ? `<pre style="margin:6px 0 0;font-size:10px;color:#b3261e;background:#fff5f5;padding:6px;border-radius:4px;overflow:auto">${esc(p.head.slice(0,280))}</pre>` : ""}
    </div>`;
  }).join("");

  const itemsBlock = apiItems.map((it, i) => {
    const itsProbes = probes.filter(p => (it.mediaSources || []).some(s => s.url === p.url));
    return `<div style="margin:14px 0;padding:12px;background:#fafafa;border-radius:10px;border-left:4px solid #1a73e8">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px">${i + 1}. ${esc(it.title || "(无标题)")}</div>
      <div style="font-size:11px;color:#888;margin-bottom:8px">
        ${it.isNsfw ? '<span style="color:#b3261e;font-weight:600">🔞 NSFW</span>' : "SFW"}${it.subredditTitle ? ` · ${esc(it.subredditTitle)}` : ""}
        · ${(it.mediaSources||[]).length} 个媒体源
      </div>
      ${itsProbes.length ? itsProbes.map(p => probeBlock).join("") : (it.mediaSources||[]).map(s => `<div style="font-size:12px;margin:6px 0;padding:8px;background:#fff;border:1px solid #eee;border-radius:6px"><div style="font-size:11px;color:#888">${s.width}×${s.height}</div><div style="word-break:break-all;font-size:11px;font-family:monospace">${esc(s.url)}</div></div>`).join("")}
    </div>`;
  }).join("");

  const domainBlock = Object.keys(domainMap).length
    ? `<div style="margin:16px 0;padding:12px;background:#eef4ff;border-radius:10px"><div style="font-weight:600;margin-bottom:6px">📊 媒体域名分布</div>${Object.entries(domainMap).map(([d,c]) => `<div style="font-size:13px;font-family:monospace">${esc(d)} — ${c} 个</div>`).join("")}</div>`
    : "";

  const summaryBlock = probes.length
    ? `<div style="margin:16px 0;padding:14px;background:${videoProbes.length ? (videoOk ? "#e6f4ea" : "#fce8e6") : "#f5f5f5"};border-radius:10px">
        <div style="font-size:15px;font-weight:700;margin-bottom:6px">${
          videoProbes.length
            ? (videoOk ? `🎬 视频结论：${videoOk}/${videoProbes.length} 个视频源实测可播`
                       : `🎬 视频结论：${videoProbes.length} 个视频源全部不可播（疑似 S3 拒绝）`)
            : "（本次未测到视频源，试试 filter=VIDEO）"
        }</div>
        <div style="font-size:12px;color:#555">全部媒体源：${allOk}/${probes.length} 可访问</div>
      </div>`
    : "";

  const apiBlock = apiOk
    ? `<p>${badge(true, "✅ API 正常")} HTTP ${apiStatus} · 返回 <b>${apiItems.length}</b> 条 · 子版块 <code>${esc("/r/" + sub.replace(/^\/r\//, ""))}</code></p>`
    : `<p>${badge(false, "❌ API 失败")} ${esc(apiError)}</p>`;

  return new Response(`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scrolller 诊断</title></head>
<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;color:#202124;line-height:1.5">
<div style="max-width:820px;margin:0 auto">
  <h2 style="margin:0 0 4px">Scrolller Reddit 订阅 · 诊断</h2>
  <div style="font-size:12px;color:#888;margin-bottom:4px">CF 服务端实测 = 阅读器实际播放路径</div>
  <div style="font-size:13px;color:#fff;background:#1a73e8;padding:6px 12px;border-radius:4px;display:inline-block;margin-bottom:16px;font-weight:600">📦 ${esc(VERSION)}</div>

  <form method="GET" style="margin-bottom:16px;padding:12px;background:#fff;border-radius:10px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <input name="sub" value="${esc(sub)}" placeholder="子版块" style="padding:7px;border:1px solid #ccc;border-radius:6px;width:140px;font-size:13px">
      <select name="filter" style="padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px">
        ${["", "VIDEO", "SOUND", "PICTURE"].map(f => `<option value="${f}" ${flt===f?"selected":""}>${f||"全部"}</option>`).join("")}
      </select>
      <input name="limit" type="number" min="1" max="10" value="${lim}" style="padding:7px;border:1px solid #ccc;border-radius:6px;width:64px;font-size:13px">
      <button type="submit" style="padding:7px 16px;background:#1a73e8;color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer">重新诊断</button>
    </div>
  </form>

  ${apiBlock}
  ${summaryBlock}
  ${domainBlock}
  ${itemsBlock}

  <div style="font-size:11px;color:#aaa;margin-top:16px">${esc(reqUrl.origin)}</div>
</div></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate" }
  });
}