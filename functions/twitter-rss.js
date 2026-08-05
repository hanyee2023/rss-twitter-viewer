// Twitter 用户时间线 RSS 生成器
// 使用 Twitter Syndication API（无需认证/cookie/账号）
// 部署到 Cloudflare Pages 的 functions 目录即可使用
// 订阅地址: /twitter-rss?user=用户名

const SYNDICATION_BASE = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/';

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

// 从视频变体列表中选择最高画质的 MP4
function pickBestMp4(variants) {
  const mp4s = variants
    .filter(v => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4s.length > 0 ? mp4s[0].url : null;
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  // 只允许字母、数字、下划线（Twitter 用户名规则）
  const username = (url.searchParams.get('user') || '')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 15);

  if (!username) {
    return new Response('缺少 user 参数。用法: /twitter-rss?user=用户名', {
      status: 400,
      headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }

  try {
    // 1. 从 Twitter Syndication API 获取时间线（无需 cookie/认证）
    const res = await fetch(SYNDICATION_BASE + username, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      return new Response(`Twitter API 返回 ${res.status}`, {
        status: 502,
        headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    }

    const html = await res.text();

    // 2. 从 HTML 中提取 __NEXT_DATA__ JSON
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match) {
      return new Response('无法解析时间线数据', {
        status: 502,
        headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
      });
    }

    const data = JSON.parse(match[1]);
    const entries = data?.props?.pageProps?.timeline?.entries || [];

    // 3. 生成 RSS 条目
    const items = [];
    for (const entry of entries) {
      const tweet = entry?.content?.tweet;
      if (!tweet) continue;

      const tweetId = tweet.conversation_id_str || '';
      const text = tweet.text || '';

      // 解析日期
      let pubDate = '';
      try {
        pubDate = new Date(tweet.created_at).toUTCString();
      } catch (e) {
        continue;
      }

      // 构建描述 HTML
      // 阅读器会从描述中自动提取 .mp4 / .jpg / .png 等 URL
        // 视频域名 video.twimg.com 和图片域名 pbs.twimg.com 已在代理白名单中
        // 阅读器会自动通过 media-proxy 代理这些 URL
        let desc = '<p>' + text + '</p>';

      const mediaList = tweet.entities?.media || [];
      for (const m of mediaList) {
        if (m.type === 'photo') {
          // 图片：直接用 img 标签，阅读器会提取 URL 并代理
          desc += '<img src="' + (m.media_url_https || '') + '" />';
        } else if (m.type === 'video' || m.type === 'animated_gif') {
          // 视频：先放缩略图（阅读器会用第一张图作为视频 poster）
          const poster = m.media_url_https || '';
          if (poster) {
            desc += '<img src="' + poster + '" />';
          }
          // 再放 MP4 URL（阅读器会提取 .mp4 URL 作为视频源）
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

    // 4. 生成完整 RSS
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

    return new Response(rss, {
      status: 200,
      headers: corsHeaders({
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=600',
      }),
    });
  } catch (err) {
    return new Response('生成 RSS 失败: ' + err.message, {
      status: 502,
      headers: corsHeaders({ 'Content-Type': 'text/plain; charset=utf-8' }),
    });
  }
}
