// Twitter 用户时间线 RSS 生成器
// 多源回退架构：xcancel.com → nitter.catsarch.com → nitter.kareem.one → asia.aguea.com → Syndication API
// 视频输出策略（优先 MP4，兼容 m3u8）：
//   - MP4 路径：从 <source src="..."> 或下载链接提取原始 video.twimg.com MP4 URL
//   - m3u8 路径：从 data-url 属性提取原始 m3u8 URL，变体过滤在 media-proxy.js 中完成
//   - 图片路径：从代理 URL 解码出原始 pbs.twimg.com 地址
// 部署到 Cloudflare Pages 的 functions 目录即可使用
// 订阅地址: /twitter-rss?user=用户名

const DEFAULT_MAX_ITEMS = 20;
const ABSOLUTE_MAX_ITEMS = 50;

// Nitter 实例列表（按优先级排序）
// 2026-08-14 验证：xcancel.com / nitter.catsarch.com / nitter.kareem.one 可用
// asia.aguea.com 当前不可用，保留在末尾等恢复
const NITTER_INSTANCES = [
  'https://xcancel.com',
  'https://nitter.catsarch.com',
  'https://nitter.kareem.one',
  'https://asia.aguea.com',
];

const SYNDICATION_BASE = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/';

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

function escapeXml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 从视频变体列表中选择中等码率的 MP4（平衡画质和加载速度）
function pickBestMp4(variants) {
  const mp4s = variants
    .filter(v => v.content_type === 'video/mp4')
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));

  if (mp4s.length === 0) return null;

  const targetBitrate = 832000;
  let best = mp4s[0];
  let bestDiff = Infinity;
  for (const v of mp4s) {
    const diff = Math.abs((v.bitrate || 0) - targetBitrate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  }
  return best.url;
}

// 简单哈希函数，用于生成伪推文 ID
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// ─── URL 解码工具 ──────────────────────────────────────────────

// 从 Nitter 代理 URL 中提取原始 Twitter CDN URL
// 代理格式1: https://cdn.xcancel.com/pic/哈希/pbs.twimg.com%2Fprofile_images%2F...
// 代理格式2: https://cdn.xcancel.com/video/哈希/https%3A%2F%2Fvideo.twimg.com%2F...
// 代理格式3 (asia.aguea.com): https://venexa.site/media/xxx.jpg
// 代理格式4: https://nitter.catsarch.com/pic/...
function decodeNitterProxyUrl(proxyUrl) {
  if (!proxyUrl) return '';
  let url = proxyUrl.replace(/&amp;/g, '&');

  // 格式3: venexa.site → 替换为 pbs.twimg.com 或 video.twimg.com
  if (/venexa\.site/.test(url)) {
    if (/\/media\//.test(url) || /\.(jpg|jpeg|png|gif|webp)/i.test(url)) {
      return url.replace(/https?:\/\/venexa\.site\//, 'https://pbs.twimg.com/');
    }
    return url.replace(/https?:\/\/venexa\.site\//, 'https://video.twimg.com/');
  }

  // 格式1/2/4: 从 /pic/ 或 /video/ 路径中提取 URL 编码的原始地址
  // 匹配 /pic/xxx/ 或 /video/xxx/ 后面的部分
  const proxyMatch = url.match(/\/(?:pic|video|thumb)\/[A-Za-z0-9]+\/(.+)$/);
  if (proxyMatch) {
    let encoded = proxyMatch[1];
    // URL 解码（可能双重编码）
    try {
      // 先检查是否以 http 开头（未编码）
      if (/^https?:\/\//i.test(encoded)) {
        return encoded;
      }
      // URL 解码
      let decoded = decodeURIComponent(encoded);
      // 如果解码后仍然包含 % 编码，再解一次
      if (decoded.includes('%')) {
        const decoded2 = decodeURIComponent(decoded);
        if (decoded2 !== decoded) decoded = decoded2;
      }
      // 确保是有效的 HTTP URL
      if (/^https?:\/\//i.test(decoded)) {
        return decoded;
      }
      // xcancel.com 格式: /pic/哈希/pbs.twimg.com%2F... → 解码后 pbs.twimg.com/...（缺少协议）
      if (/^(pbs|video)\.twimg\.com\//i.test(decoded)) {
        return 'https://' + decoded;
      }
    } catch (e) {
      // 解码失败，返回原始
    }
  }

  // 如果已经是原始 Twitter CDN URL，直接返回
  if (/^https?:\/\/(?:pbs|video)\.twimg\.com\//i.test(url)) {
    return url;
  }

  // 其他情况返回原始 URL（可能是直连地址）
  return url;
}

// ─── 方案 A：Nitter HTML 解析（多实例回退）──────────────────────
async function fetchFromNitter(username, maxItems) {
  for (const base of NITTER_INSTANCES) {
    try {
      const res = await fetch(base + '/' + username, {
        headers: {
          'User-Agent': FETCH_UA,
          'Accept': 'text/html,application/xhtml+xml',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: 'follow',
      });

      if (!res.ok) continue;

      const html = await res.text();

      // 检测用户不存在
      if (html.includes('User not found') || html.includes('does not exist') || html.includes('Account suspended')) {
        return buildEmptyRss(username, '该用户不存在或已被封禁');
      }

      // 检测是否有推文内容
      if (!html.includes('timeline-item')) {
        continue;
      }

      // 检测 Cloudflare 验证页
      if (html.includes('Just a moment') || html.includes('cloudflare') && html.includes('challenge')) {
        continue;
      }

      const items = await parseNitterHtml(html, username, maxItems, base);

      if (items.length === 0) {
        // 当前实例能访问但没有媒体推文，不继续尝试其他实例
        return buildEmptyRss(username, '该用户暂无可获取的公开推文（仅显示含图片或视频的推文）');
      }

      const rss =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<rss version="2.0">\n' +
        '<channel>\n' +
        '<title>@' + username + ' / Twitter</title>\n' +
        '<link>https://x.com/' + username + '</link>\n' +
        '<description>Twitter 时间线 - @' + username + '（via ' + base.replace('https://', '') + '）</description>\n' +
        '<language>zh-CN</language>\n' +
        '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
        items.join('\n') + '\n' +
        '</channel>\n' +
        '</rss>';

      return rss;
    } catch (e) {
      continue;
    }
  }
  return null;
}

// 解析 Nitter HTML，提取推文、图片、视频
// 兼容多种 Nitter 实例的 HTML 结构（xcancel.com / nitter.catsarch.com / asia.aguea.com 等）
//
// 通用 HTML 结构（基于 Nitter 最新源码 tweet.nim）:
//   <div class="timeline-item ...">
//     <div class="tweet-body">
//       <div class="tweet-header">
//         ... <span class="tweet-date"><a href="..." title="Aug 14, 2026 · 3:08 AM UTC">10h</a></span>
//       </div>
//       <div class="tweet-content media-body" dir="auto">推文文本</div>
//       <div class="attachments">
//         <!-- 图片 -->
//         <div class="attachment">
//           <a class="still-image" href="代理URL"><img src="代理URL" /></a>
//         </div>
//         <!-- 视频 MP4 模式 -->
//         <div class="attachment">
//           <video poster="代理URL" controls>
//             <source src="代理URL" type="video/mp4">
//           </video>
//           <a class="video-download" href="代理URL">Download video</a>
//         </div>
//         <!-- 视频 m3u8 模式 -->
//         <div class="attachment">
//           <video poster="代理URL" data-url="代理URL" data-autoload="false"></video>
//           <div class="video-overlay">...</div>
//         </div>
//       </div>
//     </div>
//   </div>
async function parseNitterHtml(html, username, maxItems, nitterBase) {
  const items = [];

  // 用 timeline-item 作为分隔，每个块包含一条推文
  const tweetBlocks = html.split(/(?=<div class="timeline-item)/i);

  for (const block of tweetBlocks) {
    if (items.length >= maxItems) break;
    if (!block.includes('tweet-body')) continue;

    // 提取推文文本
    const contentMatch = block.match(/<div class="tweet-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (!contentMatch) continue;

    // 清理 HTML 标签，保留纯文本和链接文本
    let rawText = contentMatch[1];
    // 将 <a> 标签的文本保留（如 @mention、链接文本）
    rawText = rawText.replace(/<a[^>]*>([^<]*)<\/a>/gi, '$1');
    const text = rawText
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .trim();

    if (!text) continue;

    // 提取日期
    // 优先从 <a title="Aug 14, 2026 · 3:08 AM UTC"> 解析精确时间
    // 回退到 <span class="tweet-date">10h</span> 相对时间
    let pubDate = '';
    const dateTitleMatch = block.match(/<span class="tweet-date"[^>]*>\s*<a[^>]*title="([^"]+)"/i);
    if (dateTitleMatch) {
      pubDate = parseNitterDate(dateTitleMatch[1].trim());
    }
    if (!pubDate) {
      const dateTextMatch = block.match(/<span class="tweet-date"[^>]*>([^<]*<[^>]*>)?([^<]*)<\/span>/i);
      if (dateTextMatch) {
        const dateText = (dateTextMatch[2] || dateTextMatch[1] || '').replace(/<[^>]+>/g, '').trim();
        if (dateText) pubDate = parseNitterDate(dateText);
      }
    }
    if (!pubDate) {
      // 兜底：直接从 tweet-date 块提取所有文本
      const dateFallback = block.match(/<span class="tweet-date"[^>]*>([\s\S]*?)<\/span>/i);
      if (dateFallback) {
        const dateText = dateFallback[1].replace(/<[^>]+>/g, '').trim();
        if (dateText) pubDate = parseNitterDate(dateText);
      }
    }
    if (!pubDate) pubDate = new Date().toUTCString();

    // 提取图片
    // 格式：<a class="still-image" href="代理URL">
    const imageUrls = [];
    const imageRegex = /<a[^>]*class="still-image"[^>]*href="([^"]+)"/gi;
    let imgMatch;
    while ((imgMatch = imageRegex.exec(block)) !== null) {
      const originalUrl = decodeNitterProxyUrl(imgMatch[1]);
      if (originalUrl) imageUrls.push(originalUrl);
    }

    // 提取视频
    // 优先级 1: <source src="代理URL" type="video/mp4"> （MP4 直链）
    // 优先级 2: <a class="video-download" href="代理URL"> （下载链接，通常也是 MP4）
    // 优先级 3: <video data-url="代理URL"> （m3u8 流）
    const videoUrls = [];
    const videoPosters = [];

    // 提取 video 标签的 poster
    const videoPosterRegex = /<video[^>]*\sposter="([^"]+)"[^>]*>/gi;
    let vidMatch;
    while ((vidMatch = videoPosterRegex.exec(block)) !== null) {
      videoPosters.push(decodeNitterProxyUrl(vidMatch[1]));
    }

    // 优先：MP4 <source> 标签
    const sourceRegex = /<source[^>]*\ssrc="([^"]+)"[^>]*>/gi;
    while ((vidMatch = sourceRegex.exec(block)) !== null) {
      const mp4Url = decodeNitterProxyUrl(vidMatch[1]);
      if (mp4Url && /\.mp4/i.test(mp4Url)) {
        videoUrls.push(mp4Url);
      }
    }

    // 如果没有 <source>，尝试 video-download 链接（通常是 MP4 直链）
    if (videoUrls.length === 0) {
      const downloadRegex = /<a[^>]*class="video-download"[^>]*href="([^"]+)"/gi;
      while ((vidMatch = downloadRegex.exec(block)) !== null) {
        const dlUrl = decodeNitterProxyUrl(vidMatch[1]);
        if (dlUrl && /\.mp4/i.test(dlUrl)) {
          videoUrls.push(dlUrl);
        }
      }
    }

    // 如果仍没有视频，尝试 m3u8 data-url（部分实例如 asia.aguea.com 使用此格式）
    if (videoUrls.length === 0) {
      const dataUrlRegex = /<video[^>]*\sdata-url="([^"]+)"[^>]*>/gi;
      while ((vidMatch = dataUrlRegex.exec(block)) !== null) {
        const m3u8Url = decodeNitterProxyUrl(vidMatch[1]);
        if (m3u8Url) videoUrls.push(m3u8Url);
      }
    }

    // 过滤掉无媒体条目：只显示包含图片或视频的推文
    if (imageUrls.length === 0 && videoUrls.length === 0) continue;

    // 生成推文链接
    // 优先从日期链接中提取真实推文 ID
    let tweetId = '';
    const statusLinkMatch = block.match(/href="[^"]*\/status\/(\d+)/i);
    if (statusLinkMatch) {
      tweetId = statusLinkMatch[1];
    }
    if (!tweetId) {
      // 回退：用媒体 URL 文件名或文本哈希生成伪 ID
      if (imageUrls.length > 0) {
        const fnMatch = imageUrls[0].match(/\/media\/([^.\/]+)/);
        if (fnMatch) tweetId = fnMatch[1];
      }
      if (!tweetId && videoUrls.length > 0) {
        const fnMatch = videoUrls[0].match(/\/amplify_video\/([^\/]+)/);
        if (fnMatch) tweetId = fnMatch[1];
      }
      if (!tweetId) tweetId = simpleHash(text + pubDate);
    }

    const tweetLink = 'https://x.com/' + username + '/status/' + tweetId;

    // 构建描述 HTML
    let desc = '<p>' + escapeHtml(text) + '</p>';

    // 添加图片（使用原始 pbs.twimg.com URL，通过 media-proxy 代理播放）
    for (const imgUrl of imageUrls) {
      desc += '<img src="' + escapeHtml(imgUrl) + '" />';
    }

    // 添加视频
    // MP4 视频：直接输出原始 video.twimg.com URL，由阅读器的 media-proxy 代理
    // m3u8 视频：输出原始 m3u8 URL，由 media-proxy 做变体过滤
    for (let i = 0; i < videoUrls.length; i++) {
      const videoUrl = videoUrls[i];
      const posterUrl = videoPosters[i] || (imageUrls.length > 0 ? imageUrls[0] : '');

      if (posterUrl) {
        desc += '<img src="' + escapeHtml(posterUrl) + '" />';
      }
      desc += '<video src="' + escapeHtml(videoUrl) + '" controls></video>';
    }

    items.push(
      '<item>\n' +
      '<title>' + escapeXml(text.slice(0, 100)) + (text.length > 100 ? '…' : '') + '</title>\n' +
      '<link>' + tweetLink + '</link>\n' +
      '<description><![CDATA[' + desc + ']]></description>\n' +
      '<pubDate>' + pubDate + '</pubDate>\n' +
      '<guid isPermaLink="false">' + tweetLink + '</guid>\n' +
      '</item>'
    );
  }

  return items;
}

// 解析 Nitter 日期格式
// 支持的格式：
//   精确时间 (title 属性): "Aug 14, 2026 · 3:08 AM UTC"
//   相对时间: "15h", "2d", "3m", "30s"
//   绝对时间: "Aug 4", "Aug 4, 2025", "Jan 5"
function parseNitterDate(dateStr) {
  if (!dateStr) return '';

  const now = new Date();

  // 精确时间格式: "Aug 14, 2026 · 3:08 AM UTC" 或 "Aug 14, 2026, 3:08 AM"
  // 这是 Nitter <a title="..."> 中提供的完整时间戳
  const preciseMatch = dateStr.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),?\s+(\d{4})[,\s·]+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(UTC)?$/i);
  if (preciseMatch) {
    const months = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
      'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    const month = months[preciseMatch[1]];
    if (month !== undefined) {
      const day = parseInt(preciseMatch[2]);
      const year = parseInt(preciseMatch[3]);
      let hour = parseInt(preciseMatch[4]);
      const minute = parseInt(preciseMatch[5]);
      const ampm = preciseMatch[6];
      if (ampm && /PM/i.test(ampm) && hour < 12) hour += 12;
      if (ampm && /AM/i.test(ampm) && hour === 12) hour = 0;
      const d = new Date(Date.UTC(year, month, day, hour, minute, 0));
      if (!isNaN(d.getTime())) return d.toUTCString();
    }
  }

  // "15h" → 15小时前
  const hoursMatch = dateStr.match(/^(\d+)h$/i);
  if (hoursMatch) {
    const d = new Date(now.getTime() - parseInt(hoursMatch[1]) * 3600000);
    return d.toUTCString();
  }

  // "2d" → 2天前
  const daysMatch = dateStr.match(/^(\d+)d$/i);
  if (daysMatch) {
    const d = new Date(now.getTime() - parseInt(daysMatch[1]) * 86400000);
    return d.toUTCString();
  }

  // "3m" → 3分钟前
  const minMatch = dateStr.match(/^(\d+)m$/i);
  if (minMatch) {
    const d = new Date(now.getTime() - parseInt(minMatch[1]) * 60000);
    return d.toUTCString();
  }

  // "30s" → 30秒前
  const secMatch = dateStr.match(/^(\d+)s$/i);
  if (secMatch) {
    const d = new Date(now.getTime() - parseInt(secMatch[1]) * 1000);
    return d.toUTCString();
  }

  // "Aug 4" 或 "Aug 4, 2025" 格式
  const monthDayMatch = dateStr.match(/^([A-Z][a-z]{2})\s+(\d{1,2})(?:,?\s*(\d{4}))?$/);
  if (monthDayMatch) {
    const monthName = monthDayMatch[1];
    const day = parseInt(monthDayMatch[2]);
    const year = monthDayMatch[3] ? parseInt(monthDayMatch[3]) : now.getFullYear();
    const months = {
      'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
      'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
    };
    const month = months[monthName];
    if (month !== undefined) {
      let actualYear = year;
      if (!monthDayMatch[3]) {
        const candidate = new Date(year, month, day);
        if (candidate > now) {
          actualYear = year - 1;
        }
      }
      const d = new Date(actualYear, month, day, 12, 0, 0);
      return d.toUTCString();
    }
  }

  // 尝试直接解析
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) {
    return parsed.toUTCString();
  }

  // 无法解析，返回当前时间
  return now.toUTCString();
}

// ─── 方案 B：Syndication API（最终回退）────────────────────────
async function fetchFromSyndication(username, maxItems) {
  try {
    const res = await fetch(SYNDICATION_BASE + username, {
      headers: {
        'User-Agent': FETCH_UA,
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });

    if (!res.ok) return null;

    const html = await res.text();

    // 检测限速
    if (html.includes('Rate limit exceeded')) return null;

    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) return null;

    const jsonStr = match[1].replace(/[\x00-\x1f]/g, function(ch) {
      if (ch === '\n' || ch === '\r' || ch === '\t') return ch;
      return ' ';
    });
    const data = JSON.parse(jsonStr);
    const entries = data?.props?.pageProps?.timeline?.entries || [];
    const hasResults = data?.props?.pageProps?.contextProvider?.hasResults;

    if (!hasResults || entries.length === 0) {
      return null;
    }

    const items = [];
    for (const entry of entries) {
      if (items.length >= maxItems) break;

      const tweet = entry?.content?.tweet;
      if (!tweet) continue;

      const tweetId = tweet.conversation_id_str || '';
      const text = tweet.text || '';

      let pubDate = '';
      try {
        pubDate = new Date(tweet.created_at).toUTCString();
      } catch (e) {
        continue;
      }

      let desc = '<p>' + escapeHtml(text) + '</p>';

      const mediaList = tweet.entities?.media || [];
      let hasMedia = false;
      for (const m of mediaList) {
        if (m.type === 'photo') {
          desc += '<img src="' + escapeHtml(m.media_url_https || '') + '" />';
          hasMedia = true;
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          const poster = m.media_url_https || '';
          if (poster) {
            desc += '<img src="' + escapeHtml(poster) + '" />';
          }
          const mp4Url = pickBestMp4(m.video_info?.variants || []);
          if (mp4Url) {
            desc += '<video src="' + escapeHtml(mp4Url) + '" controls></video>';
            hasMedia = true;
          }
        }
      }

      // 只保留有媒体的推文
      if (!hasMedia) continue;

      items.push(
        '<item>\n' +
        '<title>' + escapeXml(text.slice(0, 100)) + (text.length > 100 ? '…' : '') + '</title>\n' +
        '<link>https://x.com/' + username + '/status/' + tweetId + '</link>\n' +
        '<description><![CDATA[' + desc + ']]></description>\n' +
        '<pubDate>' + pubDate + '</pubDate>\n' +
        '<guid isPermaLink="true">https://x.com/' + username + '/status/' + tweetId + '</guid>\n' +
        '</item>'
      );
    }

    if (items.length === 0) {
      return null;
    }

    const rss =
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<rss version="2.0">\n' +
      '<channel>\n' +
      '<title>@' + username + ' / Twitter</title>\n' +
      '<link>https://x.com/' + username + '</link>\n' +
      '<description>Twitter 时间线 - @' + username + '（via Syndication API）</description>\n' +
      '<language>zh-CN</language>\n' +
      '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
      items.join('\n') + '\n' +
      '</channel>\n' +
      '</rss>';

    return rss;
  } catch (err) {
    return null;
  }
}

// ─── 生成空 RSS（无 item，不显示占位内容）──────────────────────
function buildEmptyRss(username, reason) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    '<channel>\n' +
    '<title>@' + username + ' / Twitter</title>\n' +
    '<link>https://x.com/' + username + '</link>\n' +
    '<description>' + escapeXml(reason) + '</description>\n' +
    '<language>zh-CN</language>\n' +
    '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
    '</channel>\n' +
    '</rss>'
  );
}

// ─── 主入口：多源回退 ──────────────────────────────────────────
export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const username = (url.searchParams.get('user') || '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 15);

  let maxItems = DEFAULT_MAX_ITEMS;
  const maxParam = parseInt(url.searchParams.get('max'), 10);
  if (maxParam > 0) {
    maxItems = Math.min(maxParam, ABSOLUTE_MAX_ITEMS);
  }

  if (!username) {
    return new Response('缺少 user 参数。用法: /twitter-rss?user=用户名', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }

  // 方案 A：尝试 Nitter HTML 解析（多实例依次回退）
  let rss = await fetchFromNitter(username, maxItems);

  // 方案 B：所有 Nitter 实例失败，回退到 Syndication API
  if (!rss) {
    rss = await fetchFromSyndication(username, maxItems);
  }

  // 所有方案都失败
  if (!rss) {
    rss = buildEmptyRss(username, '所有数据源均不可用，可能是网络问题或 Twitter 风控限制，请稍后重试');
  }

  return new Response(rss, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=300',
      'ETag': '"' + username + '-' + maxItems + '-' + Math.floor(Date.now() / 300000) + '"',
    }),
  });
}
