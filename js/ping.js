// 右上角实时速率面板：周期请求代理 ping 接口，显示 Cloudflare 实测的代理下载速率(MB/s)。
// 速率由代理在实际转发视频流时测量并返回（见 media-proxy.js 的 streamWithSpeed），
// 反映“代理水管粗细”，比本地用 buffered 计算的更准（不会在缓冲满时掉到 0）。
// 仅被动展示，取不到时保持 “--”，不打扰用户。
(function () {
  "use strict";

  const PING_INTERVAL = 8000;   // 轮询间隔(ms)
  const FETCH_TIMEOUT = 6000;   // 单次 ping 超时(ms)

  function getProxyBase() {
    try {
      if (typeof MEDIA_PROXY_ENDPOINTS !== "undefined" && MEDIA_PROXY_ENDPOINTS.length) {
        return MEDIA_PROXY_ENDPOINTS[0];
      }
    } catch (e) { /* ignore */ }
    return null;
  }

  function paint(el, mbps) {
    if (!el) return;
    if (mbps === null || mbps === undefined || !Number.isFinite(mbps)) {
      el.textContent = "--";
      el.className = "lat-na";
      return;
    }
    // 720p 视频自身码率约 0.3~0.8 MB/s；据此分级，仅供参考
    el.textContent = mbps.toFixed(1) + " MB/s";
    el.className = mbps >= 0.5 ? "lat-ok" : (mbps >= 0.15 ? "lat-warn" : "lat-bad");
  }

  async function tick() {
    const base = getProxyBase();
    const el = document.getElementById("latSpeed");
    if (!base || !el) return;

    const sep = base.indexOf("?") >= 0 ? "&" : "?";
    const url = base + sep + "ping=1";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error("ping http " + res.status);
      const data = await res.json();
      paint(el, (typeof data.speedMbps === "number") ? data.speedMbps : null);
    } catch (e) {
      clearTimeout(timer);
      // 取不到保持 --，不强制改写、不打扰
    }
  }

  function start() {
    tick();
    setInterval(tick, PING_INTERVAL);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
