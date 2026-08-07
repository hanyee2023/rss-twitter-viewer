// Reddit 子版块 RSS 生成器
// 方案 A（首选）：Reddit JSON API（.json 端点），提供直接媒体 URL（含 MP4）
// 方案 B（回退）：Reddit 原生 RSS（.rss 端点），解析 XML 提取媒体
// 方案 C（末选）：Redlib 实例解析 HTML
// NSFW 内容：JSON API 默认包含 NSFW 帖子
// 订阅地址: /reddit-rss?sub=子版块名称
// 可选参数: sort=hot|new|top|rising (默认 hot)

const DEFAULT_MAX_ITEMS = 30;
const ABSOLUTE_MAX_ITEMS = 30;

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const FETCH_TIMEOUT = 12000;

// Reddit 域名列表（按优先级，某个域名被限流时自动切换）
const REDDIT_DOMAINS = ['https://www.reddit.com', 'https://old.reddit.com'];

// Redlib 实例列表（回退方案，排除 SFW-only 实例如 safereddit.com）
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

// ─── 方案 A：Reddit JSON API ──────────────────────────────────
// Reddit 提供 .json 端点，返回结构化 JSON 数据
// URL 格式：https://www.reddit.com/r/{subreddit}/{sort}.json?limit={n}
// 优势：
//   - 直接提供 MP4 视频链接（fallback_url）
//   - 直接提供图片 URL
//   - 提供缩略图和预览图
//   - 结构化数据，无需解析 HTML/XML
async function fetchFromRedditJson(subreddit, maxItems, sort) {
  const errors = [];

  for (const base of REDDIT_DOMAINS) {
    try {
      const url = `${base}/r/${subreddit}/${sort}.json?limit=${maxItems}&raw_json=1`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': FETCH_UA,
          'Accept': 'application/json,text/json,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: 'follow',
      });

      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`);
        continue;
      }

      const jsonText = await res.text();

      // 检测 Reddit 限流页面（返回 200 但内容不是 JSON）
      if (jsonText.includes('Whoa there, pardner') || jsonText.includes('slow down')) {
        errors.push(`${base}: rate limited`);
        continue;
      }

      let data;
      try {
        data = JSON.parse(jsonText);
      } catch (e) {
        errors.push(`${base}: JSON parse failed`);
        continue;
      }

      // Reddit JSON 结构：{ data: { children: [ { data: { ... } }, ... ] } }
      if (!data || !data.data || !Array.isArray(data.data.children)) {
        errors.push(`${base}: unexpected structure`);
        continue;
      }

      const items = parseRedditJson(data, maxItems);

      if (items.length === 0) {
        // 成功获取数据但没有媒体帖子
        return { rss: buildEmptyRss(subreddit, '该子版块暂无可获取的媒体帖子'), errors };
      }

      return { rss: buildRssXml(subreddit, items, 'via Reddit JSON'), errors };
    } catch (e) {
      errors.push(`${base}: ${e.message || 'fetch error'}`);
      continue;
    }
  }

  return { rss: null, errors };
}

// ─── 解析 Reddit JSON API 响应 ────────────────────────────────
function parseRedditJson(data, maxItems) {
  const items = [];
  const children = data.data.children;

  for (const child of children) {
    if (items.length >= maxItems) break;

    const post = child.data;
    if (!post) continue;

    // 跳过纯文本帖
    if (post.is_self) continue;

    const title = post.title || '';
    const permalink = post.permalink
      ? 'https://www.reddit.com' + post.permalink
      : '';
    const postUrl = post.url || '';
    const createdUtc = post.created_utc || 0;
    const pubDate = createdUtc > 0
      ? new Date(createdUtc * 1000).toUTCString()
      : new Date().toUTCString();

    let desc = '<p>' + escapeHtml(title) + '</p>';
    let hasMedia = false;

    // 获取视频 URL：检查 secure_media、media、preview 三种来源
    let videoUrl = null;
    let videoPosterUrl = null;

    // 1a. secure_media.reddit_video（HTTPS 视频）
    if (post.secure_media && post.secure_media.reddit_video) {
      videoUrl = post.secure_media.reddit_video.fallback_url;
    }
    // 1b. media.reddit_video（非 HTTPS 视频，某些帖子只有这个字段）
    if (!videoUrl && post.media && post.media.reddit_video) {
      videoUrl = post.media.reddit_video.fallback_url;
    }
    // 1c. preview.reddit_video_preview（GIF 转视频、跨站视频预览）
    if (!videoUrl && post.preview && post.preview.reddit_video_preview) {
      videoUrl = post.preview.reddit_video_preview.fallback_url;
    }

    if (videoUrl) {
      // 获取封面图
      videoPosterUrl = getPreviewImageUrl(post) || getThumbnailUrl(post);
      if (videoPosterUrl) desc += '<img src="' + videoPosterUrl + '" />';
      // 输出 <video> 标签，同时输出纯文本 URL 方便前端提取
      desc += '<video src="' + videoUrl + '" controls></video>';
      desc += '<p>' + videoUrl + '</p>';
      hasMedia = true;
    }

    // ── 2. Gallery 图库帖（多张图片）──
    // Reddit 图库帖：post.is_gallery = true
    // 图片信息在 post.gallery_data.items[].media_id
    // URL 在 post.media_metadata[media_id].s.u
    if (!hasMedia && post.is_gallery && post.gallery_data && post.media_metadata) {
      const galleryItems = post.gallery_data.items || [];
      const metadata = post.media_metadata;
      let galleryImgCount = 0;

      for (const galleryItem of galleryItems) {
        if (galleryImgCount >= 10) break; // 最多 10 张图
        const mediaId = galleryItem.media_id;
        if (!mediaId || !metadata[mediaId]) continue;

        const meta = metadata[mediaId];
        let imgUrl = null;

        // s.u 是图片 URL（需要解码 HTML 实体）
        if (meta.s && meta.s.u) {
          imgUrl = decodeHtml(meta.s.u);
        } else if (meta.p && meta.p.length > 0) {
          // p 是预览尺寸数组，取最大尺寸
          imgUrl = decodeHtml(meta.p[meta.p.length - 1].u);
        }

        if (imgUrl && imgUrl.startsWith('http')) {
          // 跳过 GIF 类型（由视频处理逻辑负责）
          if (meta.e === 'AnimatedImage' && meta.s && meta.s.mp4) {
            // 动图，输出 MP4
            desc += '<video src="' + meta.s.mp4 + '" controls></video>';
            desc += '<p>' + meta.s.mp4 + '</p>';
          } else {
            desc += '<img src="' + imgUrl + '" />';
          }
          hasMedia = true;
          galleryImgCount++;
        }
      }
    }

    // ── 3. 单张图片帖（i.redd.it, preview.redd.it 等）──
    if (!hasMedia) {
      const postHint = post.post_hint || '';
      if (postHint === 'image' || /\.(jpg|jpeg|png|gif|webp)$/i.test(postUrl)) {
        if (postUrl && postUrl.startsWith('http')) {
          desc += '<img src="' + postUrl + '" />';
          hasMedia = true;
        }
      }
    }

    // ── 4. 预览图片（适用于链接帖等）──
    if (!hasMedia && post.preview && Array.isArray(post.preview.images) && post.preview.images.length > 0) {
      const previewImg = post.preview.images[0];
      let imgUrl = previewImg.source && previewImg.source.url;
      if (!imgUrl && previewImg.resolutions && previewImg.resolutions.length > 0) {
        const midIdx = Math.floor(previewImg.resolutions.length / 2);
        imgUrl = previewImg.resolutions[midIdx].url;
      }
      if (imgUrl) {
        imgUrl = decodeHtml(imgUrl);
        desc += '<img src="' + imgUrl + '" />';
        hasMedia = true;
      }
    }

    // ── 5. 外部视频/GIF（redgifs, imgur 等）──
    if (!hasMedia) {
      const lowerUrl = postUrl.toLowerCase();
      if (lowerUrl.includes('redgifs.com') || lowerUrl.includes('imgur.com')) {
        desc += '<a href="' + postUrl + '">' + escapeHtml(postUrl) + '</a>';
        desc += '<p>' + postUrl + '</p>';
        hasMedia = true;
      }
    }

    // ── 6. 缩略图兜底 ──
    if (!hasMedia) {
      const thumbUrl = getThumbnailUrl(post);
      if (thumbUrl) {
        desc += '<img src="' + thumbUrl + '" />';
        hasMedia = true;
      }
    }

    // 跳过无媒体帖子
    if (!hasMedia) continue;

    items.push(
      '<item>\n' +
      '<title>' + escapeXml(title) + '</title>\n' +
      '<link>' + escapeXml(permalink || postUrl) + '</link>\n' +
      '<description><![CDATA[' + desc + ']]></description>\n' +
      '<pubDate>' + pubDate + '</pubDate>\n' +
      '<guid isPermaLink="true">' + escapeXml(permalink || postUrl) + '</guid>\n' +
      '</item>'
    );
  }

  return items;
}

// 获取缩略图 URL（排除 "self", "default", "nsfw", "image" 等非 URL 值）
function getThumbnailUrl(post) {
  const thumb = post.thumbnail;
  if (!thumb) return null;
  if (thumb === 'self' || thumb === 'default' || thumb === 'nsfw' || thumb === 'image' || thumb === 'spoiler') {
    return null;
  }
  if (thumb.startsWith('http')) return thumb;
  return null;
}

// 获取预览图片 URL
function getPreviewImageUrl(post) {
  if (!post.preview || !Array.isArray(post.preview.images) || post.preview.images.length === 0) {
    return null;
  }
  const img = post.preview.images[0];
  if (img.source && img.source.url) {
    return decodeHtml(img.source.url);
  }
  if (img.resolutions && img.resolutions.length > 0) {
    return decodeHtml(img.resolutions[Math.floor(img.resolutions.length / 2)].url);
  }
  return null;
}

// ─── 方案 B：Reddit 原生 RSS（回退）──────────────────────────
async function fetchFromRedditRss(subreddit, maxItems, sort) {
  const errors = [];

  for (const base of REDDIT_DOMAINS) {
    try {
      const url = `${base}/r/${subreddit}/${sort}.rss?limit=${maxItems}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': FETCH_UA,
          'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
        redirect: 'follow',
      });

      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`);
        continue;
      }

      const xmlText = await res.text();

      if (!xmlText.includes('<item') && !xmlText.includes('<entry')) {
        errors.push(`${base}: no items in RSS`);
        continue;
      }

      const items = parseRedditRss(xmlText, maxItems);

      if (items.length === 0) {
        return { rss: buildEmptyRss(subreddit, '该子版块暂无可获取的媒体帖子'), errors };
      }

      return { rss: buildRssXml(subreddit, items, 'via Reddit RSS'), errors };
    } catch (e) {
      errors.push(`${base}: ${e.message || 'fetch error'}`);
      continue;
    }
  }

  return { rss: null, errors };
}

// ─── 解析 Reddit 原生 RSS XML ─────────────────────────────────
function parseRedditRss(xmlText, maxItems) {
  const items = [];
  const itemBlocks = splitXmlItems(xmlText);

  for (const block of itemBlocks) {
    if (items.length >= maxItems) break;

    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (!titleMatch) continue;
    const title = decodeHtml(titleMatch[1].trim());

    const linkMatch = block.match(/<link[^>]*>([\s\S]*?)<\/link>/i)
      || block.match(/<link[^>]*href="([^"]+)"/i);
    const link = linkMatch ? (linkMatch[1] || '').trim() : '';

    const dateMatch = block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i)
      || block.match(/<published[^>]*>([\s\S]*?)<\/published>/i)
      || block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/i);
    let pubDate = '';
    if (dateMatch) {
      const parsed = new Date(dateMatch[1].trim());
      if (!isNaN(parsed.getTime())) {
        pubDate = parsed.toUTCString();
      }
    }
    if (!pubDate) pubDate = new Date().toUTCString();

    let desc = '<p>' + escapeHtml(title) + '</p>';
    let hasMedia = false;

    // 提取 content:encoded
    const contentMatch = block.match(/<content:encoded[^>]*>([\s\S]*?)<\/content:encoded>/i)
      || block.match(/<content[^>]*>([\s\S]*?)<\/content>/i);

    if (contentMatch) {
      // 先解码 HTML 实体，确保能匹配到 <img> 等标签
      const content = decodeHtml(contentMatch[1]);

      // 提取图片
      const imgRegex = /<img[^>]+src="([^"]+)"/gi;
      let imgMatch;
      while ((imgMatch = imgRegex.exec(content)) !== null) {
        const imgUrl = imgMatch[1];
        if (imgUrl.includes('redditmedia.com') && imgUrl.includes('sprite')) continue;
        if (imgUrl.includes('redditstatic.com')) continue;
        desc += '<img src="' + imgUrl + '" />';
        hasMedia = true;
      }

      // 提取视频链接
      const videoLinkRegex = /<a[^>]*href="(https?:\/\/v\.redd\.it\/[^"]+)"/gi;
      let vidMatch;
      while ((vidMatch = videoLinkRegex.exec(content)) !== null) {
        desc += '<video src="' + vidMatch[1] + '" controls></video>';
        hasMedia = true;
      }

      // 提取外部链接
      const extVideoRegex = /<a[^>]*href="(https?:\/\/(?:www\.)?(?:redgifs|imgur)\.com\/[^"]+)"/gi;
      let extMatch;
      while ((extMatch = extVideoRegex.exec(content)) !== null) {
        desc += '<a href="' + extMatch[1] + '">' + extMatch[1] + '</a>';
        hasMedia = true;
      }
    }

    // media:thumbnail 兜底
    if (!hasMedia) {
      const thumbMatch = block.match(/<media:thumbnail[^>]*url="([^"]+)"/i)
        || block.match(/<media:content[^>]*url="([^"]+)"/i);
      if (thumbMatch) {
        desc += '<img src="' + thumbMatch[1] + '" />';
        hasMedia = true;
      }
    }

    // enclosure 兜底
    if (!hasMedia) {
      const encMatch = block.match(/<enclosure[^>]*url="([^"]+)"/i);
      if (encMatch) {
        const encUrl = encMatch[1];
        const encType = block.match(/<enclosure[^>]*type="([^"]+)"/i);
        if (encType && /video/i.test(encType[1])) {
          desc += '<video src="' + encUrl + '" controls></video>';
        } else {
          desc += '<img src="' + encUrl + '" />';
        }
        hasMedia = true;
      }
    }

    if (!hasMedia) continue;

    items.push(
      '<item>\n' +
      '<title>' + escapeXml(title) + '</title>\n' +
      '<link>' + escapeXml(link) + '</link>\n' +
      '<description><![CDATA[' + desc + ']]></description>\n' +
      '<pubDate>' + pubDate + '</pubDate>\n' +
      '<guid isPermaLink="true">' + escapeXml(link) + '</guid>\n' +
      '</item>'
    );
  }

  return items;
}

// 分割 XML 中的 <item> 或 <entry> 块
function splitXmlItems(xmlText) {
  const blocks = [];

  let startTag = '<item';
  let endTag = '</item>';
  let pos = 0;
  while (true) {
    const start = xmlText.indexOf(startTag, pos);
    if (start === -1) break;
    const end = xmlText.indexOf(endTag, start);
    if (end === -1) break;
    blocks.push(xmlText.substring(start, end + endTag.length));
    pos = end + endTag.length;
  }

  if (blocks.length === 0) {
    startTag = '<entry';
    endTag = '</entry>';
    pos = 0;
    while (true) {
      const start = xmlText.indexOf(startTag, pos);
      if (start === -1) break;
      const end = xmlText.indexOf(endTag, start);
      if (end === -1) break;
      blocks.push(xmlText.substring(start, end + endTag.length));
      pos = end + endTag.length;
    }
  }

  return blocks;
}

// ─── 方案 C：Redlib 实例（末选）──────────────────────────────
async function fetchFromRedlib(subreddit, maxItems, sort) {
  const errors = [];

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

      if (!res.ok) {
        errors.push(`${base}: HTTP ${res.status}`);
        continue;
      }

      const html = await res.text();

      if (html.includes('Just a moment') || html.includes('cf-challenge')) {
        errors.push(`${base}: Cloudflare challenge`);
        continue;
      }
      if (html.includes('All posts are hidden because they are NSFW')) {
        errors.push(`${base}: NSFW hidden`);
        continue;
      }
      if (html.includes('No posts were found') && !html.includes('post_title')) {
        return { rss: buildEmptyRss(subreddit, '该子版块不存在或暂无帖子'), errors };
      }
      if (!html.includes('post_title')) {
        errors.push(`${base}: no post_title found`);
        continue;
      }

      const items = parseRedlibHtml(html, subreddit, maxItems, base);

      if (items.length === 0) {
        return { rss: buildEmptyRss(subreddit, '该子版块暂无可获取的媒体帖子'), errors };
      }

      return { rss: buildRssXml(subreddit, items, 'via Redlib'), errors };
    } catch (e) {
      errors.push(`${base}: ${e.message || 'fetch error'}`);
      continue;
    }
  }

  return { rss: null, errors };
}

// ─── 解析 Redlib HTML ──────────────────────────────────────────
function parseRedlibHtml(html, subreddit, maxItems, redlibBase) {
  const items = [];

  const postBlocks = [];
  const marker = '<div class="post';
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const nextIdx = html.indexOf(marker, idx + 1);
    if (nextIdx !== -1) {
      postBlocks.push(html.substring(idx, nextIdx));
    } else {
      postBlocks.push(html.substring(idx));
    }
    idx = nextIdx;
  }

  for (const block of postBlocks) {
    if (items.length >= maxItems) break;
    if (!block.includes('post_title')) continue;

    const titleMatch = block.match(/<h2 class="post_title"[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!titleMatch) continue;

    const permalink = titleMatch[1];
    const title = decodeHtml(titleMatch[2]
      .replace(/<a[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/<small[^>]*>[\s\S]*?<\/small>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim());

    if (!title) continue;

    const dateMatch = block.match(/<span class="created"[^>]*title="([^"]+)"[^>]*>([^<]+)<\/span>/i);
    let pubDate = '';
    if (dateMatch) {
      pubDate = parseRedlibDate(dateMatch[1].trim(), dateMatch[2].trim());
    }
    if (!pubDate) pubDate = new Date().toUTCString();

    let desc = '<p>' + escapeHtml(title) + '</p>';
    let hasMedia = false;

    // 视频提取
    const videoTagMatch = block.match(/<video[^>]*class="post_media_video"[^>]*>/i);
    if (videoTagMatch) {
      const videoTag = videoTagMatch[0];
      const srcMatch = videoTag.match(/\ssrc="([^"]+)"/i);
      const posterMatch = videoTag.match(/\sposter="([^"]+)"/i);

      if (srcMatch) {
        const videoUrl = srcMatch[1];
        const posterUrl = posterMatch ? posterMatch[1] : '';
        if (posterUrl) desc += '<img src="' + posterUrl + '" />';
        desc += '<video src="' + videoUrl + '" controls></video>';
        hasMedia = true;
      } else {
        const videoEndIdx = block.indexOf('</video>', videoTagMatch.index);
        const videoBlock = videoEndIdx !== -1
          ? block.substring(videoTagMatch.index, videoEndIdx)
          : block.substring(videoTagMatch.index);
        const sourceTags = videoBlock.match(/<source[^>]*>/gi);
        if (sourceTags) {
          for (const sourceTag of sourceTags) {
            if (/type=["']video\/mp4["']/i.test(sourceTag)) {
              const mp4SrcMatch = sourceTag.match(/\ssrc="([^"]+)"/i);
              if (mp4SrcMatch) {
                const videoUrl = mp4SrcMatch[1];
                const posterUrl = posterMatch ? posterMatch[1] : '';
                if (posterUrl) desc += '<img src="' + posterUrl + '" />';
                desc += '<video src="' + videoUrl + '" controls></video>';
                hasMedia = true;
                break;
              }
            }
          }
        }
      }
    }

    // 图片帖
    if (!hasMedia) {
      const imageMatch = block.match(/<a[^>]*class="[^"]*post_media_image[^"]*"[^>]*href="([^"]+)"/i);
      if (imageMatch) {
        desc += '<img src="' + imageMatch[1] + '" />';
        hasMedia = true;
      }
    }

    // 图库帖缩略图
    if (!hasMedia) {
      if (block.includes('post_thumbnail') && !block.includes('no_thumbnail')) {
        const thumbMatch = block.match(/<a[^>]*class="[^"]*post_thumbnail[^"]*"[^>]*>[\s\S]*?<image[^>]*href="([^"]+)"/i);
        if (thumbMatch) {
          desc += '<img src="' + thumbMatch[1] + '" />';
          hasMedia = true;
        }
      }
    }

    if (!hasMedia) continue;

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

function parseRedlibDate(titleAttr, relTime) {
  if (titleAttr) {
    const parsed = new Date(titleAttr);
    if (!isNaN(parsed.getTime())) return parsed.toUTCString();

    const ts = parseFloat(titleAttr);
    if (!isNaN(ts) && ts > 0) {
      const date = new Date(ts > 1e12 ? ts : ts * 1000);
      if (!isNaN(date.getTime())) return date.toUTCString();
    }
  }

  if (relTime) {
    const now = new Date();
    const hoursMatch = relTime.match(/(\d+)\s*hour/i);
    if (hoursMatch) return new Date(now.getTime() - parseInt(hoursMatch[1]) * 3600000).toUTCString();
    const daysMatch = relTime.match(/(\d+)\s*day/i);
    if (daysMatch) return new Date(now.getTime() - parseInt(daysMatch[1]) * 86400000).toUTCString();
    const minMatch = relTime.match(/(\d+)\s*minute/i);
    if (minMatch) return new Date(now.getTime() - parseInt(minMatch[1]) * 60000).toUTCString();
    const secMatch = relTime.match(/(\d+)\s*second/i);
    if (secMatch) return new Date(now.getTime() - parseInt(secMatch[1]) * 1000).toUTCString();
    if (/just now/i.test(relTime)) return now.toUTCString();
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

function buildEmptyRss(subreddit, reason, errorDetails) {
  let itemsXml = '';

  // 如果有错误详情，生成一条诊断条目，让用户在前端看到错误信息
  if (errorDetails && errorDetails.length > 0) {
    const errorSummary = errorDetails.slice(0, 5).join('; ');
    const desc = '<p>Reddit RSS 获取失败</p><p>已尝试的数据源及错误：</p><p>' 
      + escapeHtml(errorSummary) + '</p><p>可能原因：Reddit 限制了 Cloudflare Workers 的访问，请稍后重试。</p>';
    itemsXml = 
      '<item>\n' +
      '<title>Reddit RSS 获取失败 - r/' + escapeXml(subreddit) + '</title>\n' +
      '<link>https://www.reddit.com/r/' + escapeXml(subreddit) + '</link>\n' +
      '<description><![CDATA[' + desc + ']]></description>\n' +
      '<pubDate>' + new Date().toUTCString() + '</pubDate>\n' +
      '<guid isPermaLink="false">reddit-error-' + subreddit + '-' + Date.now() + '</guid>\n' +
      '</item>\n';
  }

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss version="2.0">\n' +
    '<channel>\n' +
    '<title>r/' + escapeXml(subreddit) + ' / Reddit</title>\n' +
    '<link>https://www.reddit.com/r/' + escapeXml(subreddit) + '</link>\n' +
    '<description>' + escapeXml(reason) + '</description>\n' +
    '<language>en</language>\n' +
    '<lastBuildDate>' + new Date().toUTCString() + '</lastBuildDate>\n' +
    itemsXml +
    '</channel>\n' +
    '</rss>'
  );
}

// ─── 主入口：多源回退 + 8小时缓存 ────────────────────────────
export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);

  // 解析子版块名称：支持 r/gifs、/r/gifs、gifs 等格式
  let subreddit = (url.searchParams.get('sub') || '')
    .replace(/^\/?r\//i, '')
    .replace(/^https?:\/\/[^/]+\/r\//i, '')
    .replace(/[^a-zA-Z0-9_+]/g, '')
    .slice(0, 100);

  // 排序方式：hot（默认）
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

  // ── 8小时边缘缓存（Cloudflare Cache API）──
  // 使用 caches.default 在 Cloudflare 边缘节点缓存响应
  // 避免每次前端请求都打 Reddit API
  const cacheKey = new Request(`https://reddit-rss-cache.internal/${subreddit}/${sort}/${maxItems}`, { method: 'GET' });

  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      // 返回缓存的响应，添加 X-Cache: HIT 标记
      const cachedHeaders = new Headers(cached.headers);
      cachedHeaders.set('X-Cache', 'HIT');
      return new Response(cached.body, {
        status: cached.status,
        headers: cachedHeaders,
      });
    }
  } catch (e) {
    // Cache API 不可用时继续正常请求
  }

  // 方案 A：Reddit JSON API（首选，提供直接 MP4 链接）
  let result = await fetchFromRedditJson(subreddit, maxItems, sort);
  let allErrors = result.errors || [];

  // 方案 B：Reddit 原生 RSS（回退）
  if (!result.rss) {
    result = await fetchFromRedditRss(subreddit, maxItems, sort);
    allErrors = allErrors.concat(result.errors || []);
  }

  // 方案 C：Redlib 实例（末选）
  if (!result.rss) {
    result = await fetchFromRedlib(subreddit, maxItems, sort);
    allErrors = allErrors.concat(result.errors || []);
  }

  // 所有方案都失败
  let rss = result.rss;
  if (!rss) {
    rss = buildEmptyRss(
      subreddit,
      '所有数据源均不可用',
      allErrors
    );
  }

  const response = new Response(rss, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/rss+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=28800, stale-while-revalidate=28800',
      'X-Cache': 'MISS',
      'ETag': '"' + subreddit + '-' + sort + '-' + maxItems + '-' + Math.floor(Date.now() / 28800000) + '"',
    }),
  });

  // 将成功响应存入边缘缓存（8小时 = 28800秒）
  // 只缓存包含实际内容的响应（不缓存错误诊断条目）
  try {
    if (result.rss && rss.includes('<item>')) {
      await caches.default.put(cacheKey, response.clone());
    }
  } catch (e) {
    // 缓存写入失败时忽略
  }

  return response;
}
