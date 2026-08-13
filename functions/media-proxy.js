const ALLOW_PROXY_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "nitter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com", 
  "redd.it",
  "770118.xyz",
  "phe69",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com"
      return new Response(processed, {
        status: res.status,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
          "Cache-Control": "no-store"
        })
      });
    }

const ALLOW_PROXY_HOSTS = [
  "twitter.com",
  "x.com",
  "t.co",
  "twimg.com",
  "video.twimg.com",
  "pbs.twimg.com",
  "abs.twimg.com",
  "xcancel.com",
  "nitter.net",
  "16k.club",
  "xxxfollow.com",
  "media.redgifs.com", 
  "redd.it",
  "770118.xyz",
  "phe69.com",
  "3go.fun",
  "rsshub.app",
  "venexa.site",
  "aguea.com"
      return new Response(processed, {
        status: res.status,
        headers: corsHeaders({
          "Content-Type": "application/vnd.apple.mpegurl;charset=utf-8",
          // 点播 m3u8 的播放列表内容基本不变，做短 TTL 边缘缓存。
          // 原先 no-store 会让 HLS.js 每次刷新播放列表都回源，分片频繁回源造成卡顿。
          // 30s 足够覆盖播放过程中的周期性播放列表请求，又不会明显滞后于源站更新（Twitter 视频为点播，播放列表静态）。
          "Cache-Control": "public, s-maxage=30"
        })
      });
    }
