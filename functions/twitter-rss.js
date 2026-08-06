// Twitter 用户时间线 RSS 生成器
// 多源回退架构：asia.aguea.com (Nitter) → Syndication API
// 视频输出策略：将 m3u8 转换为中等码率 MP4（便于浏览器嗅探 + 加载流畅）
// 部署到 Cloudflare Pages 的 functions 目录即可使用
// 订阅地址: /twitter-rss?user=用户名

const DEFAULT_MAX_ITEMS = 20;
const ABSOLUTE_MAX_ITEMS = 50;

// Nitter 实例列表（按优先级排序，经验证 asia.aguea.com 可用）
const NITTER_INSTANCES = [
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
// 之前选最高码率导致高分辨率视频加载缓慢，
// 现在选择最接近 832000bps（约 720p）的变体，确保流畅播放
function pickBestMp4(variants) {
  const mp4s = variants
    .filter(v => v.content_type === 'video/mp4')
    .sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0)); // 升序排列

  if (mp4s.length === 0) return null;

  // 目标码率：832000 bps（约 720p）
  // 选择最接近目标码率的变体，避免最高码率导致缓冲缓慢
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

// 将 Twitter m3u8 URL 转换为直接 MP4 URL
// Twitter CDN 在相同路径同时提供 m3u8 和 mp4 两种格式，只需替换扩展名
function m3u8ToMp4(url) {
  return url.replace(/\.m3u8(\?|&|#|$)/, '.mp4$1');
}

// 从 Twitter m3u8 URL 解析出最佳 MP4 URL
// - 如果是媒体播放列表（URL 含 /vid/），直接转换扩展名即可
// - 如果是主播放列表（URL 含 /pl/），需要获取内容并解析变体列表，
//   选择中等码率的变体再转换为 MP4
async function resolveTwitterVideoMp4(m3u8Url) {
  // 媒体播放列表（含 /vid/）：直接转换，无需网络请求
  if (m3u8Url.includes('/vid/')) {
    return m3u8ToMp4(m3u8Url);
  }

  // 主播放列表（含 /pl/ 或其他格式）：获取并解析变体
  try {
    const res = await fetch(m3u8Url, {
      headers: { 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const text = await res.text();
      const variants = [];
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('#EXT-X-STREAM-INF')) {
          const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
          const nextLine = lines[i + 1] ? lines[i + 1].trim() : '';
          if (nextLine && !nextLine.startsWith('#')) {
            const variantUrl = nextLine.startsWith('http')
              ? nextLine
              : new URL(nextLine, m3u8Url).href;
            variants.push({
              bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
              url: variantUrl,
            });
          }
        }
      }

      if (variants.length > 0) {
        // 按码率升序排列
        variants.sort((a, b) => a.bandwidth - b.bandwidth);

        // 选择中等码率（目标 ~832000 bps，约 720p）
        const targetBw = 832000;
        let best = variants[Math.floor(variants.length / 2)];
        let bestDiff = Infinity;
        for (const v of variants) {
          const diff = Math.abs(v.bandwidth - targetBw);
          if (diff < bestDiff) {
            bestDiff = diff;
            best = v;
          }
        }

        return m3u8ToMp4(best.url);
      }
    }
  } catch (e) {
    // 获取失败，回退到直接转换
  }

  // 回退：直接转换扩展名
  return m3u8ToMp4(m3u8Url);
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

// ─── 方案 A：Nitter HTML 解析（asia.aguea.com，首选）──────────
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
      if (html.includes('User not found') || html.includes('does not exist')) {
        return buildEmptyRss(username, '该用户不存在');
      }

      // 检测是否有推文
      if (!html.includes('timeline-item')) {
        continue;
      }

      const items = await parseNitterHtml(html, username, maxItems, base);

      if (items.length === 0) {
        return buildEmptyRss(username, '该用户暂无可获取的公开推文');
      }

      const rss =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<rss version="2.0">\n' +
        '<channel>\n' +
        '<title>@' + username + ' / Twitter</title>\n' +
        '<link>https://x.com/' + username + '</link>\n' +
        '<description>Twitter 时间线 - @' + username + '（via Nitter）</description>\n' +
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
// asia.aguea.com 的 HTML 结构：
//   <div class="timeline-item" data-username="xxx">
//     <div class="tweet-body">
//       <div class="tweet-header">...<span class="tweet-date">15h</span></div>
//       <div class="tweet-content media-body" dir="auto">推文文本</div>
//       <div class="attachments">
//         <div class="gallery-row">
//           <div class="attachment image">
//             <a class="still-image" href="https://venexa.site/media/xxx.jpg">
//               <img src="https://venexa.site/media/xxx.jpg?name=small&format=webp" />
//             </a>
//           </div>
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

    // 清理 HTML 标签，保留纯文本和 @mention
    let rawText = contentMatch[1];
    // 将 <a> 标签的文本保留（如 @mention）
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
    // asia.aguea.com 的日期格式：<span class="tweet-date">15h</span> 或 <span class="tweet-date">Aug 4</span>
    const dateMatch = block.match(/<span class="tweet-date"[^>]*>([^<]+)<\/span>/i);
    let pubDate = '';
    if (dateMatch) {
      pubDate = parseNitterDate(dateMatch[1].trim());
    }
    if (!pubDate) pubDate = new Date().toUTCString();

    // 提取图片
    // 格式：<a class="still-image" href="https://venexa.site/media/xxx.jpg" ...>
    const imageRegex = /<a[^>]*class="still-image"[^>]*href="([^"]+)"/gi;
    const imageUrls = [];
    let imgMatch;
    while ((imgMatch = imageRegex.exec(block)) !== null) {
      imageUrls.push(imgMatch[1]);
    }

    // 提取视频
    // asia.aguea.com 的视频格式：<video poster="xxx.jpg" data-url="xxx.m3u8" data-autoload="false"></video>
    // 不使用 src 属性，而是用 data-url 存放 m3u8 链接，用 poster 存放预览图
    // 输出时将 m3u8 转换为中等码率 MP4，便于浏览器嗅探和快速加载
    const videoRegex = /<video[^>]*\sdata-url="([^"]+)"[^>]*>/gi;
    const videoPosterRegex = /<video[^>]*\sposter="([^"]+)"[^>]*>/gi;
    const videoUrls = [];
    const videoPosters = [];
    let vidMatch;
    while ((vidMatch = videoRegex.exec(block)) !== null) {
      videoUrls.push(vidMatch[1]);
    }
    while ((vidMatch = videoPosterRegex.exec(block)) !== null) {
      videoPosters.push(vidMatch[1]);
    }

    // 过滤掉无媒体条目：只显示包含图片或视频的推文
    if (imageUrls.length === 0 && videoUrls.length === 0) continue;

    // 生成伪推文 ID（asia.aguea.com 不提供推文状态链接）
    // 优先用第一张图片的文件名，其次用文本哈希
    let pseudoId = '';
    if (imageUrls.length > 0) {
      const fnMatch = imageUrls[0].match(/\/media\/([^.]+)/);
      if (fnMatch) pseudoId = fnMatch[1];
    }
    if (!pseudoId && videoUrls.length > 0) {
      const fnMatch = videoUrls[0].match(/\/amplify_video\/([^/]+)/);
      if (fnMatch) pseudoId = fnMatch[1];
    }
    if (!pseudoId) {
      pseudoId = simpleHash(text + pubDate);
    }

    const tweetLink = 'https://x.com/' + username + '/status/' + pseudoId;

    // 构建描述 HTML
    let desc = '<p>' + escapeHtml(text) + '</p>';

    // 添加图片
    // 将 venexa.site 替换为 pbs.twimg.com，通过官方 CDN 代理速度更快
    for (const imgUrl of imageUrls) {
      const twimgUrl = imgUrl.replace(/https?:\/\/venexa\.site\//, 'https://pbs.twimg.com/');
      desc += '<img src="' + twimgUrl + '" />';
    }

    // 添加视频（将 m3u8 转换为 MP4 格式，附带预览图）
    // 转换为 MP4 后：
    //   1. 手机浏览器可嗅探到 .mp4 直接视频链接
    //   2. 避免主播放列表暴露多个变体 URL 导致嗅探器返回多个链接
    //   3. 选择中等码率确保加载速度
    for (let i = 0; i < videoUrls.length; i++) {
      const videoUrl = videoUrls[i];
      const posterUrl = videoPosters[i] || '';
      const cleanVideoUrl = videoUrl.replace(/&amp;/g, '&').replace(/https?:\/\/venexa\.site\//, 'https://video.twimg.com/');
      const cleanPosterUrl = posterUrl.replace(/&amp;/g, '&').replace(/https?:\/\/venexa\.site\//, 'https://pbs.twimg.com/');

      // 将 m3u8 解析为中等码率的直接 MP4 URL
      const mp4Url = await resolveTwitterVideoMp4(cleanVideoUrl);

      if (posterUrl) {
        desc += '<img src="' + cleanPosterUrl + '" />';
      }
      desc += '<video src="' + mp4Url + '" controls></video>';
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
//   相对时间: "15h", "2d", "3m", "30s"
//   绝对时间: "Aug 4", "Aug 4, 2025", "Jan 5"
function parseNitterDate(dateStr) {
  if (!dateStr) return '';

  const now = new Date();

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
  // Nitter 默认不显示年份，假设是当前年份
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
      // 如果日期是未来的日期且没有指定年份，可能是去年的
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

// ─── 方案 B：Syndication API（回退）──────────────────────────
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
      return buildEmptyRss(username, 'Syndication API 对该用户返回空（Twitter 可能对该用户限制了无认证访问）');
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
      for (const m of mediaList) {
        if (m.type === 'photo') {
          desc += '<img src="' + (m.media_url_https || '') + '" />';
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          const poster = m.media_url_https || '';
          if (poster) {
            desc += '<img src="' + poster + '" />';
          }
          const mp4Url = pickBestMp4(m.video_info?.variants || []);
          if (mp4Url) {
            desc += '<video src="' + mp4Url + '" controls></video>';
          }
        }
      }

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
      return buildEmptyRss(username, '该用户暂无可获取的公开推文');
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

  // 方案 A：尝试 Nitter HTML 解析（首选）
  let rss = await fetchFromNitter(username, maxItems);

  // 方案 B：Nitter 失败，回退到 Syndication API
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
