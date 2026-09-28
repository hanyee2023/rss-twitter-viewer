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

  function renderList() {
    const box = el("logList");
    if (!box) return;
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
          ' ｜ 屏蔽 ' + (u.blockedCount || 0) + ' ｜ 隐藏 ' + (u.hiddenCount || 0) + '</div>' +
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
    exportAll: exportAll,
    deleteAllReports: deleteAllReports,
    onNewDay: function () { renderList(); }
  };

  // 前台（页面）未捕获错误自动入库
  window.addEventListener("error", function (ev) {
    let msg = (ev && ev.message) ? ev.message : "未知错误";
    const where = (ev && ev.filename) ? ("前台 " + (String(ev.filename).split("/").pop() || "")) : "前台";
    recordError(msg + (ev && ev.lineno ? (" (行" + ev.lineno + ")") : ""), where);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    let msg = "未处理的异步异常";
    try { msg = (ev && ev.reason && (ev.reason.message || ev.reason)) || msg; } catch (e) {}
    recordError("未处理异常: " + msg, "前台");
  });
})();
