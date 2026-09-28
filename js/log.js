// ===== log.js (运行日志) =====
// 记录每日运行报告：今日更新（时间点/条目/已读/未读/失败）+ 前后台错误。
// 数据存于 localStorage，每天一份（key: rsslog:YYYY-MM-DD），跨天自动开启新报告。
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
  function recordError(msg, where) {
    try {
      const r = ensureToday();
      r.errors.push({
        time: timeStrOf(),
        ts: Date.now(),
        msg: String(msg == null ? "" : msg),
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

  // 自动生成：初始化 + 每分钟检测跨天（实现“每日00:00起自动开新报告”）
  ensureToday();
  let _lastDate = dateStrOf();
  setInterval(function () {
    const d = dateStrOf();
    if (d !== _lastDate) { _lastDate = d; ensureToday(); if (window.AppLog) AppLog.onNewDay(); }
  }, 60000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) ensureToday(); });

  // ---------- UI ----------
  function el(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ---------- 本地存储读数（5.0.1）----------
  // 目的：一眼看出「条目数变少」是**源本身没给够**，还是**本地配额被砍（降档）**。
  //   · 已存 N 条  = localStorage 里 rss_article_cache 的真实条数（可能是降档后的结果）
  //   · 来源缓存   = 各订阅源回退缓存的合计条数（另一份副本，与文章缓存共享 5MB 配额）
  //   · 本站占用   = 本域名下所有 localStorage 键（UTF-16 计费，1 字符 = 2 字节）的总和
  //   · 已用 / 上限 = 本域名全部键 vs localStorage 硬上限（约 5MB，见下方常量）
  //
  // 【重要】navigator.storage.estimate() 给出的 quota 是**大容量存储层**（IndexedDB / Cache /
  // OPFS）的配额，按磁盘总容量折算（Chrome 通行为总盘约 60%，Chrome 133+ 起甚至会返回
  // "usage + 10GiB" 这样的公式化假值）。它与 localStorage 毫无关系，**不能当作 localStorage
  // 的上限**：本层上限恒为约 5MB/origin，写满照样会抛 QuotaExceededError、触发降档。
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
    const limit = (typeof ARTICLE_CACHE_LIMIT !== "undefined") ? ARTICLE_CACHE_LIMIT : 1500;
    let ratioNote = "";
    if (m.articleCount > 0 && m.articleCount < limit) {
      ratioNote = ' <span class="ls-warn">（低于上限 ' + limit + '，可能已被配额降档）</span>';
    }
    // 本层真实占用率：分母是 localStorage 硬上限（约 5MB），**不是** estimate() 给出的大配额
    const pct = Math.round(m.allBytes / LOCAL_STORAGE_BUDGET_BYTES * 100);
    let pctCls = "ls-ok", pctTip = "";
    if (pct >= 90) {
      pctCls = "ls-warn";
      pctTip = ' <span class="ls-warn">（已接近上限，建议先「一键删除全部报告」腾空间）</span>';
    } else if (pct >= 70) {
      pctCls = "ls-amber";
      pctTip = ' <span class="ls-amber">（占用偏高）</span>';
    }
    box.innerHTML =
      '<div class="ls-line">本地已存 <b>' + m.articleCount + '</b> 条 / ' + fmtMB(m.articleBytes) + ratioNote + '</div>' +
      '<div class="ls-line ls-sub">来源缓存 ' + m.rssFeedCount + ' 个源 ｜ 合计 ' + m.rssItemCount + ' 条</div>' +
      '<div class="ls-line ls-sub">本地存储已用 <span class="' + pctCls + '">' + fmtMB(m.allBytes) + ' / 上限约 5 MB（' + pct + '%）</span>' + pctTip + '</div>' +
      '<div class="ls-line ls-sub">本站占用 ' + fmtMB(m.appBytes) + ' ｜ 本域名全部键 ' + fmtMB(m.allBytes) + ' ｜ 大容量配额 <span id="logQuotaText">—</span>（IndexedDB 用，与本层无关）</div>';
    // 大容量配额：异步取、仅供对照，与上面那条 5MB 上限无关
    const setBig = function (txt) {
      const t = el("logQuotaText");
      if (t) t.textContent = txt;
    };
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (est) {
        setBig((est && est.quota) ? fmtMB(est.quota) : "不可用");
      }, function () { setBig("不可用"); });
    } else {
      setBig("不可用");
    }
  }

  function renderList() {
    const box = el("logList");
    if (!box) return;
    renderStorageBar();
    const reports = listReports();
    if (reports.length === 0) {
      box.innerHTML = '<div class="empty-tip">暂无日志报告</div>';
      return;
    }
    let html = "";
    reports.forEach(function (r, idx) {
      const u = r.updates.length, e = r.errors.length;
      const summary = "更新 " + u + " 次 ｜ 错误 " + e + " 条";
      html +=
        '<div class="log-item" data-key="' + r.key + '">' +
        '<div class="log-idx">' + (idx + 1) + '</div>' +
        '<div class="log-meta">' +
        '<div class="log-date">' + escapeHtml(r.date) + '</div>' +
        '<div class="log-summary">' + summary + '</div>' +
        '</div>' +
        '<div class="log-arrow">›</div>' +
        '</div>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll(".log-item"), function (item) {
      item.onclick = function () { openDetail(item.getAttribute("data-key")); };
    });
  }

  function buildReportText(r) {
    const lines = [];
    lines.push("运行日志报告 " + r.date + "（00:01 - 23:59）");
    lines.push("================================");
    lines.push("一、今日更新");
    if (!r.updates.length) {
      lines.push("（无更新记录）");
    } else {
      r.updates.forEach(function (u, i) {
        lines.push(
          (i + 1) + ". [" + u.time + "] 条目 " + u.itemCount +
          " / 已读 " + u.readCount + " / 未读 " + u.unreadCount +
          " / 加载失败 " + u.failCount +
          " / 屏蔽 " + (u.blockedCount || 0) + " / 隐藏 " + (u.hiddenCount || 0) +
          " / 本地存 " + (u.savedCount || 0) +
          (u.source ? (" / 来源:" + u.source) : "")
        );
      });
    }
    lines.push("");
    lines.push("二、错误记录（前台 / 后台）");
    if (!r.errors.length) {
      lines.push("（无错误记录）");
    } else {
      r.errors.forEach(function (er, i) {
        lines.push((i + 1) + ". [" + er.time + "]" + (er.where ? (" [" + er.where + "]") : "") + " " + er.msg);
      });
    }
    return lines.join("\n");
  }

  function openDetail(key) {
    const r = readReport(key);
    if (!r) return;
    let mask = el("logDetailModal");
    if (!mask) {
      mask = document.createElement("div");
      mask.id = "logDetailModal";
      mask.className = "modal-mask";
      document.body.appendChild(mask);
    }

    let uHtml = "";
    if (!r.updates.length) {
      uHtml = '<div class="log-empty">（无更新记录）</div>';
    } else {
      r.updates.forEach(function (u, i) {
        uHtml +=
          '<div class="log-detail-row"><span class="ld-idx">' + (i + 1) + '</span>' +
          '<div class="ld-body">' +
          '<div class="ld-time">' + escapeHtml(u.time) + (u.source ? (" · " + escapeHtml(u.source)) : "") + '</div>' +
          '<div class="ld-stats">条目 ' + u.itemCount + ' ｜ 已读 ' + u.readCount +
          ' ｜ 未读 ' + u.unreadCount + ' ｜ 失败 ' + u.failCount +
          ' ｜ 屏蔽 ' + (u.blockedCount || 0) + ' ｜ 隐藏 ' + (u.hiddenCount || 0) +
          ' ｜ 本地存 ' + (u.savedCount || 0) + '</div>' +
          '</div></div>';
      });
    }
    let eHtml = "";
    if (!r.errors.length) {
      eHtml = '<div class="log-empty">（无错误记录）</div>';
    } else {
      r.errors.forEach(function (er, i) {
        eHtml +=
          '<div class="log-detail-row"><span class="ld-idx">' + (i + 1) + '</span>' +
          '<div class="ld-body">' +
          '<div class="ld-time">' + escapeHtml(er.time) + (er.where ? (" · " + escapeHtml(er.where)) : "") + '</div>' +
          '<div class="ld-msg">' + escapeHtml(er.msg) + '</div>' +
          '</div></div>';
      });
    }

    mask.innerHTML =
      '<div class="modal-box log-detail-box">' +
      '<div class="log-detail-head"><span>运行日志 · ' + escapeHtml(r.date) + '</span>' +
      '<button class="log-close" id="logDetailClose">×</button></div>' +
      '<div class="log-detail-sec-title">一、今日更新</div>' +
      '<div class="log-detail-list">' + uHtml + '</div>' +
      '<div class="log-detail-sec-title">二、错误记录（前台 / 后台）</div>' +
      '<div class="log-detail-list">' + eHtml + '</div>' +
      '<div class="log-detail-actions">' +
      '<button id="logCopyBtn" class="log-act-btn">复制报告</button>' +
      '<button id="logDeleteBtn" class="log-act-btn log-del">删除本条</button>' +
      '</div>' +
      '</div>';

    mask.style.display = "flex";
    el("logDetailClose").onclick = function () { mask.style.display = "none"; };
    mask.onclick = function (e) { if (e.target === mask) mask.style.display = "none"; };
    el("logCopyBtn").onclick = function () {
      copyText(buildReportText(r), function (ok) {
        showLogToast(ok ? "已复制报告内容" : "复制失败，请手动选择");
      });
    };
    el("logDeleteBtn").onclick = function () {
      deleteReport(key);
      mask.style.display = "none";
      renderList();
    };
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

  function exportAll() {
    const reports = listReports();
    const data = { app: "rss-twitter-viewer", version: "5.0", exportedAt: new Date().toISOString(), reports: reports };
    const jsonStr = JSON.stringify(data, null, 2);
    try {
      const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "运行日志备份.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
      const a = document.createElement("a");
      a.href = "data:application/json;base64," + base64;
      a.download = "运行日志备份.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    showLogToast("已导出 " + reports.length + " 份日志");
  }

  function deleteAllReports() {
    if (!confirm("确定删除全部日志报告？此操作不可恢复。")) return;
    deleteAll();
    renderList();
    showLogToast("已删除全部日志");
  }

  // 工具栏按钮（index.html 中已存在）
  const dAll = el("logDeleteAllBtn");
  if (dAll) dAll.onclick = deleteAllReports;
  const exp = el("logExportBtn");
  if (exp) exp.onclick = exportAll;

  // 暴露 API 给其它脚本（feed.js / app.js / media.js 在运行时调用）
  window.AppLog = {
    recordUpdate: recordUpdate,
    recordError: recordError,
    markFail: markFail,
    getAndResetFail: getAndResetFail,
    renderList: renderList,
    renderStorage: renderStorageBar,
    measureStorage: measureStorage,
    exportAll: exportAll,
    deleteAllReports: deleteAllReports,
    onNewDay: function () { renderList(); }
  };

  // ---------- 错误入库（5.0.1）----------
  // 正常情况下由 index.html <head> 的「早期错误收集器」统一分发：
  // 它在所有脚本之前就注册了监听，因此还能覆盖 log.js 加载前发生的错误
  //（例如 hls.js 的 CDN 加载失败、core/media/feed/app 的顶层异常）。
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
      if (ev && ev.lineno) msg += " (行" + ev.lineno + ")";
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
