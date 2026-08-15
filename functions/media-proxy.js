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
  "phe69",
  "video.3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com",
  "htumeng.com",
  "642p.com",
  "tutu1.space"
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

function isBlockedPrivateHost(rawUrl) {
  try {
    const host = String(new URL(rawUrl).hostname || "").toLowerCase().replace(/\.+$/, "");
    const ipMatch = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a] = ipMatch;
      return host === "0.0.0.0" ||
        host === "127.0.0.1" ||
        a === "127" ||
        a === "10" ||
        host.startsWith("192.168.") ||
        /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
        a === "169"; // 169.254.x.x link-local
    }
    return host === "localhost" ||
      host.endsWith(".local") ||
      host.endsWith(".internal");
  } catch (e) {
    return true;
  }
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

// ─── m3u8 主播放列表变体过滤（保留多档变体，交给 hls.js 自适应码率）──────────
// Twitter 主播放列表含 270p~1080p 多档变体。代理带宽有限，超高码率既加载慢又浪费流量。
// 本函数在代理层：丢弃 >720p 的变体，保留 720p 及以下全部变体（多档），并保留它们引用的
// 音频/字幕轨道。前端 hls.js 据此做 ABR：弱网自动降码率秒开，强网自动升画质。
// 非主播放列表（媒体播放列表，含 .m4s 分片）直接使用 rewriteM3u8Text 改写。

// 从 STREAM-INF 中解析视频高度（用于封顶 720p）
function _streamHeight(streamInf) {
  const m = streamInf.match(/RESOLUTION=(\d+)x(\d+)/i);
  return m ? parseInt(m[2], 10) : 0;
}
// 从 STREAM-INF 中解析带宽（优先 AVERAGE-BANDWIDTH，回退 BANDWIDTH）
function _streamBw(streamInf) {
  const avg = streamInf.match(/AVERAGE-BANDWIDTH=(\d+)/i);
  if (avg) return parseInt(avg[1], 10);
  const bw = streamInf.match(/[,:]BANDWIDTH=(\d+)/i);
  return bw ? parseInt(bw[1], 10) : 0;
}
function _streamGroup(streamInf, type) {
  const m = streamInf.match(new RegExp(type + '="([^"]+)"', "i"));
  return m ? m[1] : null;
}
function _mediaGroupId(entry) {
  const m = entry.match(/GROUP-ID="([^"]+)"/i);
  return m ? m[1] : null;
}

function filterMasterPlaylist(text, baseUrl, requestUrl) {
  // 仅对「通过 twitter-rss.js 添加的推特订阅」m3u8 施加 720p 封顶：
  // 前端在该类视频的代理 URL 上追加 &src=twrss 标记，此处据此判断。
  // 直连、其他平台代理视频、以及其他方式添加的推特视频不做限制，保留全部变体（全清晰度）。
  const isTwRss = /[?&]src=twrss\b/i.test(String(requestUrl || ""));
  if (!isTwRss) {
    return rewriteM3u8Text(text, baseUrl, requestUrl);
  }

  const lines = String(text || "").split(/\r?\n/);

  const hasStreamInf = lines.some(l => l.trim().startsWith("#EXT-X-STREAM-INF"));
  if (!hasStreamInf) {
    return rewriteM3u8Text(text, baseUrl, requestUrl);
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
    return rewriteM3u8Text(text, baseUrl, requestUrl);
  }

  const videoVariants = variants.filter(v => {
    const codecsMatch = v.streamInf.match(/CODECS="([^"]+)"/i);
    if (!codecsMatch) return true;
    const codecs = codecsMatch[1];
    return codecs.includes(",") || !/^mp4a/i.test(codecs);
  });
  const candidates = videoVariants.length > 0 ? videoVariants : variants;

  // 丢弃 >720p 的超高码率变体（代理带宽扛不住，纯属浪费），保留 ≤720p 的全部变体
  const CAP_HEIGHT = 720;
  const kept = candidates.filter(v => {
    const h = _streamHeight(v.streamInf);
    return h === 0 || h <= CAP_HEIGHT;
  });
  const chosen = kept.length > 0 ? kept : candidates; // 兜底：若全 >720p 则保留全部

  // 收集保留变体引用的音频/字幕轨道组，仅保留相关轨道
  const audioGroups = new Set();
  const subsGroups = new Set();
  for (const v of chosen) {
    const a = _streamGroup(v.streamInf, "AUDIO");
    const s = _streamGroup(v.streamInf, "SUBTITLES");
    if (a) audioGroups.add(a);
    if (s) subsGroups.add(s);
  }

  const result = [];
  result.push(...headerLines);

  for (const entry of mediaEntries) {
    const isAudio = /TYPE=AUDIO/i.test(entry);
    const isSubs = /TYPE=SUBTITLES/i.test(entry);

    if (isAudio && audioGroups.has(_mediaGroupId(entry))) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    } else if (isSubs && subsGroups.has(_mediaGroupId(entry))) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    } else if (!isAudio && !isSubs) {
      result.push(rewriteUriAttributes(entry, baseUrl, requestUrl));
    }
  }

  // 按码率升序输出：hls.js 的 0 号即最低码率，起播最快、弱网也能秒开
  chosen.sort((a, b) => _streamBw(a.streamInf) - _streamBw(b.streamInf));
  for (const v of chosen) {
    result.push(v.streamInf);
    const resolvedUrl = resolveM3u8Url(v.url.trim(), baseUrl);
    const proxiedUrl = (isHttpUrl(resolvedUrl) && hostAllowed(resolvedUrl))
      ? buildProxyUrl(requestUrl, resolvedUrl)
      : v.url;
    result.push(proxiedUrl);
  }

  return result.join("\n");
}

// 图片尺寸优化：Twitter 图片支持 :small/:medium/:large/:orig 后缀。
// 前端可传 ?twname=medium 让代理请求更小尺寸的图，省流量、提速。
function applyTwimgSize(url, size) {
  const allowed = ["small", "medium", "large", "orig"];
  if (!allowed.includes(size)) return url;
  let u;
  try { u = new URL(url); } catch (e) { return url; }
  if (!/twimg\.com$/i.test(u.hostname)) return url;
  // 去掉已有的尺寸后缀，避免重复
  u.pathname = u.pathname.replace(/:(small|medium|large|orig)$/i, "");
  // 追加请求的尺寸
  u.pathname += ":" + size;
  // 清理旧 name= 参数，避免与后缀冲突
  u.searchParams.delete("name");
  return u.toString();
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
  let targetUrl = urlObj.searchParams.get("url");
  if (!targetUrl || !isHttpUrl(targetUrl)) {
    return new Response("缺少或非法url参数", { status: 400, headers: corsHeaders() });
  }
  if (!hostAllowed(targetUrl)) {
    return new Response("该媒体域名不在代理名单中", { status: 403, headers: corsHeaders() });
  }
  if (isBlockedPrivateHost(targetUrl)) {
    return new Response("不允许代理内网地址", { status: 403, headers: corsHeaders() });
  }
  // 图片尺寸优化：前端传 ?twname=medium 等，让代理请求更小尺寸的推图（省流量提速）
  const twname = urlObj.searchParams.get("twname");
  if (twname && /twimg\.com/i.test(targetUrl)) {
    targetUrl = applyTwimgSize(targetUrl, twname);
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
      signal: AbortSignal.timeout(8000)
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
          // 放开缓存：m3u8 清单走 Cloudflare 边缘缓存，重复访问不再回源，省流量/提速
          "Cache-Control": "s-maxage=604800, public"
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
