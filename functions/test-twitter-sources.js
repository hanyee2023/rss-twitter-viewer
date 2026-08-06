// 获取 asia.aguea.com 的完整 HTML 内容用于分析
const FETCH_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Allow-Headers': '*',
    ...extra,
  };
}

export async function onRequest({ request }) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(request.url);
  const username = (url.searchParams.get('user') || 'fresh_Hunk')
    .replace(/[^a-zA-Z0-9_]/g, '')
    .slice(0, 15);

  const results = {};

  // 1. 获取 aguea 完整 HTML
  try {
    const res = await fetch('https://asia.aguea.com/' + username, {
      headers: { 'Accept': 'text/html', 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(10000),
    });
    results.agueaStatus = res.status;
    results.agueaContentType = res.headers.get('content-type');
    const html = await res.text();
    results.agueaSize = html.length;
    // 返回完整 HTML（截断到 15000 字符以避免太大）
    results.agueaHtml = html.substring(0, 15000);
    // 提取关键结构信息
    results.agueaFlags = {
      hasTwimg: html.includes('twimg.com'),
      hasVideo: html.includes('.mp4') || html.includes('video'),
      hasTweetText: html.includes('tweet') || html.includes('status'),
      hasTweetId: /\d{15,20}/.test(html),
      hasJsonLd: html.includes('application/ld+json'),
      hasOgImage: html.includes('og:image'),
      hasDataAttr: html.includes('data-'),
      hasArticle: html.includes('<article'),
      hasDivTweet: html.includes('tweet') || html.includes('post'),
    };
  } catch (err) {
    results.agueaError = err.message;
  }

  // 2. 测试 aguea 其他用户路径格式
  const testPaths = [
    'https://asia.aguea.com/' + username + '/rss',
    'https://asia.aguea.com/' + username + '/feed',
    'https://asia.aguea.com/' + username + '/atom',
    'https://asia.aguea.com/rss/' + username,
    'https://asia.aguea.com/feed/' + username,
    'https://asia.aguea.com/api/' + username,
    'https://asia.aguea.com/api/v1/user/' + username,
    'https://asia.aguea.com/api/v2/user/' + username,
  ];

  results.pathTests = [];
  for (const p of testPaths) {
    try {
      const r = await fetch(p, {
        headers: { 'Accept': '*/*', 'User-Agent': FETCH_UA },
        signal: AbortSignal.timeout(5000),
        redirect: 'follow',
      });
      const t = await r.text();
      results.pathTests.push({
        url: p,
        status: r.status,
        size: t.length,
        snippet: t.substring(0, 500),
        contentType: r.headers.get('content-type'),
      });
    } catch (e) {
      results.pathTests.push({ url: p, error: e.message });
    }
  }

  // 3. 获取 zamantika 完整 HTML（看是否有不同结果）
  try {
    const res = await fetch('https://zamantika.com/' + username, {
      headers: { 'Accept': 'text/html', 'User-Agent': FETCH_UA },
      signal: AbortSignal.timeout(10000),
    });
    results.zamantikaStatus = res.status;
    const html = await res.text();
    results.zamantikaSize = html.length;
    results.zamantikaSnippet = html.substring(0, 3000);
    results.zamantikaFlags = {
      hasTwimg: html.includes('twimg.com'),
      hasVideo: html.includes('.mp4') || html.includes('video'),
      hasTweetId: /\d{15,20}/.test(html),
      hasCloudflare: html.includes('Just a moment') || html.includes('cf-challenge'),
    };
  } catch (err) {
    results.zamantikaError = err.message;
  }

  const json = JSON.stringify(results, null, 2);
  return new Response(json, {
    status: 200,
    headers: corsHeaders({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    }),
  });
}
