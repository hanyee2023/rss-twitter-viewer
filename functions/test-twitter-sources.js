// 临时测试函数：验证所有 Twitter 数据源是否可用
// 部署后访问: /test-twitter-sources?user=fresh_Hunk
// 并行测试所有数据源，返回 JSON 结果
// 验证完成后可删除此文件

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

async function testSource(src) {
  const result = {
    name: src.name,
    url: src.url,
    status: null,
    contentType: null,
    size: 0,
    snippet: '',
    error: null,
    flags: {},
  };
  try {
    const res = await fetch(src.url, {
      headers: src.headers,
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    result.status = res.status;
    result.contentType = res.headers.get('content-type') || '';
    result.finalUrl = res.url || src.url;

    const text = await res.text();
    result.size = text.length;
    result.snippet = text.substring(0, 1500);

    // 内容检测标志
    result.flags.hasRssTag = text.includes('<rss') || text.includes('<channel');
    result.flags.hasItems = text.includes('<item>');
    result.flags.hasJsonData = text.includes('"data"') && text.includes('"text"');
    result.flags.hasTweetId = text.includes('status/') || /\d{15,20}/.test(text);
    result.flags.hasTwimg = text.includes('twimg.com') || text.includes('pbs.twimg');
    result.flags.hasVideo = text.includes('video') || text.includes('.mp4');
    result.flags.hasCloudflare = text.includes('Just a moment') || text.includes('cloudflare') || text.includes('cf-challenge');
    result.flags.hasNotfound = text.includes('not found') || text.includes('does not exist') || text.includes('User not found');
    result.flags.isRssClientOnly = text.includes('only works inside an RSS client');
    result.flags.isEmpty = text.length < 200;

  } catch (err) {
    result.error = err.message;
  }
  return result;
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const username = (url.searchParams.get('user') || 'fresh_Hunk')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 15);

  const htmlHeaders = { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': FETCH_UA };
  const rssHeaders = { 'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 'User-Agent': FETCH_UA };
  const jsonHeaders = { 'Accept': 'application/json,text/json,*/*', 'User-Agent': FETCH_UA };

  const sources = [
    // sotwe.com — 有 JSON API（RSSHub 源码中发现）
    { name: 'sotwe API', url: 'https://www.sotwe.com/api/v3/user/' + username + '/', headers: jsonHeaders },
    { name: 'sotwe HTML', url: 'https://www.sotwe.com/' + username, headers: htmlHeaders },
    { name: 'sotwe /rss', url: 'https://www.sotwe.com/' + username + '/rss', headers: rssHeaders },

    // twstalker.com
    { name: 'twstalker HTML', url: 'https://www.twstalker.com/' + username, headers: htmlHeaders },
    { name: 'twstalker /rss', url: 'https://www.twstalker.com/' + username + '/rss', headers: rssHeaders },

    // instalker.org
    { name: 'instalker HTML', url: 'https://instalker.org/' + username, headers: htmlHeaders },
    { name: 'instalker /rss', url: 'https://instalker.org/' + username + '/rss', headers: rssHeaders },

    // xcancel.com
    { name: 'xcancel /rss', url: 'https://xcancel.com/' + username + '/rss', headers: rssHeaders },

    // nitter.net
    { name: 'nitter /rss', url: 'https://nitter.net/' + username + '/rss', headers: rssHeaders },

    // Syndication API（原方案）
    { name: 'syndication', url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/' + username, headers: htmlHeaders },
  ];

  // 并行测试所有数据源（避免超时）
  const results = await Promise.all(sources.map(testSource));

  const json = JSON.stringify({
    username,
    testedAt: new Date().toISOString(),
    totalSources: sources.length,
    results,
  }, null, 2);

  return new Response(json, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}
