// 第二轮测试：针对 xcancel User-Agent 绕过 + syndication 完整数据
// 部署后访问: /test-twitter-sources?user=fresh_Hunk

const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

async function testSource(name, url, headers) {
  const result = { name, url, status: null, contentType: null, size: 0, snippet: '', error: null, flags: {} };
  try {
    const res = await fetch(url, {
      headers: headers || { 'User-Agent': FETCH_UA, 'Accept': '*/*' },
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
    });
    result.status = res.status;
    result.contentType = res.headers.get('content-type') || '';
    result.finalUrl = res.url || url;
    const text = await res.text();
    result.size = text.length;
    result.snippet = text.substring(0, 3000);
    result.flags.hasRssTag = text.includes('<rss') || text.includes('<channel');
    result.flags.hasItems = text.includes('<item>');
    result.flags.hasJsonData = text.includes('"data"') && text.includes('"text"');
    result.flags.hasTweetId = text.includes('status/') || /\d{15,20}/.test(text);
    result.flags.hasTwimg = text.includes('twimg.com') || text.includes('pbs.twimg');
    result.flags.hasVideo = text.includes('video') || text.includes('.mp4');
    result.flags.hasCloudflare = text.includes('Just a moment') || text.includes('cf-challenge');
    result.flags.hasNotfound = text.includes('not found') || text.includes('does not exist');
    result.flags.isRssClientOnly = text.includes('only works inside an RSS client');
    result.flags.isEmpty = text.length < 200;
    result.flags.hasEntries = text.includes('entries');
    result.flags.hasHasResults = text.includes('hasResults');
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

  // 不同 RSS 阅读器的 User-Agent
  const rssReaderUAs = [
    'Feedly/1.0 (+https://feedly.com)',
    'Mozilla/5.0 (compatible; RSS Reader; +https://example.com)',
    'Inoreader/1.0 (+https://inoreader.com)',
    'FreshRSS/1.20 (Linux; https://freshrss.org)',
    'Tiny Tiny RSS/2.0 (https://tt-rss.org)',
  ];

  const sources = [];

  // 测试 xcancel 用不同 UA
  for (const ua of rssReaderUAs) {
    sources.push({
      name: 'xcancel UA=' + ua.substring(0, 30),
      url: 'https://xcancel.com/' + username + '/rss',
      headers: { 'Accept': 'application/rss+xml,application/xml,text/xml', 'User-Agent': ua },
    });
  }

  // 测试 xcancel 不带 Accept 头
  sources.push({
    name: 'xcancel no-Accept',
    url: 'https://xcancel.com/' + username + '/rss',
    headers: { 'User-Agent': 'Feedly/1.0 (+https://feedly.com)' },
  });

  // 测试 xcancel HTML 页面（非 RSS）
  sources.push({
    name: 'xcancel HTML page',
    url: 'https://xcancel.com/' + username,
    headers: { 'Accept': 'text/html', 'User-Agent': FETCH_UA },
  });

  // Syndication API — 返回完整 JSON 内容（不截断）
  sources.push({
    name: 'syndication full',
    url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/' + username,
    headers: { 'Accept': 'text/html', 'User-Agent': FETCH_UA },
  });

  // 也测 op7418 作为对照
  sources.push({
    name: 'syndication op7418 (control)',
    url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/op7418',
    headers: { 'Accept': 'text/html', 'User-Agent': FETCH_UA },
  });

  // 测试 twstalker 不同路径
  sources.push({
    name: 'twstalker /rss UA=feedly',
    url: 'https://www.twstalker.com/' + username + '/rss',
    headers: { 'Accept': 'application/rss+xml', 'User-Agent': 'Feedly/1.0 (+https://feedly.com)' },
  });

  // 并行测试
  const results = await Promise.all(sources.map(s => testSource(s.name, s.url, s.headers)));

  const json = JSON.stringify({
    username,
    testedAt: new Date().toISOString(),
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
