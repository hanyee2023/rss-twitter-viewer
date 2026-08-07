// Reddit 子版块 RSS 生成器
// 通过 Redlib 实例获取 Reddit 内容，解析 HTML 提取媒体帖子
// NSFW 内容通过 cookie (show_nsfw=on) 启用
// 视频输出策略：Redlib 已解析出直接 MP4 URL，可直接内嵌播放
// 订阅地址: /reddit-rss?sub=子版块名称
// 可选参数: sort=hot|new|top|rising (默认 hot)

const DEFAULT_MAX_ITEMS = 20;
const ABSOLUTE_MAX_ITEMS = 50;

// Redlib 实例列表（按优先级排序，排除 SFW-only 实例如 safereddit.com）
// 这些实例未开启 SFW_ONLY，配合 show_nsfw cookie 可获取 NSFW 内容
const REDLIB_INSTANCES = [
  'https://redlib.catsarch.com',
  'https://redlib.r4fo.com',
  'https://red.artemislena.eu',
  'https://redlib.cow.rip',
  'https://redlib.privacyredirect.com',
  'https://redlib.nadeko.net',
  'https://reddit.rtrace.io',
  'https://redlib.privadency.com',
];

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 10000;

// NSFW cookie：显示 NSFW 内容且不模糊，使用 card 布局确保媒体直接展示
// show_nsfw=on  → 显示 NSFW 帖子（默认 off，NSFW 帖子会被完全隐藏）
// blur_nsfw=off → 不模糊 NSFW 媒体（默认 on，图片/视频会打码）
// layout=card   → 卡片布局，媒体直接嵌入列表页（非卡片布局只显示缩略图）
const NSFW_COOKIE = 'show_nsfw=on; blur_nsfw=off; layout=card';

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

function decodeHtml(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

// ─── 从 Redlib 实例获取子版块页面并解析 ──────────────────────────
async function fetchFromRedlib(subreddit, maxItems, sort) {
  for (const base of REDLIB_INSTANCES) {
    try {
      const url = `${base}/r/${subreddit}/${sort}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': FETCH_UA,
          'Accept': 'text/html,application/xhtml+xml',
          'Cookie': NSFW_COOKIE,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: 'follow',
      });

      if (!res.ok) continue;

      const html = await res.text();

      // 检测 Cloudflare 验证页面
      if (html.includes('Just a moment') || html.includes('cf-challenge')) continue;

      // 检测 NSFW 被实例级屏蔽（SFW_ONLY=on 的实例会显示此消息）
      if (html.includes('All posts are hidden because they are NSFW')) {
        continue; // 该实例屏蔽了 NSFW，尝试下一个
      }

      // 检测子版块不存在或无帖子
      if (html.includes('No posts were found') && !html.includes('post_title')) {
        return buildEmptyRss(subreddit, '该子版块不存在或暂无帖子');
      }

      // 检测是否有帖子
      if (!html.includes('post_title')) continue;

      const items = parseRedlibHtml(html, subreddit, maxItems, base);

      if (items.length === 0) {
        return buildEmptyRss(subreddit, '该子版块暂无可获取的媒体帖子（可能全是纯文本帖）');
      }

      return buildRssXml(subreddit, items, 'via Redlib');
    } catch (e) {
      continue;
    }
  }
  return null;
}

// ─── 解析 Redlib HTML，提取帖子标题、媒体内容 ───────────────────
// Redlib 的帖子列表页 HTML 结构（card 布局）：
//   <div class="post" id="POST_ID">
//     <p class="post_header">
//       <a class="post_subreddit" href="/r/SUB">r/SUB</a>
//       <span class="created" title="TIMESTAMP">REL_TIME</span>
//     </p>
//     <h2 class="post_title"><a href="PERMALINK">TITLE</a></h2>
//     <!-- 图片帖 -->
//     <div class="post_media_content">
//       <a class="post_media_image" href="IMAGE_URL">
//         <img src="IMAGE_URL" /> 或 <svg><image href="IMAGE_URL"/></svg>
//       </a>
//     </div>
//     <!-- 视频帖（非 HLS） -->
//     <div class="post_media_content">
//       <video class="post_media_video" src="MP4_URL" poster="POSTER_URL" controls>
//     </div>
//     <!-- 视频帖（HLS 模式） -->
//     <div class="post_media_content">
//       <video class="post_media_video" poster="POSTER_URL" controls>
//         <source src="HLS_URL" type="application/vnd.apple.mpegurl" />
//         <source src="MP4_URL" type="video/mp4" />
//       </video>
//     </div>
//     <!-- 图库帖 / 链接帖：只显示缩略图 -->
//     <a class="post_thumbnail" href="...">
//       <svg><image href="THUMBNAIL_URL"/></svg>
//     </a>
//   </div>
//
// Redlib 已从 Reddit DASH 清单中解析出直接 MP4 URL，无需额外处理
// 媒体 URL 均为 Reddit CDN 绝对地址（如 https://i.redd.it/xxx.jpg）
function parseRedlibHtml(html, subreddit, maxItems, redlibBase) {
  const items = [];

  // 用 class="post" 分隔每个帖子块
  const postBlocks = html.split(/(?=<div class="post(?:\s|")/i);

  for (const block of postBlocks) {
    if (items.length >= maxItems) break;

    // 跳过非帖子块（如 stickied 公告等也包含 post_title，保留处理）
    if (!block.includes('post_title')) continue;

    // 提取标题和永久链接
    // <h2 class="post_title"><a href="/r/SUB/comments/ID/title/">标题文本</a></h2>
    const titleMatch = block.match(/<h2 class="post_title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const permalink = titleMatch[1];
    // 清理标题中的 HTML 标签（如 flair、NSFW 标记等）
    const title = decodeHtml(titleMatch[2]
      .replace(/<a[^>]*>[\s\S]*?<\/a>/gi, '') // 移除 flair 链接
      .replace(/<small[^>]*>[\s\S]*?<\/small>/gi, '') // 移除 NSFW/Spoiler 标记
      .replace(/<[^>]+>/g, '')
      .trim());

    if (!title) continue;

    // 提取日期
    // <span class="created" title="TIMESTAMP">REL_TIME</span>
    const dateMatch = block.match(/<span class="created"[^>]*title="([^"]+)"[^>]*>([^<]+)<\/span>/i);
    let pubDate = '';
    if (dateMatch) {
      pubDate = parseRedlibDate(dateMatch[1].trim(), dateMatch[2].trim());
    }
    if (!pubDate) pubDate = new Date().toUTCString();

    // 提取媒体内容
    let desc = '<p>' + escapeHtml(title) + '</p>';
    let hasMedia = false;

    // ── 1. 视频（非 HLS 模式）──
    // <video class="post_media_video" src="MP4_URL" poster="POSTER_URL" ...>
    // Redlib 已解析出直接 MP4 URL，可直接用于浏览器播放
    const videoTagMatch = block.match(/<video[^>]*class="post_media_video"[^>]*>/i);
    if (videoTagMatch) {
      const videoTag = videoTagMatch[0];
      const srcMatch = videoTag.match(/\ssrc="([^"]+)"/i);
      const posterMatch = videoTag.match(/\sposter="([^"]+)"/i);

      if (srcMatch) {
        // 非 HLS 模式：video 标签直接包含 src
        const videoUrl = srcMatch[1];
        const posterUrl = posterMatch ? posterMatch[1] : '';

        if (posterUrl) {
          desc += '<img src="' + posterUrl + '" />';
        }
        desc += '<video src="' + videoUrl + '" controls></video>';
        hasMedia = true;
      } else {
        // HLS 模式：video 标签无 src，通过 <source> 标签提供
        // 提取 type="video/mp4" 的 source（跳过 HLS source）
        const sourceTags = block.matchAll(/<source[^>]*>/gi);
        for (const sourceMatch of sourceTags) {
          const sourceTag = sourceMatch[0];
          if (/type=["']video\/mp4["']/i.test(sourceTag)) {
            const mp4SrcMatch = sourceTag.match(/\ssrc="([^"]+)"/i);
            if (mp4SrcMatch) {
              const videoUrl = mp4SrcMatch[1];
              const posterUrl = posterMatch ? posterMatch[1] : '';

              if (posterUrl) {
                desc += '<img src="' + posterUrl + '" />';
              }
              desc += '<video src="' + videoUrl + '" controls></video>';
              hasMedia = true;
              break;
            }
          }
        }
      }
    }

    // ── 2. 图片帖 ──
    // <a class="post_media_image" href="FULL_IMAGE_URL">
    //   <img src="IMAGE_URL" /> 或 <svg><image href="IMAGE_URL"/></svg>
    // </a>
    if (!hasMedia) {
      const imageMatch = block.match(/<a[^>]*class="[^"]*post_media_image[^"]*"[^>]*href="([^"]+)"/i);
      if (imageMatch) {
        const imageUrl = imageMatch[1];
        desc += '<img src="' + imageUrl + '" />';
        hasMedia = true;
      }
    }

    // ── 3. 图库帖：列表页只显示缩略图 ──
    // 图库帖在列表页不展开，只显示 post_thumbnail
    // 提取缩略图 URL 作为预览图
    if (!hasMedia) {
      if (block.includes('post_thumbnail') && !block.includes('no_thumbnail')) {
        const thumbMatch = block.match(/<a[^>]*class="[^"]*post_thumbnail[^"]*"[^>]*>[\s\S]*?<image[^>]*href="([^"]+)"/i);
        if (thumbMatch) {
          const thumbUrl = thumbMatch[1];
          desc += '<img src="' + thumbUrl + '" />';
          hasMedia = true;
        }
      }
    }

    // 跳过无媒体帖子（纯文本帖、无缩略图的链接帖）
    if (!hasMedia) continue;

    // 构建帖子链接（指向 Reddit 原始页面）
    const redditLink = permalink.startsWith('http')
      ? permalink
      : 'https://www.reddit.com' + permalink;

    items.push(
      '<item>\n' +
      '<title>' + escapeXml(title) + '</title>\n' +
      '<link>' + redditLink + '</link>\n' +
      '<description><![CDATA[' + desc + ']]></description>\n' +
      '<pubDate>' + pubDate + '</pubDate>\n' +
      '<guid isPermaLink="true">' + redditLink + '</guid>\n' +
      '</item>'
    );
  }

  return items;
}

// ─── 日期解析 ──────────────────────────────────────────────────
// Redlib 的 title 属性通常包含完整时间戳，rel_time 包含相对时间
// 支持的格式：
//   title: ISO 日期、Unix 时间戳、自定义格式
//   rel_time: "2 hours ago", "1 day ago", "3 minutes ago", "just now"
function parseRedlibDate(titleAttr, relTime) {
  // 优先使用 title 属性中的完整时间戳
  if (titleAttr) {
    // 尝试直接解析（ISO 格式或 JavaScript 可识别的格式）
    const parsed = new Date(titleAttr);
    if (!isNaN(parsed.getTime())) {
      return parsed.toUTCString();
    }

    // 尝试 Unix 时间戳（秒或毫秒）
    const ts = parseFloat(titleAttr);
    if (!isNaN(ts) && ts > 0) {
      const date = new Date(ts > 1e12 ? ts : ts * 1000);
      if (!isNaN(date.getTime())) {
        return date.toUTCString();
      }
    }
  }

  // 回退到相对时间解析
  if (relTime) {
    const now = new Date();

    const hoursMatch = relTime.match(/(\d+)\s*hour/i);
    if (hoursMatch) {
      return new Date(now.getTime() - parseInt(hoursMatch[1]) * 3600000).toUTCString();
    }

    const daysMatch = relTime.match(/(\d+)\s*day/i);
    if (daysMatch) {
      return new Date(now.getTime() - parseInt(daysMatch[1]) * 86400000).toUTCString();
    }

    const minMatch = relTime.match(/(\d+)\s*minute/i);
    if (minMatch) {
      return new Date(now.getTime() - parseInt(minMatch[1]) * 60000).toUTCString();
    }

    const secMatch = relTime.match(/(\d+)\s*second/i);
    if (secMatch) {
      return new Date(now.getTime() - parseInt(secMatch[1]) * 1000).toUTCString();
    }

    if (/just now/i.test(relTime)) {
      return now.toUTCString();
    }
  }

  return '';
}

// ─── 构建 RSS XML ──────────────────────────────────────────────
function buildRssXml(subreddit, items, source) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    '<channel>\n' +
    '<title>r/' + escapeXml(subreddit) + ' / Reddit</title>\n' +
    '<link>https://www.reddit.com/r/' + escapeXml(subreddit) + '</link>\n' +
    '<description>Reddit 子版块 r/' + escapeXml(subreddit) + ' 媒体时间线（' + source + '）</description>\n' +
    '<language>en</language>\n' +
    '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
    items.join('\n') + '\n' +
    '</channel>\n' +
    '</rss>'
  );
}

function buildEmptyRss(subreddit, reason) {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    '<channel>\n' +
    '<title>r/' + escapeXml(subreddit) + ' / Reddit</title>\n' +
    '<link>https://www.reddit.com/r/' + escapeXml(subreddit) + '</link>\n' +
    '<description>' + escapeXml(reason) + '</description>\n' +
    '<language>en</language>\n' +
    '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
    '</channel>\n' +
    '</rss>'
  );
}

// ─── 主入口 ────────────────────────────────────────────────────
export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);

  // 解析子版块名称：支持 r/gifs、/r/gifs、gifs 等格式
  let subreddit = (url.searchParams.get('sub') || '')
    .replace(/^\/?r\//i, '')  // 去掉 r/ 前缀
    .replace(/^https?:\/\/[^/]+\/r\//i, '')  // 去掉完整 URL 前缀
    .replace(/[^a-zA-Z0-9_+]/g, '')  // 只保留字母、数字、下划线、加号（多版块）
    .slice(0, 100);

  // 排序方式：hot（默认）、new、top、rising、controversial
  const sort = (url.searchParams.get('sort') || 'hot')
    .replace(/[^a-z]/g, '')
    .slice(0, 20);

  let maxItems = DEFAULT_MAX_ITEMS;
  const maxParam = parseInt(url.searchParams.get('max'), 10);
  if (maxParam > 0) {
    maxItems = Math.min(maxParam, ABSOLUTE_MAX_ITEMS);
  }

  if (!subreddit) {
    return new Response('缺少 sub 参数。用法: /reddit-rss?sub=子版块名称', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }

  // 尝试从 Redlib 实例获取内容
  let rss = await fetchFromRedlib(subreddit, maxItems, sort);

  // 所有实例均不可用
  if (!rss) {
    rss = buildEmptyRss(subreddit, '所有 Redlib 实例均不可用，可能是网络问题或实例维护中，请稍后重试');
  }

  return new Response(rss, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=300, stale-while-revalidate=300',
      'ETag': '"' + subreddit + '-' + sort + '-' + maxItems + '-' + Math.floor(Date.now() / 300000) + '"',
    }),
  });
}
