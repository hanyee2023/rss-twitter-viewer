/**
 * scrolller-test.js — Scrolller GraphQL API 诊断接口（临时诊断用）
 *
 * 用途：验证 Scrolller 能否用于 Reddit 订阅，重点回答三个问题
 *   1. 视频 mediaSources 的真实域名是什么？
 *      v.redd.it 无签名 = 死路（和 redlib 一样被 S3 拒绝）
 *      Scrolller 自有 CDN = 可播
 *   2. 这些 URL 服务端实测是否真的可访问？
 *      200/206 + video/mp4 + Accept-Ranges = 能播且能拖动
 *      403 + AccessDenied = 死路
 *      注意：CF 服务端请求源站，正是阅读器 media-proxy 的实际路径，结果权威
 *   3. GraphQL 内省：SubredditPostFilter 有哪些字段？能否排序（hot/top/new）？
 *
 * 访问示例：
 *   /scrolller-test?sub=interestingasfuck&filter=VIDEO&limit=3
 *   /scrolller-test?sub=pics&filter=PICTURE&limit=5
 *   /scrolller-test?introspect=1
 *
 * 参数：
 *   sub        子版块名（默认 interestingasfuck）
 *   filter     PICTURE / VIDEO / SOUND / 空=全部
 *   limit      条数（默认 3，最大 10）
 *   probe      1=实测媒体URL（默认1） 0=跳过
 *   introspect 1=执行 GraphQL 内省
 *   raw        1=输出原始 JSON
 */

const SCROLLLER_API = "https://api.scrolller.com/api/v2/graphql";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/* ---------- 工具 ---------- */

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function domainOf(url) {
  try { return new URL(url).hostname; } catch (e) { return "(解析失败)"; }
}

function fmtSize(len) {
  const n = parseInt(len, 10);
  if (!n || isNaN(n)) return "—";
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

/* ---------- 1. 调用 Scrolller GraphQL（POST） ---------- */

function buildSubredditQuery(limit) {
  return `query SubredditQuery($url: String!, $filter: SubredditPostFilter, $iterator: String) {
  getSubreddit(url: $url) {
    children(limit: ${limit}, iterator: $iterator, filter: $filter, disabledHosts: null) {
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
}

async function scrolllerFetch(sub, filter, limit) {
  const subPath = String(sub || "").trim().startsWith("/r/")
    ? String(sub).trim()
    : "/r/" + String(sub || "").trim();

  const payload = {
    query: buildSubredditQuery(limit),
    variables: { url: subPath, filter: filter || null }
  };

  const started = Date.now();
  let status = 0, text = "";
  try {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json",
      "User-Agent": UA
    };
    // 仅当请求从 CF Pages 调用 API 时，需要 Origin/Referer
    // Scrolller 后端会校验这两个头，否则返回 404
    const origin = request.headers.get("origin");
    const referer = request.headers.get("referer") || url.origin + url.pathname;
    headers["Origin"] = origin || "https://api.scrolller.com";
    headers["Referer"] = referer;

    const res = await fetch(SCROLLLER_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    return { ok: false, error: "网络请求失败: " + String(e.message || e), ms: Date.now() - started };
  }

  const ms = Date.now() - started;
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }

  if (!json || !json.data || !json.data.getSubreddit) {
    return {
      ok: false, status, ms,
      error: "API 未返回预期数据（可能是反爬/限流/参数错误）",
      preview: text.slice(0, 500)
    };
  }

  const children = json.data.getSubreddit.children || {};
  return {
    ok: true, status, ms,
    subPath,
    iterator: children.iterator || "",
    items: children.items || [],
    errors: json.errors || null,
    raw: json
  };
}

/* ---------- 2. 实测媒体 URL 可访问性 ---------- */

async function probeUrl(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  const out = { url, domain: domainOf(url) };
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Range": "bytes=0-2047",
        "User-Agent": UA,
        "Referer": "https://scrolller.com/",
        "Accept": "*/*"
      },
      signal: controller.signal,
      redirect: "follow"
    });
    clearTimeout(timer);

    out.status = res.status;
    out.contentType = res.headers.get("content-type") || "";
    out.contentLength = res.headers.get("content-length") || "";
    out.acceptRanges = res.headers.get("accept-ranges") || "";
    out.contentRange = res.headers.get("content-range") || "";

    // 只读前一小段用于识别 AccessDenied XML，随即中断，避免下载整个视频
    let head = "";
    try {
      const reader = res.body && res.body.getReader ? res.body.getReader() : null;
      if (reader) {
        const { value } = await reader.read();
        head = new TextDecoder().decode(value || new Uint8Array()).slice(0, 300);
        reader.cancel().catch(() => {});
      }
    } catch (e) { /* 忽略读取失败 */ }
    out.head = head;

    out.denied = /AccessDenied|access denied|Blocked/i.test(head);
    out.ok = (res.status === 200 || res.status === 206) && !out.denied;
    out.isVideo = /video|mp4|webm/i.test(out.contentType) || /\.mp4(\?|$)/i.test(url);
    out.seekable = !!out.acceptRanges || !!out.contentRange;
  } catch (e) {
    clearTimeout(timer);
    out.ok = false;
    out.status = "ERR";
    out.error = String(e && e.message ? e.message : e);
  }
  return out;
}

/* ---------- 3. GraphQL 内省：查筛选/排序能力 ---------- */

async function introspect() {
  const queries = {
    filter: `{ __type(name: "SubredditPostFilter") { name kind enumValues { name description } inputFields { name type { name } } } }`,
    types: `{ __schema { types { name kind } } }`
  };
  const result = {};
  for (const [key, q] of Object.entries(queries)) {
    try {
      const res = await fetch(SCROLLLER_API, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify({ query: q })
      });
      const json = await res.json();
      result[key] = json;
    } catch (e) {
      result[key] = { error: String(e && e.message ? e.message : e) };
    }
  }
  // 从全部类型名里挑出可能与"排序"相关的
  const allTypes = (result.types && result.types.data && result.types.data.__schema
    && result.types.data.__schema.types) || [];
  result.sortCandidates = allTypes
    .map(t => t.name)
    .filter(n => /sort|order|rank|top|hot|new/i.test(n))
    .slice(0, 40);
  return result;
}

/* ---------- 4. 渲染诊断页面 ---------- */

function badge(ok, text) {
  const color = ok ? "#0a7d34" : "#b3261e";
  const bg = ok ? "#e6f4ea" : "#fce8e6";
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;font-weight:600;color:${color};background:${bg};border:1px solid ${color}33">${escapeHtml(text)}</span>`;
}

function renderProbe(p) {
  if (p.status === "ERR") {
    return `<div style="margin:6px 0;padding:8px;background:#f5f5f5;border-radius:6px;font-size:12px">
      ${badge(false, "请求异常")} <span style="color:#666">${escapeHtml(p.error)}</span></div>`;
  }
  let verdict, detail;
  if (p.denied) {
    verdict = badge(false, "❌ 被拒绝 (AccessDenied)");
    detail = `<span style="color:#b3261e">这就是 redlib 那条死路 —— 无签名直链被 S3 拒绝</span>`;
  } else if (p.ok && p.isVideo) {
    verdict = badge(true, "✅ 视频可播" + (p.seekable ? " · 可拖动" : ""));
    detail = `<span style="color:#0a7d34">HTTP ${p.status} · ${escapeHtml(p.contentType)}</span>`;
  } else if (p.ok) {
    verdict = badge(true, "✅ 图片可显示");
    detail = `<span style="color:#0a7d34">HTTP ${p.status} · ${escapeHtml(p.contentType)}</span>`;
  } else {
    verdict = badge(false, "❌ HTTP " + p.status);
    detail = `<span style="color:#b3261e">${escapeHtml(p.contentType || "无响应")}</span>`;
  }
  const urlShort = p.url.length > 110 ? p.url.slice(0, 110) + "…" : p.url;
  return `<div style="margin:8px 0;padding:10px;background:#fff;border:1px solid #e3e3e3;border-radius:8px">
    <div style="margin-bottom:6px">${verdict} ${detail}</div>
    <div style="font-size:11px;color:#888;margin-bottom:4px">
      域名 <b style="color:#333">${escapeHtml(p.domain)}</b>
      ${p.width ? ` · ${p.width}×${p.height}` : ""}
      ${p.contentLength ? ` · ${fmtSize(p.contentLength)}` : ""}
      ${p.acceptRanges ? ` · Range:${escapeHtml(p.acceptRanges)}` : ""}
    </div>
    <div style="word-break:break-all;font-size:11px;font-family:monospace;background:#fafafa;padding:6px;border-radius:4px">
      <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener" style="color:#1a73e8;text-decoration:none">${escapeHtml(urlShort)} ↗</a>
    </div>
    ${p.head && p.denied ? `<pre style="margin:6px 0 0;font-size:10px;color:#b3261e;background:#fff5f5;padding:6px;border-radius:4px;overflow:auto">${escapeHtml(p.head.slice(0,280))}</pre>` : ""}
  </div>`;
}

function renderPage(ctx) {
  const { params, api, probes, intro, vercelUrl } = ctx;

  const domainStat = {};
  probes.forEach(p => { domainStat[p.domain] = (domainStat[p.domain] || 0) + 1; });

  const apiBlock = api.ok
    ? `<p>${badge(true, "✅ API 正常")} HTTP ${api.status} · ${api.ms}ms · 返回 <b>${api.items.length}</b> 条 · 子版块 <code>${escapeHtml(api.subPath)}</code></p>`
    : `<p>${badge(false, "❌ API 失败")} ${escapeHtml(api.error || "未知错误")}</p>
       ${api.preview ? `<pre style="font-size:11px;background:#fff5f5;padding:8px;border-radius:6px;overflow:auto">${escapeHtml(api.preview)}</pre>` : ""}
       ${api.status ? `<p style="font-size:12px;color:#666">HTTP ${api.status}</p>` : ""}`;

  const itemsBlock = api.ok && api.items.length ? api.items.map((it, i) => {
    const srcs = it.mediaSources || [];
    // 媒体源按 items 顺序与 probes 对齐：probes 是扁平化后的列表
    return `<div style="margin:14px 0;padding:12px;background:#fafafa;border-radius:10px;border-left:4px solid #1a73e8">
      <div style="font-weight:600;font-size:14px;margin-bottom:4px">${i + 1}. ${escapeHtml(it.title || "(无标题)")}</div>
      <div style="font-size:11px;color:#888;margin-bottom:8px">
        ${it.isNsfw ? '<span style="color:#b3261e;font-weight:600">🔞 NSFW</span>' : "SFW"}
        ${it.subredditTitle ? ` · ${escapeHtml(it.subredditTitle)}` : ""}
        · ${srcs.length} 个媒体源
      </div>
      ${srcs.map(s => {
        const probe = probes.find(p => p.url === s.url);
        const html = probe ? renderProbe(probe) : "";
        return html || `<div style="font-size:12px;margin:6px 0;padding:8px;background:#fff;border:1px solid #eee;border-radius:6px">
          <div style="font-size:11px;color:#888">${s.width}×${s.height}</div>
          <div style="word-break:break-all;font-size:11px;font-family:monospace">${escapeHtml(s.url)}</div></div>`;
      }).join("")}
    </div>`;
  }).join("") : "";

  const domainBlock = Object.keys(domainStat).length
    ? `<div style="margin:16px 0;padding:12px;background:#eef4ff;border-radius:10px">
        <div style="font-weight:600;margin-bottom:6px">📊 媒体域名分布（决定视频生死）</div>
        ${Object.entries(domainStat).map(([d, c]) =>
          `<div style="font-size:13px;font-family:monospace">${escapeHtml(d)} — ${c} 个</div>`
        ).join("")}
      </div>` : "";

  let introBlock = "";
  if (intro) {
    const ft = intro.filter && intro.filter.data && intro.filter.data.__type;
    const enumVals = ft && ft.enumValues ? ft.enumValues.map(e => e.name).join(" / ") : "";
    const inputF = ft && ft.inputFields ? ft.inputFields.map(f => f.name).join(", ") : "";
    introBlock = `<div style="margin:16px 0;padding:12px;background:#fffbea;border-radius:10px">
      <div style="font-weight:600;margin-bottom:6px">🔍 GraphQL 内省结果</div>
      <div style="font-size:12px">
        <div><b>SubredditPostFilter 类型：</b> ${ft ? escapeHtml(ft.kind || "未知") : "未取到"}</div>
        ${enumVals ? `<div><b>可选值：</b> <code>${escapeHtml(enumVals)}</code></div>` : ""}
        ${inputF ? `<div><b>输入字段：</b> <code>${escapeHtml(inputF)}</code></div>` : ""}
        <div style="margin-top:6px"><b>可能与排序相关的类型：</b>
          ${intro.sortCandidates && intro.sortCandidates.length
            ? `<code style="font-size:11px">${escapeHtml(intro.sortCandidates.join(", "))}</code>`
            : '<span style="color:#b3261e">未发现 —— 说明 Scrolller 大概率不支持自定义排序</span>'}
        </div>
      </div>
    </div>`;
  }

  const okCount = probes.filter(p => p.ok).length;
  const videoProbes = probes.filter(p => p.isVideo);
  const videoOk = videoProbes.filter(p => p.ok).length;

  const summary = probes.length ? `<div style="margin:16px 0;padding:14px;background:${videoProbes.length ? (videoOk ? "#e6f4ea" : "#fce8e6") : "#f5f5f5"};border-radius:10px">
      <div style="font-size:15px;font-weight:700;margin-bottom:6px">
        ${videoProbes.length
          ? (videoOk ? `🎬 视频结论：${videoOk}/${videoProbes.length} 个视频源实测可播`
                     : `🎬 视频结论：${videoProbes.length} 个视频源全部不可播（疑似 S3 拒绝）`)
          : "（本次未测到视频源，试试 filter=VIDEO）"}
      </div>
      <div style="font-size:12px;color:#555">全部媒体源：${okCount}/${probes.length} 可访问</div>
    </div>` : "";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Scrolller 诊断</title></head>
<body style="margin:0;padding:16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;background:#f0f2f5;color:#202124;line-height:1.5">
<div style="max-width:820px;margin:0 auto">
  <h2 style="margin:0 0 4px">Scrolller Reddit 订阅 · 诊断</h2>
  <div style="font-size:12px;color:#888;margin-bottom:16px">CF 服务端实测 = 阅读器实际播放路径，结果权威</div>

  <form method="GET" style="margin-bottom:16px;padding:12px;background:#fff;border-radius:10px">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
      <input name="sub" value="${escapeHtml(params.sub)}" placeholder="子版块" style="padding:7px;border:1px solid #ccc;border-radius:6px;width:140px;font-size:13px">
      <select name="filter" style="padding:7px;border:1px solid #ccc;border-radius:6px;font-size:13px">
        ${["", "VIDEO", "SOUND", "PICTURE"].map(f =>
          `<option value="${f}" ${params.filter === f ? "selected" : ""}>${f || "全部"}</option>`).join("")}
      </select>
      <input name="limit" type="number" min="1" max="10" value="${escapeHtml(params.limit)}" style="padding:7px;border:1px solid #ccc;border-radius:6px;width:64px;font-size:13px">
      <label style="font-size:12px"><input type="checkbox" name="probe" value="1" ${params.probe ? "checked" : ""}> 实测URL</label>
      <label style="font-size:12px"><input type="checkbox" name="introspect" value="1" ${params.introspect ? "checked" : ""}> 内省</label>
      <button type="submit" style="padding:7px 16px;background:#1a73e8;color:#fff;border:0;border-radius:6px;font-size:13px;cursor:pointer">重新诊断</button>
    </div>
  </form>

  ${apiBlock}
  ${summary}
  ${domainBlock}
  ${itemsBlock}
  ${introBlock}

  <details style="margin-top:16px;background:#fff;padding:10px;border-radius:8px">
    <summary style="cursor:pointer;font-size:13px">查看 API 原始返回</summary>
    <pre style="font-size:11px;overflow:auto;max-height:400px">${escapeHtml(JSON.stringify(api.raw || api, null, 2))}</pre>
  </details>
  <div style="font-size:11px;color:#aaa;margin-top:16px">${escapeHtml(vercelUrl || "")}</div>
</div></body></html>`;
}

/* ---------- 5. 主入口 ---------- */

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const params = {
    sub: url.searchParams.get("sub") || "interestingasfuck",
    filter: url.searchParams.get("filter") || "",
    limit: Math.min(10, Math.max(1, parseInt(url.searchParams.get("limit") || "3", 10) || 3)),
    probe: url.searchParams.get("probe") !== "0",
    introspect: url.searchParams.get("introspect") === "1",
    raw: url.searchParams.get("raw") === "1"
  };

  const api = await scrolllerFetch(params.sub, params.filter, params.limit);

  if (params.raw) {
    return new Response(JSON.stringify(api, null, 2), {
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }

  let probes = [];
  if (params.probe && api.ok) {
    const targets = [];
    for (const it of api.items) {
      for (const s of (it.mediaSources || [])) {
        if (targets.length < 8 && s && s.url) {
          targets.push({ url: s.url, width: s.width, height: s.height });
        }
      }
    }
    const results = await Promise.all(targets.map(t => probeUrl(t.url)));
    probes = results.map((r, i) => ({ ...r, width: targets[i].width, height: targets[i].height }));
  }

  const intro = params.introspect ? await introspect() : null;

  return new Response(renderPage({ params, api, probes, intro, vercelUrl: url.origin }), {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
  });
}
