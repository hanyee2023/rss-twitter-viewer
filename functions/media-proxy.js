const ALLOW_PROXY_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "nitter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com", 
  "redd.it",
  "770118.xyz",
  "phe69.com",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com"
];

function normalizeHost(host) {
  return String(host || "").toLowerCase().replace(/\.+$/, "");
}

function hostAllowed(rawUrl) {
  try {
    const host = normalizeHost(new URL(rawUrl).hostname);
    return ALLOW_PROXY_HOSTS.some(rule => {
      const key = normalizeHost(rule);
      return host === key || host.endsWith("." + key);
    });
  } catch (e) {
    return false;
  }
}

function isHttpUrl(rawUrl) {
  return /^https?:\/\//i.test(String(rawUrl || ""));
}

function buildProxyUrl(requestUrl, targetUrl) {
  const current = new URL(requestUrl);
  const proxy = new URL(current.pathname, current.origin);
  proxy.searchParams.set("url", targetUrl);
  return proxy.toString();
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

function rewriteUriAttributes(line, baseUrl, requestUrl) {
  return line.replace(/URI="([^"]+)"/gi, (match, uri) => {
    try {
      const resolved = new URL(uri, baseUrl).toString();
      if (!hostAllowed(resolved)) return match;
      return `URI="${buildProxyUrl(requestUrl, resolved)}"`;
    } catch (e) {
      return match;
    }
  });
}

function rewriteM3u8Text(text, baseUrl, requestUrl) {
  return String(text || "")
    .split(/\r?\n/)
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith("#") && /URI="/i.test(trimmed)) {
        return rewriteUriAttributes(line, baseUrl, requestUrl);
      }
      if (trimmed.startsWith("#")) return line;

      const resolved = resolveM3u8Url(trimmed, baseUrl);
      if (!isHttpUrl(resolved) || !hostAllowed(resolved)) return line;
      return buildProxyUrl(requestUrl, resolved);
    })
    .join("\n");
}

// ─── m3u8 主播放列表变体过滤 ──────────────────────────────────
// Twitter 的 m3u8 主播放列表包含多个视频变体（270p~1080p）和多个音频轨道。
// 直接代理会导致浏览器嗅探器发现多个视频链接，且高码率变体加载缓慢。
// 本函数在代理层过滤主播放列表：
//   1. 从 #EXT-X-STREAM-INF 变体中选择 BANDWIDTH 最接近 832000 的视频变体
//   2. 保留该变体引用的音频轨道（#EXT-X-MEDIA AUDIO）和字幕轨道（SUBTITLES）
//   3. 移除其他变体和音频轨道，减少链接数量
//   4. 所有 URL 改写为代理 URL
// 非主播放列表（媒体播放列表，含 .m4s 分片）直接使用 rewriteM3u8Text 改写。
function filterMasterPlaylist(text, baseUrl, requestUrl) {
  const lines = String(text || "").split(/\r?\n/);

  // 检测是否为主播放列表（包含 #EXT-X-STREAM-INF）
  const hasStreamInf = lines.some(l => l.trim().startsWith("#EXT-X-STREAM-INF"));
  if (!hasStreamInf) {
    // 非主播放列表（媒体播放列表），使用普通改写
    return rewriteM3u8Text(text, baseUrl, requestUrl);
  }

  // 解析主播放列表
  const headerLines = [];   // #EXTM3U, #EXT-X-VERSION, #EXT-X-INDEPENDENT-SEGMENTS 等
  const mediaEntries = [];  // #EXT-X-MEDIA 条目（音频、字幕）
  const variants = [];      // { streamInf, url } 视频变体

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) { i++; continue; }

    if (trimmed.startsWith("#EXT-X-MEDIA")) {
      // 音频/字幕媒体条目，全部收集
      mediaEntries.push(line);
      i++;
    } else if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
      // 视频变体，收集 STREAM-INF 行和紧随其后的 URL 行
      const streamInfLine = line;
      i++;
      while (i < lines.length && !lines[i].trim()) i++; // 跳过空行
      if (i < lines.length) {
        variants.push({ streamInf: streamInfLine, url: lines[i] });
        i++;
      }
    } else if (trimmed.startsWith("#")) {
      // 其他标签（#EXTM3U, #EXT-X-VERSION 等），归入头部
      headerLines.push(line);
      i++;
    } else {
      // 无前导标签的 URL 行（主播放列表中不应出现），跳过
      i++;
    }
  }

  if (variants.length === 0) {
    // 没有视频变体，回退到普通改写
    return rewriteM3u8Text(text, baseUrl, requestUrl);
  }

  // 过滤掉纯音频变体（CODECS 只含 mp4a，无视频编码）
  // Twitter 的变体通常同时包含音视频编码（如 "mp4a.40.2,avc1.4D401E"）
  const videoVariants = variants.filter(v => {
    const codecsMatch = v.streamInf.match(/CODECS="([^"]+)"/i);
    if (!codecsMatch) return true; // 无编码信息，保留
    const codecs = codecsMatch[1];
    // 含逗号说明有多个编码（音视频都有），或不以 mp4a 开头说明是视频编码
    return codecs.includes(",") || !/^mp4a/i.test(codecs);
  });

  const candidates = videoVariants.length > 0 ? videoVariants : variants;

  // 选择 BANDWIDTH 最接近 832000 bps（约 720p）的变体
  // 使用 AVERAGE-BANDWIDTH（反映实际平均码率），回退到 BANDWIDTH（峰值码率）
  // 平衡画质和加载速度，避免高分辨率视频缓冲缓慢
  const targetBitrate = 832000;
  let best = candidates[0];
  let bestDiff = Infinity;
  for (const v of candidates) {
    // 优先使用 AVERAGE-BANDWIDTH，没有则用 BANDWIDTH
    // 注意：正则不能直接匹配 BANDWIDTH=，否则会误匹配 AVERAGE-BANDWIDTH=
    const avgBwMatch = v.streamInf.match(/AVERAGE-BANDWIDTH=(\d+)/i);
    const bwMatch = v.streamInf.match(/[:,]BANDWIDTH=(\d+)/i);
    const bw = avgBwMatch ? parseInt(avgBwMatch[1]) : (bwMatch ? parseInt(bwMatch[1]) : 0);
    const diff = Math.abs(bw - targetBitrate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  }

  // 从选中的变体中提取 AUDIO 和 SUBTITLES 组 ID
  const audioGroupMatch = best.streamInf.match(/AUDIO="([^"]+)"/i);
  const audioGroupId = audioGroupMatch ? audioGroupMatch[1] : null;
  const subsGroupMatch = best.streamInf.match(/SUBTITLES="([^"]+)"/i);
  const subsGroupId = subsGroupMatch ? subsGroupMatch[1] : null;

  // 重建播放列表
  const result = [];
  result.push(...headerLines);

  // 只保留选中变体引用的音频轨道和字幕轨道
  for (const entry of mediaEntries) {
    const isAudio = /TYPE=AUDIO/i.test(entry);
    const isSubs = /TYPE=SUBTITLES/i.test(entry);

    if (isAudio && audioGroupId && entry.includes(`GROUP-ID="${audioGroupId}"`)) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    } else if (isSubs && subsGroupId && entry.includes(`GROUP-ID="${subsGroupId}"`)) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    } else if (!isAudio && !isSubs) {
      // 其他类型的 MEDIA 条目，保留
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    }
    // 其他音频/字幕条目（不匹配选中变体的组）跳过
  }

  // 添加选中的视频变体，URL 改写为代理 URL
  result.push(best.streamInf);
  const resolvedUrl = resolveM3u8Url(best.url.trim(), baseUrl);
  const proxiedUrl = (isHttpUrl(resolvedUrl) && hostAllowed(resolvedUrl))
    ? buildProxyUrl(requestUrl, resolvedUrl)
    : best.url;
  result.push(proxiedUrl);

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

export async function onRequest({ request }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const urlObj = new URL(request.url);
  const targetUrl = urlObj.searchParams.get("url");
  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return new Response("缺少或非法url参数", { status: 400, headers: corsHeaders() });
  }
  if (!hostAllowed(targetUrl)) {
    return new Response("该媒体域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }

  try {
    const fetchHeaders = new Headers();
    fetchHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36");
    // RSS/Atom 链接发送正确的 Accept 头，避免 nitter 返回 HTML 页面
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
      // 使用 res.url（重定向后的最终 URL）作为 base，避免 Twitter 重定向导致分片 URL 解析错误
      const baseUrl = res.url || targetUrl;
      // 主播放列表：过滤变体（保留中等码率视频 + 对应音频轨道）
      // 媒体播放列表：直接改写分片 URL
      const processed = filterMasterPlaylist(text, baseUrl, request.url);
      return new Response(processed, {
        status: res.status,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
          // 点播 m3u8 的播放列表内容基本不变，做短 TTL 边缘缓存。
          // 原先 no-store 会让 HLS.js 每次刷新播放列表都回源，分片频繁回源造成卡顿。
          // 30s 足够覆盖播放过程中的周期性播放列表请求，又不会明显滞后于源站更新（Twitter 视频为点播，播放列表静态）。
          "Cache-Control": "public, s-maxage=30"
        })
      });
    }

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
