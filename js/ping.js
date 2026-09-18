// 右上角实时延迟面板：周期性请求代理 ping 接口，更新“本机/代理”两段延迟。
// 本机 = 你(浏览器) → 代理(CF边缘) 的 RTT；代理 = 代理 → 推特源站(twimg) 的 RTT。
// 仅做被动展示，失败/取不到时保持 “--”，不打扰用户。
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

  function paint(el, ms) {
    if (el === null) return;
    if (ms === null || ms === undefined || !Number.isFinite(ms)) {
      el.textContent = "--";
      el.className = "lat-na";
      return;
    }
    el.textContent = Math.round(ms) + "ms";
    el.className = ms < 150 ? "lat-ok" : (ms < 400 ? "lat-warn" : "lat-bad");
  }

  async function tick() {
    const base = getProxyBase();
    const elClient = document.getElementById("latClient");
    const elProxy = document.getElementById("latProxy");
    if (!base || !elClient || !elProxy) return;

    const sep = base.indexOf("?") >= 0 ? "&" : "?";
    const url = base + sep + "ping=1";
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { method: "GET", signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!res.ok) throw new Error("ping http " + res.status);
      const data = await res.json();
      paint(elClient, data.clientRtt);
      paint(elProxy, data.upstreamRtt);
    } catch (e) {
      clearTimeout(timer);
      // 取不到不强制改写已有值，避免面板乱跳；仅在仍是初始态时标 N/A 提示
      // （保持 -- 即可，无需抛错）
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
