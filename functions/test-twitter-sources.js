// 第三轮测试：验证 carryfeed, zamantika, asia.aguea + 深入分析 syndication
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
      signal: AbortSignal.timeout(10000),
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
    result.flags.hasCloudflare = text.includes('Just a moment') || text.includes('cf-challenge') || text.includes('Attention Required');
    result.flags.hasNotfound = text.includes('not found') || text.includes('does not exist');
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

  const htmlH = { 'Accept': 'text/html,application/xhtml+xml', 'User-Agent': FETCH_UA };
  const rssH = { 'Accept': 'application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8', 'User-Agent': FETCH_UA };
  const rssFeedlyH = { 'Accept': 'application/rss+xml,application/xml', 'User-Agent': 'Feedly/1.0 (+https://feedly.com)' };

  const sources = [
    // 三个新站点
    { name: 'carryfeed HTML', url: 'https://carryfeed.com/' + username, headers: htmlH },
    { name: 'carryfeed /rss', url: 'https://carryfeed.com/' + username + '/rss', headers: rssH },
    { name: 'carryfeed /feed', url: 'https://carryfeed.com/' + username + '/feed', headers: rssH },
    { name: 'zamantika HTML', url: 'https://zamantika.com/' + username, headers: htmlH },
    { name: 'zamantika /rss', url: 'https://zamantika.com/' + username + '/rss', headers: rssH },
    { name: 'zamantika /feed', url: 'https://zamantika.com/' + username + '/feed', headers: rssH },
    { name: 'aguea HTML', url: 'https://asia.aguea.com/' + username, headers: htmlH },
    { name: 'aguea /rss', url: 'https://asia.aguea.com/' + username + '/rss', headers: rssH },
    { name: 'aguea /feed', url: 'https://asia.aguea.com/' + username + '/feed', headers: rssH },

    // xcancel with feedly UA（第二轮已确认返回 RSS 但需要白名单）
    { name: 'xcancel /rss feedly', url: 'https://xcancel.com/' + username + '/rss', headers: rssFeedlyH },

    // Syndication fresh_Hunk（确认 entries 为空）
    { name: 'syndication fresh_Hunk', url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/' + username, headers: htmlH },

    // Syndication op7418 对照
    { name: 'syndication op7418', url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/op7418', headers: htmlH },

    // 测试更多用户是否也返回空
    { name: 'syndication elonmusk', url: 'https://syndication.twitter.com/srv/timeline-profile/screen-name/elonmusk', headers: htmlH },
  ];

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
