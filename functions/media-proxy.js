// 媒体代理：图片 / 视频 / m3u8 等资源的跨域转发。
// 仅对“生效媒体名单”内的域名提供服务（其余返回 403），避免被当开放代理滥用。
// 生效名单 = 内置默认白名单(BUILTIN_MEDIA_HOSTS)，不依赖 KV 用户名单。

const BUILTIN_MEDIA_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "niter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com",
  "redd.it",
  "770118.xyz",
  "phe69.com",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com",
  "htumeng.com",
  "642p.com",
  "tutu1.space"
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

// 仅内置默认白名单，不依赖 KV 用户名单
function getMediaAllowSet(env) {
  return new Set(BUILTIN_MEDIA_HOSTS.map(normalizeHost));
}

function hostInSet(rawUrl, allowSet) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    if (allowSet.has(host)) return true;
    for (const key of allowSet) {
      if (host.endsWith("." + key)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function buildProxyUrl(requestUrl, targetUrl, extraParams = {}) {
  const current = new URL(requestUrl);
  const proxy = new URL(current.pathname, current.origin);
  proxy.searchParams.set("url", targetUrl);
  for (const [k, v] of Object.entries(extraParams)) {
    if (v !== undefined && v !== null && v !== "") proxy.searchParams.set(k, v);
  }
  return proxy.toString();
}

// 把当前请求的 q 透传给改写后的子资源 URL，
// 这样分片、音频请求也带同样的画质档，嵌套变体保持一致。
function passthroughParams(requestUrl) {
  const u = new URL(requestUrl);
  const p = {};
  const q = u.searchParams.get("q");
  if (q) p.q = q;
  return p;
}

function resolveM3u8Url(line, baseUrl) {
  const value = String(line || "").trim();
  if (!value || value.startsWith("#")) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch (e) {
    return value;
  }
}

function rewriteUriAttributes(line, baseUrl, requestUrl, allowSet) {
  const pp = passthroughParams(requestUrl);
  return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
    try {
      const resolved = new URL(uri, baseUrl).toString();
      if (!hostInSet(resolved, allowSet)) return match;
      return `URI="${buildProxyUrl(requestUrl, resolved, pp)}"`;
    } catch (e) {
      return match;
    }
  });
}

function rewriteM3u8Text(text, baseUrl, requestUrl, allowSet) {
  const pp = passthroughParams(requestUrl);
  return String(text || "")
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#") && /URI="/i.test(trimmed)) {
        return rewriteUriAttributes(line, baseUrl, requestUrl, allowSet);
      }
      if (trimmed.startsWith("#")) return line;

      const resolved = resolveM3u8Url(trimmed, baseUrl);
      if (!isHttpUrl(resolved) || !hostInSet(resolved, allowSet)) return line;
      return buildProxyUrl(requestUrl, resolved, pp);
    })
    .join("\n");
}

// ─── 主播放列表变体选择 ──────────────────────────────────────
// Twitter 主播放列表含多个视频变体（270p~1080p）+ 多个音频轨道。
// 为缓解“显示时长却不播”：默认不选单一变体，而是保留一个“阶梯”——
//   所有带宽 <= 目标档 的变体 + 紧邻目标档之上的一个变体。
// HLS.js 以最低档(level 0)秒起播，带宽允许后自动升档，避免一上来拉高码率卡死。
// q=high：全量保留所有变体，由 HLS.js 自选最高画质（用于分享）。
function bwOf(v) {
  const avg = v.streamInf.match(/AVERAGE-BANDWIDTH=(\d+)/i);
  const bw = v.streamInf.match(/[,:]BANDWIDTH=(\d+)/i);
  return avg ? parseInt(avg[1], 10) : (bw ? parseInt(bw[1], 10) : 0);
}

function groupIdOf(entry) {
  const m = entry.match(/GROUP-ID="([^"]+)"/i);
  return m ? m[1] : null;
}

function filterMasterPlaylist(text, baseUrl, requestUrl, targetBitrate = 832000, allowSet) {
  const lines = String(text || "").split(/\r?\n/);

  const hasStreamInf = lines.some(l => l.trim().startsWith("#EXT-X-STREAM-INF"));
  if (!hasStreamInf) {
    return rewriteM3u8Text(text, baseUrl, requestUrl, allowSet);
  }

  const headerLines = [];
  const mediaEntries = [];
  const variants = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    if (trimmed.startsWith("#EXT-X-MEDIA")) {
      mediaEntries.push(line);
      i++;
    } else if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      const streamInfLine = line;
      i++;
      while (i < lines.length && !lines[i].trim()) i++;
      if (i < lines.length) {
        variants.push({ streamInf: streamInfLine, url: lines[i] });
        i++;
      }
    } else if (trimmed.startsWith("#")) {
      headerLines.push(line);
      i++;
    } else {
      i++;
    }
  }

  if (variants.length === 0) {
    return rewriteM3u8Text(text, baseUrl, requestUrl, allowSet);
  }

  // 过滤掉纯音频变体（CODECS 只含 mp4a，无视频编码）
  const videoVariants = variants.filter(v => {
    const codecsMatch = v.streamInf.match(/CODECS="([^"]+)"/i);
    if (!codecsMatch) return true;
    const codecs = codecsMatch[1];
    return codecs.includes(",") || !/^mp4a/i.test(codecs);
  });

  const candidates = (videoVariants.length > 0 ? videoVariants : variants).map(v => ({ ...v, bw: bwOf(v) }));
  candidates.sort((a, b) => a.bw - b.bw);

  // 选最接近目标档的变体作为“目标档”
  let ti = 0;
  let bestDiff = Infinity;
  candidates.forEach((v, idx) => {
    const diff = Math.abs(v.bw - targetBitrate);
    if (diff < bestDiff) { bestDiff = diff; ti = idx; }
  });
  const targetBw = candidates[ti].bw;

  // 阶梯：所有 <= 目标档 的变体 + 紧邻之上一个
  const selected = candidates.filter(v => v.bw <= targetBw);
  const higher = candidates.filter(v => v.bw > targetBw);
  if (higher.length) selected.push(higher[0]);

  // 收集选中变体引用的音频/字幕组，避免丢轨道
  const audioGroups = new Set();
  const subsGroups = new Set();
  selected.forEach(v => {
    const a = v.streamInf.match(/AUDIO="([^"]+)"/i);
    const s = v.streamInf.match(/SUBTITLES="([^"]+)"/i);
    if (a) audioGroups.add(a[1]);
    if (s) subsGroups.add(s[1]);
  });

  const result = [];
  result.push(...headerLines);

  for (const entry of mediaEntries) {
    const isAudio = /TYPE=AUDIO/i.test(entry);
    const isSubs = /TYPE=SUBTITLES/i.test(entry);
    const gid = groupIdOf(entry);

    if (isAudio && audioGroups.has(gid)) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl, allowSet));
    } else if (isSubs && subsGroups.has(gid)) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl, allowSet));
    } else if (!isAudio && !isSubs) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl, allowSet));
    }
  }

  for (const v of selected) {
    result.push(v.streamInf);
    const resolvedUrl = resolveM3u8Url(v.url.trim(), baseUrl);
    const proxiedUrl = (isHttpUrl(resolvedUrl) && hostInSet(resolvedUrl, allowSet))
      ? buildProxyUrl(requestUrl, resolvedUrl, passthroughParams(requestUrl))
      : v.url;
    result.push(proxiedUrl);
  }

  return result.join("\n");
}

function isLikelyM3u8(targetUrl, res) {
  const contentType = res.headers.get("content-type") || "";
  return /\.m3u8(?:$|\?)/i.test(targetUrl) ||
    /mpegurl|vnd\.apple\.mpegurl|application\/x-mpegurl/i.test(contentType);
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length,Content-Range,Accept-Ranges,Content-Type",
    ...extra
  };
}

export async function onRequest({ request, env }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");
  const q = (urlObj.searchParams.get("q") || "480").toLowerCase();

  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return new Response("缺少或非法url参数", { status: 400, headers: corsHeaders() });
  }

  // 合并内置默认 + KV 用户名单，作为本次请求的生效名单
  const allowSet = await getMediaAllowSet(env);
  if (!hostInSet(targetUrl, allowSet)) {
    return new Response("该媒体域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }

  try {
    const fetchHeaders = new Headers();
    fetchHeaders.set("User-Agent", UA);
    if (/\/rss\b|\.rss\b|\/atom\b|\.xml\b/i.test(targetUrl)) {
      fetchHeaders.set("Accept", "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.8");
    } else {
      fetchHeaders.set("Accept", "*/*");
    }
    const range = request.headers.get("range");
    if (range) fetchHeaders.set("Range", range);

    const res = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(15000)
    });

    if (isLikelyM3u8(targetUrl, res)) {
      const text = await res.text();
      const baseUrl = res.url || targetUrl;
      let processed;
      if (q === "high") {
        // 分享/高画质：全量改写，保留所有变体，HLS.js 自选最高
        processed = rewriteM3u8Text(text, baseUrl, request.url, allowSet);
      } else {
        // 普通/收藏：保留“目标档 + 更低档”阶梯，低档起播、自动升档
        const target = q === "720" ? 832000 : 500000;
        processed = filterMasterPlaylist(text, baseUrl, request.url, target, allowSet);
      }

      return new Response(processed, {
        status: res.status,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
          // 点播播放列表静态，短 TTL 边缘缓存覆盖播放期刷新，又不过度滞后
          "Cache-Control": "public, s-maxage=30"
        })
      });
    }

    // 非 m3u8（mp4 分片 / 图片等）：实时转发，支持 Range，边缘缓存 7 天
    const headers = new Headers(res.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    headers.set("Access-Control-Allow-Methods", "GET,HEAD,OPTIONS");
    headers.set("Access-Control-Allow-Headers", "*");
    headers.set("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type");
    headers.set("Cache-Control", "s-maxage=604800, public");
    headers.set("Vary", "Range");
    headers.delete("Transfer-Encoding");

    return new Response(res.body, { status: res.status, headers });
  } catch (err) {
    return new Response("媒体代理失败：" + err.message, { status: 502, headers: corsHeaders() });
  }
}
