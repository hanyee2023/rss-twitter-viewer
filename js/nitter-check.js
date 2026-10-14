// nitter-check.js — 运行日志「四、Nitter 实例检测」区块逻辑（独立模块，不依赖 log.js）
// 功能：
//   1. 打开软件自动检测，周期 = 每天首次打开仅一次（localStorage 记日期）
//   2. 列出内置实例名称 + 状态 + 耗时
//   3. 每行右侧【重新检测】按钮（单实例 &only= 重测）
//   4. 区块标题右侧【重新检测】按钮（整体重测，手动触发）
(function () {
  'use strict';

  var STORAGE_KEY = 'nitter_check_date';

  function todayStr() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function healthUrl(only) {
    return location.origin + '/twitter-rss?health=json' + (only ? ('&only=' + encodeURIComponent(only)) : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function statusText(r) {
    return r.status === 'OK' ? '✅ 可用' : '❌ 失效';
  }

  function rowInner(r) {
    return '<span class="nc-name">' + escapeHtml(r.instance) + '</span>' +
      '<span class="nc-status ' + (r.status === 'OK' ? 'ok' : 'bad') + '">' + statusText(r) + '</span>' +
      '<span class="nc-ms">' + (typeof r.ms === 'number' ? r.ms + 'ms' : '') + '</span>' +
      '<button class="btn-recheck nc-btn" data-host="' + escapeHtml(r.instance) + '">重新检测</button>';
  }

  function buildRow(r) {
    var row = document.createElement('div');
    row.className = 'nc-row';
    row.setAttribute('data-host', r.instance);
    row.innerHTML = rowInner(r);
    return row;
  }

  var listEl = null;
  var refreshAllBtn = null;

  function renderList(results) {
    if (!listEl) return;
    listEl.innerHTML = '';
    if (!results || !results.length) {
      listEl.innerHTML = '<div class="nc-loading">没有可检测的实例</div>';
      return;
    }
    results.forEach(function (r) {
      listEl.appendChild(buildRow(r));
    });
  }

  function showError(msg) {
    if (!listEl) return;
    listEl.innerHTML = '<div class="nc-loading">检测失败：' + escapeHtml(msg) + '（部署后由 Cloudflare 边缘网络执行）</div>';
  }

  // 整体检测：isManual=true 为手动触发（不写日期标记），false 为每天首次自动检测
  function checkAll(isManual) {
    if (refreshAllBtn) refreshAllBtn.disabled = true;
    fetch(healthUrl(), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        renderList(data.results);
        if (!isManual) {
          try { localStorage.setItem(STORAGE_KEY, todayStr()); } catch (e) {}
        }
      })
      .catch(function (e) {
        showError(e && e.message ? e.message : '网络错误');
      })
      .finally(function () {
        if (refreshAllBtn) refreshAllBtn.disabled = false;
      });
  }

  // 单实例检测：更新对应行
  function checkOne(host) {
    fetch(healthUrl(host), { cache: 'no-store' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.results && data.results.length) {
          var r = data.results[0];
          var old = listEl.querySelector('.nc-row[data-host="' + String(host).replace(/["\\]/g, '\\$&') + '"]');
          if (old) {
            old.setAttribute('data-host', r.instance);
            old.innerHTML = rowInner(r);
          }
        }
      })
      .catch(function (e) {
        console.warn('[nitter-check] 单实例检测失败', host, e);
      });
  }

  function init() {
    listEl = document.getElementById('nitterCheckList');
    refreshAllBtn = document.getElementById('btnNitterRefreshAll');
    if (!listEl) return;

    // 事件委托：单实例「重新检测」
    listEl.addEventListener('click', function (e) {
      var t = e.target;
      var btn = (t && t.classList && t.classList.contains('nc-btn')) ? t
        : (t && t.closest ? t.closest('.nc-btn') : null);
      if (btn && btn.getAttribute('data-host')) {
        var host = btn.getAttribute('data-host');
        btn.disabled = true;
        checkOne(host);
        setTimeout(function () { btn.disabled = false; }, 1500);
      }
    });

    if (refreshAllBtn) {
      refreshAllBtn.addEventListener('click', function () { checkAll(true); });
    }

    // 自动检测：每天首次打开仅一次
    var lastDate = '';
    try { lastDate = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
    if (lastDate !== todayStr()) {
      checkAll(false);
    } else if (!listEl.querySelector('.nc-row')) {
      // 当天已检测过，但列表为空（首次渲染异常），补一次
      checkAll(false);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
