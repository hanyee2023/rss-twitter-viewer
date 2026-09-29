// ===== log.js (运行日志) =====
// 记录当天运行情况：今日更新（本次更新/累计更新/已读/未读/屏蔽/隐藏）+ 前后台错误。
// 数据存于 localStorage（key: rsslog:YYYY-MM-DD），**只保留当天一份**：
// 每天跨入新的一天（00:00 起）旧报告自动删除，页面直接展示今日内容，无列表/弹窗。
(function () {
  "use strict";

  const PREFIX = "rsslog:";
  const APP_DOMAIN = "https://rss-twitter-viewer.pages.dev";

  function pad(n) { return String(n).padStart(2, "0"); }
  function dateStrOf(d) {
    d = d || new Date();
    return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  }
  function timeStrOf(d) {
    d = d || new Date();
    return pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
  }
  function todayKey(d) { return PREFIX + dateStrOf(d); }

  function readReport(key) {
    try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; }
    catch (e) { return null; }
  }
  function writeReport(key, obj) {
    try { localStorage.setItem(key, JSON.stringify(obj)); } catch (e) { /* 配额满则忽略 */ }
  }
  function ensureToday() {
    const key = todayKey();
    let r = readReport(key);
    if (!r) {
      r = { date: dateStrOf(), createdAt: Date.now(), updates: [], errors: [] };
      writeReport(key, r);
    }
    return r;
  }

  // 统计“本次刷新失败源”数量（由 feed.js 的 loadAllRSS 累加，刷新结束时取走并清零）
  let _failCount = 0;
  function markFail() { _failCount++; }
  function getAndResetFail() { const v = _failCount; _failCount = 0; return v; }

  function recordUpdate(snap) {
    try {
      const r = ensureToday();
      r.updates.push({
        time: timeStrOf(),
        ts: Date.now(),
        itemCount: snap.itemCount || 0,
        readCount: snap.readCount || 0,
        unreadCount: snap.unreadCount || 0,
        failCount: snap.failCount || 0,
        blockedCount: snap.blockedCount || 0,
        hiddenCount: snap.hiddenCount || 0,
        // 本地实际写入条数（容量不足触发降档时 < itemCount）
        savedCount: snap.savedCount || 0,
        source: snap.source || ""
      });
      writeReport(todayKey(), r);
    } catch (e) { /* ignore */ }
  }
  // —— 跨域脚本错误（浏览器把详情抹成 "Script error."）的处理 ——
  // 这类错误的 message 不含文件名/行号，无法直接定位。页面里唯一的跨域脚本是 hls.js，且已加
  // crossorigin（跨域脚本一旦带 CORS 属性，其内部异常就不再被浏览器遮蔽）。所以若日志里仍出现
  // 被遮蔽的 Script error.，且 hls.js 已正常加载，即可判定抛错方是页面之外的脚本
  // （浏览器扩展 / 国产浏览器注入 / 运营商注入），与本应用无关。
  // 既然它与本应用无关、也不影响任何功能，就**直接丢弃不入库**，避免污染日志。
  // 仅当 hls.js 本次未加载时保留（那种情况确有依赖缺失，值得留意），并按当天同文案折叠计数。
  function isScriptErrorText(s) { return s.indexOf("Script error.") === 0; }
  function isHlsLoaded() { return (typeof window.Hls !== "undefined" && !!window.Hls); }
  function normalizeScriptError() {
    return "Script error.（跨域脚本抛错，浏览器已隐藏详情；本应用 hls.js " +
      (isHlsLoaded() ? "已正常加载，故非本应用所致" : "本次未加载，请先确认是否有「依赖加载失败」记录") + "）";
  }

  function recordError(msg, where) {
    try {
      const raw = String(msg == null ? "" : msg);
      const isScriptErr = isScriptErrorText(raw);
      // 判定为「外部脚本噪音」→ 不记录（详见上方注释）
      if (isScriptErr && isHlsLoaded()) return;
      const text = isScriptErr ? normalizeScriptError() : raw;
      const r = ensureToday();
      if (isScriptErr) {
        // 当天已有同文案 → 只累加次数，不再新增条目
        for (let i = 0; i < r.errors.length; i++) {
          const e = r.errors[i];
          if (!e || !e.msg) continue;
          if (e.msg === text || e.msg.indexOf(text + "（当日") === 0) {
            const mm = /（当日第 (\d+) 次）$/.exec(e.msg);
            const n = mm ? (parseInt(mm[1], 10) + 1) : 2;
            e.msg = text + "（当日第 " + n + " 次）";
            e.lastTime = timeStrOf();
            e.lastTs = Date.now();
            writeReport(todayKey(), r);
            return;
          }
        }
      }
      r.errors.push({
        time: timeStrOf(),
        ts: Date.now(),
        msg: text,
        where: where || ""
      });
      writeReport(todayKey(), r);
    } catch (e) { /* ignore */ }
  }

  function listReports() {
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) {
        const r = readReport(k);
        if (r) out.push({ key: k, date: r.date, updates: r.updates || [], errors: r.errors || [] });
      }
    }
    out.sort((a, b) => (b.date < a.date ? -1 : b.date > a.date ? 1 : 0));
    return out;
  }
  function deleteReport(key) { try { localStorage.removeItem(key); } catch (e) {} }
  function deleteAll() {
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) ks.push(k);
    }
    ks.forEach((k) => localStorage.removeItem(k));
  }
  // 5.1：日志只保留当天一份。每天 00:00 起旧报告自动清除 ——
  // 实现方式：初始化时 + 跨天检测触发时，把除今天以外的所有 rsslog:* 键全部删除。
  // （App 没开着跨天也没关系：下次打开页面初始化时同样会清掉。）
  function purgeOldReports() {
    const today = todayKey();
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0 && k !== today) ks.push(k);
    }
    ks.forEach((k) => { try { localStorage.removeItem(k); } catch (e) {} });
  }

  // 自动生成：初始化 + 每分钟检测跨天（实现“每日00:00起自动开新报告并删除旧报告”）
  ensureToday();
  purgeOldReports();
  let _lastDate = dateStrOf();
  setInterval(function () {
    const d = dateStrOf();
    if (d !== _lastDate) { _lastDate = d; ensureToday(); purgeOldReports(); if (window.AppLog) AppLog.onNewDay(); }
  }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) { ensureToday(); purgeOldReports(); } });

  // ---------- UI ----------
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- 本地存储读数（5.0）----------
  // 目的：一眼看出「条目数变少」是**源本身没给够**，还是**本地配额被砍（降档）**。
  //   · 已存 N 条  = localStorage 里 rss_article_cache 的真实条数（可能是降档后的结果）
  //   · 来源缓存   = 各订阅源回退缓存的合计条数（另一份副本，与文章缓存共享 5MB 配额）
  //   · 本站占用   = 本域名下所有 localStorage 键（UTF-16 计费，1 字符 = 2 字节）的总和
  //   · 已用 / 上限 = 本域名全部键 vs localStorage 硬上限（约 5MB，见下方常量）
  //
  // 【为何不再显示 navigator.storage.estimate().quota】它返回的是**大容量存储层**
  //（IndexedDB / Cache / OPFS）的配额，按磁盘总容量折算（动辄上百 GB，Chrome 133+ 起甚至返回
  // "usage + 10GiB" 这类公式化假值），与 localStorage 毫无关系；显示出来只会让人误以为
  // 「还能存 142 GB」。localStorage 本层上限恒为约 5MB/origin，写满照样抛 QuotaExceededError、
  // 照常触发降档。故 5.0 起移除该项读数。
  const LOCAL_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024; // 保守口径：按 UTF-16 字节计（若浏览器按 code unit 计，则可存约两倍）
  function fmtMB(bytes) {
    if (!bytes && bytes !== 0) return "—";
    const mb = bytes / 1024 / 1024;
    return mb >= 1 ? (mb.toFixed(1) + " MB") : (Math.round(bytes / 1024) + " KB");
  }

  function measureStorage() {
    const out = { articleCount: 0, articleBytes: 0, rssFeedCount: 0, rssItemCount: 0, appBytes: 0, allBytes: 0 };
    try {
      const raw = localStorage.getItem("rss_article_cache") || "[]";
      out.articleBytes = raw.length * 2;
      try {
        const arr = JSON.parse(raw);
        out.articleCount = Array.isArray(arr) ? arr.length : 0;
      } catch (e) { out.articleCount = 0; }
    } catch (e) { /* ignore */ }
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const v = localStorage.getItem(k) || "";
        const bytes = (k.length + v.length) * 2;
        out.allBytes += bytes;
        if (k.indexOf("rss_cache_") === 0) {
          out.rssFeedCount++;
          try {
            const data = JSON.parse(v);
            out.rssItemCount += (data && Array.isArray(data.items)) ? data.items.length : 0;
          } catch (e) { /* ignore */ }
        }
      }
      // 本应用自身的键：rss_* / rsslog:* / local_rss_*（含日志报告）
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        if (/^(rss_|rsslog:|local_rss_)/.test(k)) {
          out.appBytes += (k.length + (localStorage.getItem(k) || "").length) * 2;
        }
      }
    } catch (e) { /* ignore */ }
    return out;
  }

  function renderStorageBar() {
    const box = el("logStorage");
    if (!box) return;
    const m = measureStorage();
    // 文章缓存是否被降档：与全局上限对比（ARTICLE_CACHE_LIMIT 定义在 core.js，同页共享）
    const limit = (typeof ARTICLE_CACHE_LIMIT !== "undefined") ? ARTICLE_CACHE_LIMIT : 1000;
    let ratioNote = "";
    if (m.articleCount > 0 && m.articleCount < limit) {
      ratioNote = ' <span class="ls-warn">（低于上限 ' + limit + '，可能已被配额降档）</span>';
    }
    // 本层真实占用率：分母是 localStorage 硬上限（约 5MB），**不是** estimate() 给出的大配额
    const pct = Math.round(m.allBytes / LOCAL_STORAGE_BUDGET_BYTES * 100);
    let pctCls = "ls-ok", pctTip = "";
    if (pct >= 90) {
      pctCls = "ls-warn";
      pctTip = ' <span class="ls-warn">（已接近上限，建议先点「删除报告」腾空间）</span>';
    } else if (pct >= 70) {
      pctCls = "ls-amber";
      pctTip = ' <span class="ls-amber">（占用偏高）</span>';
    }
    box.innerHTML =
      '<div class="ls-line">文章缓存（多源合并去重后）<b>' + m.articleCount + '</b> 条 / ' + fmtMB(m.articleBytes) + ratioNote + '</div>' +
      '<div class="ls-line ls-sub">来源缓存 ' + m.rssFeedCount + ' 个源 ｜ 合计 ' + m.rssItemCount + ' 条（各源原始副本，仅供断网回退，与上行不是同一份数据）</div>' +
      '<div class="ls-line ls-sub">本地存储已用 <span class="' + pctCls + '">' + fmtMB(m.allBytes) + ' / 上限约 5 MB（' + pct + '%）</span>' + pctTip + '</div>' +
      '<div class="ls-line ls-sub">本站占用 ' + fmtMB(m.appBytes) + ' ｜ 本域名全部键 ' + fmtMB(m.allBytes) + '</div>';
  }

  // 5.1：取消列表 + 详情弹窗，改为在日志页直接展示今日报告。
  // 函数名保留 renderList（feed.js 切页时调用它），行为变为渲染当天内容。
  function renderList() {
    const box = el("logList");
    if (!box) return;
    renderStorageBar();
    const r = ensureToday();
    const updates = r.updates || [];
    const errors = r.errors || [];

    // 一、今日更新：本次更新 / 累计更新 / 已读 / 未读 / 屏蔽 / 隐藏
    let uHtml;
    if (!updates.length) {
      uHtml = '<div class="log-empty">（今日暂无更新记录，刷新主页后自动生成）</div>';
    } else {
      const last = updates[updates.length - 1];
      uHtml =
        '<div class="ld-stats today-stats">本次更新 <b>' + last.itemCount + '</b> 条（[' + escapeHtml(last.time) + ']' +
        (last.source ? (" " + escapeHtml(last.source)) : "") + '）' +
        ' ｜ 累计更新 ' + updates.length + ' 次' +
        ' ｜ 已读 <b>' + last.readCount + '</b>' +
        ' ｜ 未读 <b>' + last.unreadCount + '</b>' +
        ' ｜ 屏蔽 ' + (last.blockedCount || 0) +
        ' ｜ 隐藏 ' + (last.hiddenCount || 0) +
        ((last.savedCount && last.savedCount < last.itemCount)
          ? ' ｜ <span class="ls-warn">本地存 ' + last.savedCount + '（已被配额降档）</span>'
          : '') +
        '</div>';
    }

    // 二、错误记录
    let eHtml = "";
    if (!errors.length) {
      eHtml = '<div class="log-empty">（无错误记录）</div>';
    } else {
      errors.forEach(function (er, i) {
        eHtml +=
          '<div class="log-detail-row"><span class="ld-idx">' + (i + 1) + '</span>' +
          '<div class="ld-body">' +
          '<div class="ld-time">' + escapeHtml(er.time) + (er.where ? (" · " + escapeHtml(er.where)) : "") + '</div>' +
          '<div class="ld-msg">' + escapeHtml(er.msg) + '</div>' +
          '</div></div>';
      });
    }

    box.innerHTML =
      '<div class="log-today-box">' +
      '<div class="log-detail-sec-title">一、今日更新</div>' + uHtml +
      '<div class="log-detail-sec-title">二、错误记录（前台 / 后台）</div>' +
      '<div class="log-detail-list">' + eHtml + '</div>' +
      '</div>';
  }

  function buildReportText(r) {
    const lines = [];
    lines.push("运行日志报告 " + r.date);
    lines.push("================================");
    lines.push("一、今日更新");
    const updates = r.updates || [];
    if (!updates.length) {
      lines.push("（今日暂无更新记录）");
    } else {
      const last = updates[updates.length - 1];
      lines.push(
        "本次更新 " + last.itemCount + " 条（[" + last.time + "]" + (last.source ? (" " + last.source) : "") + "）" +
        " / 累计更新 " + updates.length + " 次" +
        " / 已读 " + last.readCount +
        " / 未读 " + last.unreadCount +
        " / 屏蔽 " + (last.blockedCount || 0) +
        " / 隐藏 " + (last.hiddenCount || 0) +
        ((last.savedCount && last.savedCount < last.itemCount) ? (" / 本地存 " + last.savedCount + "（已被配额降档）") : "")
      );
    }
    lines.push("");
    lines.push("二、错误记录（前台 / 后台）");
    const errors = r.errors || [];
    if (!errors.length) {
      lines.push("（无错误记录）");
    } else {
      errors.forEach(function (er, i) {
        lines.push((i + 1) + ". [" + er.time + "]" + (er.where ? (" [" + er.where + "]") : "") + " " + er.msg);
      });
    }
    return lines.join("\n");
  }

  function copyText(text, cb) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { cb(true); },
        function () { fallbackCopy(text, cb); }
      );
    } else {
      fallbackCopy(text, cb);
    }
  }
  function fallbackCopy(text, cb) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      cb(ok);
    } catch (e) { cb(false); }
  }

  function showLogToast(msg) {
    let t = el("logToast");
    if (!t) {
      t = document.createElement("div");
      t.id = "logToast";
      t.className = "tip-toast";
      document.body.appendChild(t);
    }
    t.innerText = msg;
    t.style.display = "block";
    setTimeout(function () { t.style.display = "none"; }, 1500);
  }

  function exportToday() {
    const r = ensureToday();
    const data = { app: "rss-twitter-viewer", version: "5.1", exportedAt: new Date().toISOString(), report: r };
    const jsonStr = JSON.stringify(data, null, 2);
    const fname = "运行日志_" + r.date + ".json";
    try {
      const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
      const a = document.createElement("a");
      a.href = "data:application/json;base64," + base64;
      a.download = fname;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    showLogToast("已导出今日报告");
  }

  function deleteTodayReport() {
    if (!confirm("确定删除今日报告？删除后将从零重新累计。")) return;
    deleteReport(todayKey());
    renderList();
    showLogToast("已删除今日报告");
  }

  function copyTodayReport() {
    const r = ensureToday();
    copyText(buildReportText(r), function (ok) {
      showLogToast(ok ? "已复制今日报告" : "复制失败，请手动选择");
    });
  }

  // 工具栏按钮（index.html 中已存在）：删除报告 / 复制报告 / 导出报告
  const dBtn = el("logDeleteBtn");
  if (dBtn) dBtn.onclick = deleteTodayReport;
  const cBtn = el("logCopyBtn");
  if (cBtn) cBtn.onclick = copyTodayReport;
  const exp = el("logExportBtn");
  if (exp) exp.onclick = exportToday;

  // 暴露 API 给其它脚本（feed.js / app.js / media.js 在运行时调用）
  window.AppLog = {
    recordUpdate: recordUpdate,
    recordError: recordError,
    markFail: markFail,
    getAndResetFail: getAndResetFail,
    renderList: renderList,
    renderStorage: renderStorageBar,
    measureStorage: measureStorage,
    exportToday: exportToday,
    deleteTodayReport: deleteTodayReport,
    onNewDay: function () { renderList(); }
  };

  // ---------- 错误入库（5.0）----------
  // 正常情况下由 index.html <head> 的「早期错误收集器」统一分发：
  // 它在所有脚本之前就注册了监听，因此还能覆盖 log.js 加载前发生的错误
  //（例如 hls.js 加载失败、core/media/feed/app 的顶层异常）。
  // 若该收集器不存在（例如仍搭配旧版 index.html），则退化为自行注册监听，
  // 功能不受影响 —— 只是拿不到「启动期」的错误。
  function handleCapturedError(rec) {
    if (!rec || !rec.msg) return;
    recordError(rec.msg, rec.where || "前台");
  }

  function installErrorCapture() {
    if (typeof window.__setErrorSink === "function") {
      // 接管后续错误，并回灌 log.js 加载前暂存的记录
      window.__setErrorSink(handleCapturedError);
      return;
    }
    window.addEventListener("error", function (ev) {
      let msg = (ev && ev.message) ? ev.message : "未知错误";
      // 跨域脚本抛错时浏览器只给无信息的 "Script error."（无文件名/行号）：
      // 保持原样交给 recordError 统一归一化（补「来源判定」文案 + 按天折叠计数），此处不再重复标注。
      if (msg.indexOf("Script error.") !== 0 && ev && ev.lineno) msg += " (行" + ev.lineno + ")";
      const where = (ev && ev.filename) ? ("前台 " + (String(ev.filename).split("/").pop() || "")) : "前台";
      recordError(msg, where);
    });
    window.addEventListener("unhandledrejection", function (ev) {
      let msg = "未处理的异步异常";
      try { msg = (ev && ev.reason && (ev.reason.message || ev.reason)) || msg; } catch (e) {}
      recordError("未处理异常: " + msg, "前台");
    });
  }

  // 必须最后调用：此时 ensureToday() 已执行，回灌的记录才有报告可写入
  installErrorCapture();
})();
