// 代理域名配置接口：前端“代理域名管理”弹窗的读写后端。
// 配置存在 RSS_CACHE KV（与 RSS 缓存共用同一命名空间，免去额外绑定）：
//   - proxy_rss_user   : JSON 字符串数组，用户自定义的 RSS 代理域名
//   - proxy_media_user : JSON 字符串数组，用户自定义的媒体代理域名
// 生效名单 = 内置默认 ∪ KV 用户名单。内置名单在代码中写死，UI 中只读不可删。
//
// 安全：GET 公开（仅返回域名，无害）；POST 写入必须带正确的管理令牌，
// 令牌比对环境变量 PROXY_ADMIN_TOKEN。未设置该变量时拒绝一切写入，
// 防止他人把你部署的 Worker 当开放代理滥用。

const BUILTIN_RSS_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "niter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com",
  "redd.it",
  "770118.xyz",
  "phe69.com",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com",
  "htumeng.com"
];

const BUILTIN_MEDIA_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "niter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com",
  "redd.it",
  "770118.xyz",
  "phe69.com",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com",
  "htumeng.com"
];

const KV_RSS_KEY = "proxy_rss_user";
const KV_MEDIA_KEY = "proxy_media_user";

function normalizeHost(raw) {
  let h = String(raw || "").trim().toLowerCase().replace(/\.+$/, "");
  h = h.replace(/^www\./, "");
  return h;
}

function dedupe(arr) {
  return [...new Set(arr.map(normalizeHost).filter(Boolean))];
}

function corsHeaders(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "*",
    ...extra
  };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: corsHeaders({ "Content-Type": "application/json;charset=utf-8" })
  });
}

// 把“生效名单”整理成 UI 友好的结构：内置项标 builtin:true（只读）
function mergedConfig(rssUser, mediaUser) {
  const rss = dedupe([...BUILTIN_RSS_HOSTS, ...rssUser]);
  const media = dedupe([...BUILTIN_MEDIA_HOSTS, ...mediaUser]);
  return {
    rss: rss.map(h => ({ host: h, builtin: BUILTIN_RSS_HOSTS.includes(h) })),
    media: media.map(h => ({ host: h, builtin: BUILTIN_MEDIA_HOSTS.includes(h) }))
  };
}

async function getUserList(kv, key) {
  if (!kv) return [];
  try {
    const v = await kv.get(key);
    if (!v) return [];
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.map(normalizeHost).filter(Boolean) : [];
  } catch (e) {
    return [];
  }
}

async function setUserList(kv, key, arr) {
  if (!kv) return false;
  try {
    // 不设 expirationTtl，配置长期有效
    await kv.put(key, JSON.stringify(dedupe(arr)));
    return true;
  } catch (e) {
    return false;
  }
}

function checkToken(request, env) {
  const envToken = env && env.PROXY_ADMIN_TOKEN;
  if (!envToken) {
    return { ok: false, msg: "服务端未配置 PROXY_ADMIN_TOKEN 环境变量，无法写入。请先在 Cloudflare Pages 的 Functions 环境变量中设置该变量（与界面里输入的令牌一致）。" };
  }
  const header = request.headers.get("X-Proxy-Token");
  const urlToken = new URL(request.url).searchParams.get("token");
  const provided = (header || urlToken || "").trim();
  if (!provided || provided !== envToken) {
    return { ok: false, msg: "管理令牌不正确，写入被拒绝" };
  }
  return { ok: true };
}

export async function onRequest({ request, env }) {
  const kv = env && env.RSS_CACHE;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  try {
    if (request.method === "GET") {
      const rssUser = await getUserList(kv, KV_RSS_KEY);
      const mediaUser = await getUserList(kv, KV_MEDIA_KEY);
      return json(mergedConfig(rssUser, mediaUser));
    }

    if (request.method === "POST") {
      const auth = checkToken(request, env);
      if (!auth.ok) return json({ error: auth.msg }, 403);

      let body;
      try {
        body = await request.json();
      } catch (e) {
        return json({ error: "无效的 JSON 请求体" }, 400);
      }

      const type = body.type === "media" ? "media" : "rss";
      const key = type === "media" ? KV_MEDIA_KEY : KV_RSS_KEY;
      const action = body.action;
      const host = normalizeHost(body.host);

      if (!host) return json({ error: "域名无效" }, 400);

      const builtins = type === "media" ? BUILTIN_MEDIA_HOSTS : BUILTIN_RSS_HOSTS;
      if (action === "remove" && builtins.includes(host)) {
        return json({ error: "内置默认域名不可删除" }, 400);
      }

      let list = await getUserList(kv, key);
      if (action === "add") {
        if (!list.includes(host)) list.push(host);
      } else if (action === "remove") {
        list = list.filter(h => h !== host);
      } else {
        return json({ error: "action 必须是 add 或 remove" }, 400);
      }

      const ok = await setUserList(kv, key, list);
      if (!ok) return json({ error: "KV 未绑定或写入失败" }, 500);

      const rssUser = await getUserList(kv, KV_RSS_KEY);
      const mediaUser = await getUserList(kv, KV_MEDIA_KEY);
      return json(mergedConfig(rssUser, mediaUser));
    }

    return json({ error: "不支持的方法" }, 405);
  } catch (e) {
    return json({ error: String(e && e.message ? e.message : e) }, 500);
  }
}
