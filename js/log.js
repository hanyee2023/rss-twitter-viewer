// ===== log.js (运行日志) =====
// 记录当天运行情况：
//   顶部 代理/网络状态（是否在线 + 出口 IP + 接入节点城市/国家，见 checkConn）
//   一、今日更新（逐次列举：条目/已读/未读/屏蔽/隐藏/失败）
//   二、前后台错误
//   三、提示（hls.js 版本更新）
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

  // ---------- 本地存储读数（5.0 / 5.2 精简）----------
  // 目的：一眼看出「条目数变少」是不是本地配额被砍（降档）。
  //   · 可浏览条目 = localStorage 里 rss_article_cache 的真实条数
  //     ← 这就是「你在软件里实际能翻到的条目数」（主页 / 收藏 / 搜索都取自这一份）。
  //   · 本站占用   = 本域名下所有 localStorage 键（UTF-16 计费，1 字符 = 2 字节）的总和
  //   · 已用 / 上限 = 本域名全部键 vs localStorage 硬上限（约 5MB，见下方常量）
  //
  // 【5.2 移除「来源缓存 N 个源 / 合计 M 条」】那一份是各订阅源的原始副本，**不进列表**、
  // 只在该源当场拉取失败时用于断网回退，与「可浏览条目」根本不是同一份数据，并列显示
  // 只会让人以为「我到底能看 1000 条还是 899 条」。既然它不代表任何可浏览内容，就整行去掉。
  // 需要时仍可通过 AppLog.measureStorage() 取到 rssFeedCount / rssItemCount（未删除该能力）。
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
      '<div class="ls-line">可浏览条目 <b>' + m.articleCount + '</b> 条 / ' + fmtMB(m.articleBytes) + ratioNote + '</div>' +
      '<div class="ls-line ls-sub">本地存储已用 <span class="' + pctCls + '">' + fmtMB(m.allBytes) + ' / 上限约 5 MB（' + pct + '%）</span>' + pctTip + '</div>' +
      '<div class="ls-line ls-sub">本站占用 ' + fmtMB(m.appBytes) + ' ｜ 本域名全部键 ' + fmtMB(m.allBytes) + '</div>';
  }

  // ---------- 代理 / 网络状态（5.2）----------
  // 目的：页面顶部一眼看到「代理是否在线 + 本机出口 IP + 请求落地的 Cloudflare 节点在哪」。
  // 数据来源（都用同源地址，不经过任何第三方）：
  //   ① GET /ping           —— functions/ping.js，由 Pages Functions 执行，返回
  //                            { ip, colo, country, city, asn, ts }。能成功返回即说明
  //                            **代理函数本身在正常运行**（这是「在线」的强证据）。
  //   ② GET /cdn-cgi/trace  —— Cloudflare 边缘直接吐出的纯文本（flux=... / ip=... / colo=... / loc=...）。
  //                            它不经过 Functions，只能证明「站点可达」，作为降级数据源。
  // 判定：
  //   ok       = /ping 成功（代理在线，Functions 正常）
  //   degraded = /ping 失败但 /cdn-cgi/trace 成功（站点可达，但代理函数未按预期响应）
  //   offline  = 两者都失败（离线 / 完全不可达）
  // 字段释义（很容易被误读，故在此写清楚）：
  //   · ip  = Cloudflare 看到的**访客公网 IP**（也就是本机出口 IP，不是代理服务器的 IP；
  //           本应用直连 Cloudflare，中间没有别的代理）。
  //   · colo= 请求落地的 **Cloudflare 边缘节点**（机场三字码，如 LAX=洛杉矶）。
  //           它就是「代理所在的城市」——国内运营商（尤其中国移动）常被调度到美西节点。
  //   · 结果存进当天报告（r.conn），10 分钟内不重复检测，所以切页不会疯狂发请求。
  const CONN_TTL = 10 * 60 * 1000; // 10 分钟

  // Cloudflare 边缘节点（IATA 三字码）→ [城市, 国家]。仅收录常见节点，未收录时只显示三字码。
  const COLO_MAP = {
    LAX: ["洛杉矶", "美国"], SJC: ["圣何塞", "美国"], SFO: ["旧金山", "美国"], SEA: ["西雅图", "美国"],
    PDX: ["波特兰", "美国"], DEN: ["丹佛", "美国"], DFW: ["达拉斯", "美国"], IAH: ["休斯敦", "美国"],
    ORD: ["芝加哥", "美国"], ATL: ["亚特兰大", "美国"], MIA: ["迈阿密", "美国"], IAD: ["阿什本", "美国"],
    EWR: ["纽瓦克", "美国"], JFK: ["纽约", "美国"], BOS: ["波士顿", "美国"], PHX: ["凤凰城", "美国"],
    LAS: ["拉斯维加斯", "美国"], SAN: ["圣迭戈", "美国"], MSP: ["明尼阿波利斯", "美国"], DTW: ["底特律", "美国"],
    SLC: ["盐湖城", "美国"], HNL: ["檀香山", "美国"], ANC: ["安克雷奇", "美国"], AUS: ["奥斯汀", "美国"],
    GUM: ["关岛", "美国"], YVR: ["温哥华", "加拿大"], YYZ: ["多伦多", "加拿大"], YUL: ["蒙特利尔", "加拿大"],
    YYC: ["卡尔加里", "加拿大"], MEX: ["墨西哥城", "墨西哥"], GRU: ["圣保罗", "巴西"], GIG: ["里约热内卢", "巴西"],
    EZE: ["布宜诺斯艾利斯", "阿根廷"], SCL: ["圣地亚哥", "智利"], LIM: ["利马", "秘鲁"], BOG: ["波哥大", "哥伦比亚"],
    PTY: ["巴拿马城", "巴拿马"], LHR: ["伦敦", "英国"], LGW: ["伦敦", "英国"], MAN: ["曼彻斯特", "英国"],
    EDI: ["爱丁堡", "英国"], DUB: ["都柏林", "爱尔兰"], AMS: ["阿姆斯特丹", "荷兰"], FRA: ["法兰克福", "德国"],
    MUC: ["慕尼黑", "德国"], BER: ["柏林", "德国"], DUS: ["杜塞尔多夫", "德国"], HAM: ["汉堡", "德国"],
    CDG: ["巴黎", "法国"], MRS: ["马赛", "法国"], LYS: ["里昂", "法国"], MAD: ["马德里", "西班牙"],
    BCN: ["巴塞罗那", "西班牙"], LIS: ["里斯本", "葡萄牙"], FCO: ["罗马", "意大利"], MXP: ["米兰", "意大利"],
    ZRH: ["苏黎世", "瑞士"], GVA: ["日内瓦", "瑞士"], VIE: ["维也纳", "奥地利"], BRU: ["布鲁塞尔", "比利时"],
    CPH: ["哥本哈根", "丹麦"], ARN: ["斯德哥尔摩", "瑞典"], OSL: ["奥斯陆", "挪威"], HEL: ["赫尔辛基", "芬兰"],
    WAW: ["华沙", "波兰"], PRG: ["布拉格", "捷克"], BUD: ["布达佩斯", "匈牙利"], OTP: ["布加勒斯特", "罗马尼亚"],
    SOF: ["索菲亚", "保加利亚"], ATH: ["雅典", "希腊"], IST: ["伊斯坦布尔", "土耳其"], KBP: ["基辅", "乌克兰"],
    SVO: ["莫斯科", "俄罗斯"], LED: ["圣彼得堡", "俄罗斯"], KEF: ["雷克雅未克", "冰岛"], ZAG: ["萨格勒布", "克罗地亚"],
    BEG: ["贝尔格莱德", "塞尔维亚"], RIX: ["里加", "拉脱维亚"], TLL: ["塔林", "爱沙尼亚"], LUX: ["卢森堡", "卢森堡"],
    DXB: ["迪拜", "阿联酋"], AUH: ["阿布扎比", "阿联酋"], DOH: ["多哈", "卡塔尔"], KWI: ["科威特城", "科威特"],
    BAH: ["麦纳麦", "巴林"], RUH: ["利雅得", "沙特阿拉伯"], JED: ["吉达", "沙特阿拉伯"], MCT: ["马斯喀特", "阿曼"],
    AMM: ["安曼", "约旦"], BEY: ["贝鲁特", "黎巴嫩"], TLV: ["特拉维夫", "以色列"], BGW: ["巴格达", "伊拉克"],
    IKA: ["德黑兰", "伊朗"], CAI: ["开罗", "埃及"], JNB: ["约翰内斯堡", "南非"], CPT: ["开普敦", "南非"],
    NBO: ["内罗毕", "肯尼亚"], LOS: ["拉各斯", "尼日利亚"], ACC: ["阿克拉", "加纳"], ADD: ["亚的斯亚贝巴", "埃塞俄比亚"],
    DAR: ["达累斯萨拉姆", "坦桑尼亚"], MRU: ["路易港", "毛里求斯"], CMN: ["卡萨布兰卡", "摩洛哥"], TUN: ["突尼斯", "突尼斯"],
    HKG: ["中国香港", "中国"], MFM: ["中国澳门", "中国"], TPE: ["中国台湾（台北）", "中国"], KHH: ["中国台湾（高雄）", "中国"],
    PEK: ["北京", "中国"], PKX: ["北京", "中国"], SHA: ["上海", "中国"], PVG: ["上海", "中国"], CAN: ["广州", "中国"],
    SZX: ["深圳", "中国"], CTU: ["成都", "中国"], CKG: ["重庆", "中国"], WUH: ["武汉", "中国"], XIY: ["西安", "中国"],
    HGH: ["杭州", "中国"], NKG: ["南京", "中国"], TAO: ["青岛", "中国"], TSN: ["天津", "中国"], CSX: ["长沙", "中国"],
    KMG: ["昆明", "中国"], XMN: ["厦门", "中国"], FOC: ["福州", "中国"], HAK: ["海口", "中国"], CGO: ["郑州", "中国"],
    TNA: ["济南", "中国"], SHE: ["沈阳", "中国"], HRB: ["哈尔滨", "中国"], URC: ["乌鲁木齐", "中国"], NNG: ["南宁", "中国"],
    KWE: ["贵阳", "中国"], HET: ["呼和浩特", "中国"], LHW: ["兰州", "中国"], TYN: ["太原", "中国"], SJW: ["石家庄", "中国"],
    HFE: ["合肥", "中国"], INC: ["银川", "中国"], XNN: ["西宁", "中国"], LXA: ["拉萨", "中国"],
    NRT: ["东京", "日本"], HND: ["东京", "日本"], KIX: ["大阪", "日本"], ITM: ["大阪", "日本"], NGO: ["名古屋", "日本"],
    FUK: ["福冈", "日本"], CTS: ["札幌", "日本"], OKA: ["冲绳", "日本"], SDJ: ["仙台", "日本"],
    ICN: ["首尔", "韩国"], GMP: ["首尔", "韩国"], PUS: ["釜山", "韩国"], CJU: ["济州", "韩国"],
    SIN: ["新加坡", "新加坡"], KUL: ["吉隆坡", "马来西亚"], PEN: ["槟城", "马来西亚"], BKI: ["亚庇", "马来西亚"],
    CGK: ["雅加达", "印度尼西亚"], DPS: ["登巴萨", "印度尼西亚"], SUB: ["泗水", "印度尼西亚"],
    BKK: ["曼谷", "泰国"], CNX: ["清迈", "泰国"], HKT: ["普吉", "泰国"], HAN: ["河内", "越南"],
    SGN: ["胡志明市", "越南"], DAD: ["岘港", "越南"], PNH: ["金边", "柬埔寨"], RGN: ["仰光", "缅甸"],
    VTE: ["万象", "老挝"], MNL: ["马尼拉", "菲律宾"], CEB: ["宿务", "菲律宾"], BWN: ["斯里巴加湾", "文莱"],
    KTM: ["加德满都", "尼泊尔"], DAC: ["达卡", "孟加拉国"], CMB: ["科伦坡", "斯里兰卡"], MLE: ["马累", "马尔代夫"],
    DEL: ["新德里", "印度"], BOM: ["孟买", "印度"], BLR: ["班加罗尔", "印度"], MAA: ["金奈", "印度"],
    HYD: ["海得拉巴", "印度"], CCU: ["加尔各答", "印度"], TAS: ["塔什干", "乌兹别克斯坦"], ALA: ["阿拉木图", "哈萨克斯坦"],
    UBN: ["乌兰巴托", "蒙古"], SYD: ["悉尼", "澳大利亚"], MEL: ["墨尔本", "澳大利亚"], BNE: ["布里斯班", "澳大利亚"],
    PER: ["珀斯", "澳大利亚"], ADL: ["阿德莱德", "澳大利亚"], CBR: ["堪培拉", "澳大利亚"], AKL: ["奥克兰", "新西兰"],
    WLG: ["惠灵顿", "新西兰"], CHC: ["基督城", "新西兰"], NAN: ["楠迪", "斐济"], PPT: ["帕皮提", "法属波利尼西亚"]
  };

  // 国家/地区代码 → 中文。仅用于「识别地区」一行；未收录时直接显示原代码。
  const CC_CN = {
    CN: "中国", HK: "中国香港", MO: "中国澳门", TW: "中国台湾", US: "美国", CA: "加拿大", MX: "墨西哥",
    BR: "巴西", AR: "阿根廷", CL: "智利", PE: "秘鲁", CO: "哥伦比亚", PA: "巴拿马",
    GB: "英国", IE: "爱尔兰", FR: "法国", DE: "德国", NL: "荷兰", BE: "比利时", LU: "卢森堡",
    ES: "西班牙", PT: "葡萄牙", IT: "意大利", GR: "希腊", CH: "瑞士", AT: "奥地利",
    SE: "瑞典", NO: "挪威", DK: "丹麦", FI: "芬兰", IS: "冰岛", PL: "波兰", CZ: "捷克",
    HU: "匈牙利", RO: "罗马尼亚", BG: "保加利亚", HR: "克罗地亚", RS: "塞尔维亚", SI: "斯洛文尼亚",
    SK: "斯洛伐克", EE: "爱沙尼亚", LV: "拉脱维亚", LT: "立陶宛", UA: "乌克兰", RU: "俄罗斯", BY: "白俄罗斯",
    TR: "土耳其", IL: "以色列", AE: "阿联酋", SA: "沙特阿拉伯", QA: "卡塔尔", KW: "科威特", BH: "巴林",
    OM: "阿曼", JO: "约旦", LB: "黎巴嫩", IQ: "伊拉克", IR: "伊朗", EG: "埃及", MA: "摩洛哥", TN: "突尼斯",
    DZ: "阿尔及利亚", ZA: "南非", NG: "尼日利亚", KE: "肯尼亚", GH: "加纳", TZ: "坦桑尼亚", ET: "埃塞俄比亚",
    MU: "毛里求斯", JP: "日本", KR: "韩国", SG: "新加坡", MY: "马来西亚", TH: "泰国", VN: "越南",
    PH: "菲律宾", ID: "印度尼西亚", IN: "印度", PK: "巴基斯坦", BD: "孟加拉国", LK: "斯里兰卡",
    NP: "尼泊尔", KH: "柬埔寨", MM: "缅甸", LA: "老挝", MN: "蒙古", BN: "文莱", MV: "马尔代夫",
    KZ: "哈萨克斯坦", UZ: "乌兹别克斯坦", KG: "吉尔吉斯斯坦", TJ: "塔吉克斯坦", TM: "土库曼斯坦",
    AU: "澳大利亚", NZ: "新西兰", FJ: "斐济", PG: "巴布亚新几内亚"
  };
  function coloText(code) {
    const c = String(code || "").toUpperCase();
    if (!c) return "";
    const m = COLO_MAP[c];
    return m ? (m[0] + " " + c + " · " + m[1]) : c;
  }
  function ccText(code) {
    const c = String(code || "").toUpperCase();
    if (!c) return "";
    return (CC_CN[c] || c) + "（" + c + "）";
  }
  function isIPv6(s) { return String(s || "").indexOf(":") >= 0; }

  // 带超时的同源 GET（返回 Response + 文本，便于既解析 JSON 也解析纯文本）
  function httpGet(url, ms) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error("timeout"));
      }, ms || 8000);
      const opts = { cache: "no-store" };
      if (ctl) opts.signal = ctl.signal;
      let req;
      try { req = fetch(url, opts); } catch (e) { clearTimeout(timer); reject(e); return; }
      req.then(function (res) {
        return res.text().then(function (text) { return { res: res, text: text }; });
      }).then(function (out) {
        if (done) return; done = true; clearTimeout(timer); resolve(out);
      }, function (e) {
        if (done) return; done = true; clearTimeout(timer); reject(e);
      });
    });
  }
  // /cdn-cgi/trace 的纯文本形如 "fl=xxx\nip=1.2.3.4\ncolo=LAX\nloc=CN\n..."
  function parseTraceText(text) {
    const out = {};
    String(text || "").split("\n").forEach(function (line) {
      const i = line.indexOf("=");
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return out;
  }

  let _connChecking = false;
  function saveConn(rec) {
    try {
      const r = ensureToday();
      r.conn = rec;
      writeReport(todayKey(), r);
    } catch (e) { /* ignore */ }
    _connChecking = false;
    renderConn(); // 就地刷新顶部状态块，不整页重绘（避免与 renderList 互相递归）
  }
  // 判断响应是不是「网页」而非接口 JSON。
  // 必要性：Cloudflare Pages 对**未部署的路径**不会返回 404，而是回落到 index.html（HTTP 200 + HTML）。
  // 若不识别这一点，未部署 /ping 时会被误判成「代理异常」，让人以为代理坏了。
  function isHtmlResponse(o) {
    let ct = "";
    try {
      if (o && o.res && o.res.headers && typeof o.res.headers.get === "function") {
        ct = String(o.res.headers.get("content-type") || "");
      }
    } catch (e) { /* ignore */ }
    if (ct.toLowerCase().indexOf("html") >= 0) return true;
    const t = String((o && o.text) || "").trim().toLowerCase();
    return t.indexOf("<!doctype html") === 0 || t.indexOf("<html") === 0;
  }
  function checkConn() {
    if (_connChecking) return;
    _connChecking = true;
    let pingMissing = false; // /ping 未部署（回落成网页）
    // ① 先问代理函数（能答上 JSON = 代理在线）
    httpGet("/ping", 6000).then(function (o) {
      if (!o.res || !o.res.ok) throw new Error("HTTP " + (o.res && o.res.status));
      if (isHtmlResponse(o)) { pingMissing = true; throw new Error("no /ping endpoint"); }
      let d = null;
      try { d = JSON.parse(o.text); } catch (e) { /* 解析失败也走降级 */ }
      if (!d || !d.ok) throw new Error("bad body");
      return { status: "ok", ip: String(d.ip || ""), colo: String(d.colo || ""), region: String(d.country || ""), city: String(d.city || "") };
    }).catch(function () {
      // ② 代理没答上来 → 至少用边缘 trace 拿到 IP / 节点（站点可达）
      return httpGet("/cdn-cgi/trace", 6000).then(function (o) {
        if (!o.res || !o.res.ok) throw new Error("HTTP " + (o.res && o.res.status));
        const t = parseTraceText(o.text);
        if (!t.colo && !t.ip) throw new Error("bad trace");
        return {
          status: "degraded",
          pingMissing: pingMissing,
          ip: String(t.ip || ""), colo: String(t.colo || ""), region: String(t.loc || ""), city: ""
        };
      });
    }).then(function (rec) {
      rec.ts = Date.now();
      saveConn(rec);
    }, function () {
      saveConn({ status: "offline", ip: "", colo: "", region: "", city: "", ts: Date.now() });
    });
  }
  // 10 分钟内不重复检测；到期或从未检测过才发请求
  function ensureConnCheck() {
    const r = ensureToday();
    const c = r.conn;
    if (c && c.ts && (Date.now() - c.ts) < CONN_TTL) return;
    checkConn();
  }
  function renderConn() {
    const box = el("logConn");
    if (!box) return;
    const r = ensureToday();
    const c = r.conn;
    if (!c) {
      box.innerHTML = '<div class="conn-line conn-wait">代理状态检测中…</div>';
      return;
    }
    // 状态判定与文案（degraded 分两种：/ping 未部署 vs 代理函数真的没响应）
    let clr, label, note = "";
    if (c.status === "ok") {
      clr = "conn-ok"; label = "代理在线";
    } else if (c.status === "degraded" && c.pingMissing) {
      // 站点可达、数据取自边缘；只是 /ping 这个接口还没部署，不代表代理坏了
      clr = "conn-ok"; label = "代理在线";
      note = ' <span class="conn-sub">（/ping 接口未部署，节点数据取自边缘 trace）</span>';
    } else if (c.status === "degraded") {
      clr = "conn-amber"; label = "代理异常";
      note = ' <span class="conn-amber">（站点可达，但代理函数未响应）</span>';
    } else {
      clr = "conn-err"; label = "代理离线";
      note = ' <span class="conn-err">（连不上 Cloudflare，请检查网络）</span>';
    }
    const node = c.colo ? ('接入节点 <b>' + escapeHtml(coloText(c.colo)) + '</b>') : "接入节点未知";
    let l1 = '<div class="conn-line"><span class="' + clr + '">' + label + '</span> ｜ ' + node + note + '</div>';
    const ipTxt = c.ip ? ('本机公网 IP <b>' + escapeHtml(c.ip) + '</b>（' + (isIPv6(c.ip) ? "IPv6" : "IPv4") + '）') : "本机公网 IP 未知";
    l1 += '<div class="conn-line conn-sub">' + ipTxt + (c.region ? (' ｜ 识别地区 ' + escapeHtml(ccText(c.region))) : "") + '</div>';
    box.innerHTML = l1;
  }

  // ---------- 自托管 hls.js 版本检查（5.1）----------
  // 目的：js/hls.min.js 是固定版本，上游发新版时不会自动更新。这里**每天检查一次**上游最新版本，
  //       若已有更新，就写进当天运行报告的「三、提示」，提醒替换文件（附带当前/最新版本号）。
  // 设计要点：
  //   · 本地版本优先取 window.Hls.version（hls.js 构建自带的静态属性，如 "1.7.3"），取不到时用下方常量兜底。
  //     ⚠️ 替换 js/hls.min.js 时，请把 HLS_BUNDLED_VERSION 一并改成新版本号。
  //   · 检查顺序：同源 /hls-version（若已部署该 Function，服务端出口更可靠）→ jsDelivr → npm registry。
  //     任一成功即用；**全部失败不记为错误**（仅在提示里写「检查失败」），避免网络受限时污染错误日志。
  //   · 结果写进当天报告（r.hls），所以天然「一天一次」，也不会因反复切页而重复请求。
  const HLS_BUNDLED_VERSION = "1.7.3";
  const HLS_VERSION_ENDPOINTS = [
    "/hls-version",
    "https://data.jsdelivr.com/v1/package/npm/hls.js",
    "https://registry.npmjs.org/hls.js/latest"
  ];
  let _hlsChecking = false;

  function hlsLocalVersion() {
    try { if (window.Hls && window.Hls.version) return String(window.Hls.version); } catch (e) { /* ignore */ }
    return HLS_BUNDLED_VERSION;
  }
  // 版本比较：a 比 b 新返回 1，旧返回 -1，相同返回 0（忽略 v 前缀与预发布标签）
  function cmpVersion(a, b) {
    function parts(s) {
      return String(s == null ? "" : s).replace(/^v/i, "").split("-")[0].split(".")
        .map(function (x) { return parseInt(x, 10) || 0; });
    }
    const pa = parts(a), pb = parts(b);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const x = pa[i] || 0, y = pb[i] || 0;
      if (x > y) return 1;
      if (x < y) return -1;
    }
    return 0;
  }
  function parseLatestVersion(url, data) {
    if (!data) return "";
    if (url.charAt(0) === "/") return data.version || "";          // 同源 /hls-version
    if (data.tags && data.tags.latest) return data.tags.latest;    // jsDelivr
    if (data.version) return data.version;                         // npm registry
    return "";
  }
  function fetchJson(url) {
    return new Promise(function (resolve, reject) {
      let done = false;
      const ctl = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const timer = setTimeout(function () {
        if (done) return;
        done = true;
        if (ctl) { try { ctl.abort(); } catch (e) {} }
        reject(new Error("timeout"));
      }, 8000);
      const opts = { cache: "no-store" };
      if (ctl) opts.signal = ctl.signal;
      let req;
      try { req = fetch(url, opts); } catch (e) { clearTimeout(timer); reject(e); return; }
      req.then(function (res) {
        return res && res.ok ? res.json() : Promise.reject(new Error("HTTP " + (res && res.status)));
      }).then(function (data) {
        if (done) return; done = true; clearTimeout(timer); resolve(data);
      }, function (e) {
        if (done) return; done = true; clearTimeout(timer); reject(e);
      });
    });
  }
  function fetchLatestHlsVersion() {
    let idx = 0;
    function next() {
      if (idx >= HLS_VERSION_ENDPOINTS.length) return Promise.reject(new Error("all endpoints failed"));
      const url = HLS_VERSION_ENDPOINTS[idx++];
      return fetchJson(url).then(function (data) {
        const v = parseLatestVersion(url, data);
        if (!v) throw new Error("no version in response");
        return { version: String(v), source: url };
      }, function () { return next(); });
    }
    return next();
  }
  function saveHlsCheck(rec) {
    try {
      const r = ensureToday();
      r.hls = rec;
      writeReport(todayKey(), r);
    } catch (e) { /* ignore */ }
    _hlsChecking = false;
    renderList(); // 结果就绪后刷新页面（把提示写上去）
  }
  // 每天一次：当天报告里已有结果就直接用，不再发请求
  function ensureHlsCheck() {
    const r = ensureToday();
    if (r.hls && r.hls.local) return;
    if (_hlsChecking) return;
    _hlsChecking = true;
    const local = hlsLocalVersion();
    fetchLatestHlsVersion().then(function (res) {
      saveHlsCheck({
        local: local,
        latest: res.version,
        hasUpdate: cmpVersion(local, res.version) < 0,
        status: "ok",
        checkedAt: timeStrOf(),
        source: res.source
      });
    }, function () {
      saveHlsCheck({ local: local, latest: "", hasUpdate: false, status: "fail", checkedAt: timeStrOf(), source: "" });
    });
  }
  function hlsNoticeHtml(r) {
    const local = hlsLocalVersion();
    const c = r && r.hls;
    if (!c) return '<div class="log-empty">hls.js 版本 ' + escapeHtml(local) + '（更新检查中…）</div>';
    if (c.status === "ok" && c.hasUpdate) {
      return '<div class="hls-notice">' +
        'hls.js 有新版本：当前 <b>' + escapeHtml(c.local) + '</b> → 最新 <b>' + escapeHtml(c.latest) + '</b><br>' +
        '下载新版 <code>hls.min.js</code> 覆盖仓库 <code>js/hls.min.js</code>，并把 <code>log.js</code> 里的 ' +
        '<code>HLS_BUNDLED_VERSION</code> 改成 <code>' + escapeHtml(c.latest) + '</code>' +
        '（检查于 ' + escapeHtml(c.checkedAt) + '）' +
        '</div>';
    }
    if (c.status === "ok") {
      return '<div class="log-empty">hls.js 版本 ' + escapeHtml(c.local) + '（已是最新，检查于 ' + escapeHtml(c.checkedAt) + '）</div>';
    }
    return '<div class="log-empty">hls.js 版本 ' + escapeHtml(local) + '（更新检查失败：网络受限或接口不可达，明天自动重试）</div>';
  }

  // 5.1：取消列表 + 详情弹窗，改为在日志页直接展示今日报告。
  // 5.2：今日更新由「只显示最后一次」改为**按时间逐次列举**（每条：条目/已读/未读/屏蔽/隐藏/失败）。
  // 函数名保留 renderList（feed.js 切页时调用它），行为变为渲染当天内容。
  function renderList() {
    const box = el("logList");
    if (!box) return;
    renderStorageBar();
    renderConn();
    const r = ensureToday();
    const updates = r.updates || [];
    const errors = r.errors || [];

    // 一、今日更新：按时间顺序逐次列举，数字统一蓝色加粗
    let uHtml;
    if (!updates.length) {
      uHtml = '<div class="log-empty">（今日暂无更新记录，刷新主页后自动生成）</div>';
    } else {
      uHtml = '<div class="log-detail-list">';
      updates.forEach(function (u, i) {
        uHtml +=
          '<div class="log-detail-row"><span class="ld-idx">' + (i + 1) + '</span>' +
          '<div class="ld-body">' +
          '<div class="ld-time">' + escapeHtml(u.time) + (u.source ? (" · " + escapeHtml(u.source)) : "") + '</div>' +
          '<div class="ld-stats">条目 <b>' + (u.itemCount || 0) + '</b>' +
          ' ｜ 已读 <b>' + (u.readCount || 0) + '</b>' +
          ' ｜ 未读 <b>' + (u.unreadCount || 0) + '</b>' +
          ' ｜ 屏蔽 <b>' + (u.blockedCount || 0) + '</b>' +
          ' ｜ 隐藏 <b>' + (u.hiddenCount || 0) + '</b>' +
          ' ｜ 失败 <b>' + (u.failCount || 0) + '</b>' +
          ((u.savedCount && u.itemCount && u.savedCount < u.itemCount)
            ? ' <span class="ls-warn">（本地只存下 ' + u.savedCount + ' 条，已被配额降档）</span>'
            : '') +
          '</div></div></div>';
      });
      uHtml += '</div>';
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
      '<div class="log-detail-sec-title">一、今日更新' + (updates.length ? ('（共 ' + updates.length + ' 次）') : '') + '</div>' + uHtml +
      '<div class="log-detail-sec-title">二、错误记录（前台 / 后台）</div>' +
      '<div class="log-detail-list">' + eHtml + '</div>' +
      '<div class="log-detail-sec-title">三、提示</div>' + hlsNoticeHtml(r) +
      '</div>';

    // 提示区里的 hls.js 版本：每天检查一次（结果存于当天报告，切页不会重复请求）
    ensureHlsCheck();
    // 顶部代理/网络状态：10 分钟一次（结果存于当天报告）
    ensureConnCheck();
  }

  function buildReportText(r) {
    const lines = [];
    lines.push("运行日志报告 " + r.date);
    lines.push("================================");
    // 顶部：代理 / 网络状态（与页面一致）
    const cn = r.conn;
    if (!cn) {
      lines.push("代理状态：检测中…");
    } else if (cn.status === "ok") {
      lines.push("代理状态：在线 ｜ 接入节点：" + (coloText(cn.colo) || "未知") +
        (cn.ip ? (" ｜ 本机公网 IP：" + cn.ip) : "") +
        (cn.region ? (" ｜ 识别地区：" + ccText(cn.region)) : ""));
    } else if (cn.status === "degraded") {
      const tail = (cn.ip ? (" ｜ 本机公网 IP：" + cn.ip) : "") + (cn.region ? (" ｜ 识别地区：" + ccText(cn.region)) : "");
      if (cn.pingMissing) {
        lines.push("代理状态：在线（/ping 接口未部署，节点数据取自边缘 trace）｜ 接入节点：" + (coloText(cn.colo) || "未知") + tail);
      } else {
        lines.push("代理状态：异常（站点可达，但代理函数未响应）｜ 接入节点：" + (coloText(cn.colo) || "未知") + tail);
      }
    } else {
      lines.push("代理状态：离线（连不上 Cloudflare，请检查网络）");
    }
    lines.push("本地存储：可浏览条目 " + measureStorage().articleCount + " 条");
    lines.push("================================");
    const updates = r.updates || [];
    lines.push("一、今日更新" + (updates.length ? ("（共 " + updates.length + " 次）") : ""));
    if (!updates.length) {
      lines.push("（今日暂无更新记录）");
    } else {
      updates.forEach(function (u, i) {
        lines.push((i + 1) + ". [" + u.time + "]" + (u.source ? (" " + u.source) : "") +
          " 条目 " + (u.itemCount || 0) +
          " / 已读 " + (u.readCount || 0) +
          " / 未读 " + (u.unreadCount || 0) +
          " / 屏蔽 " + (u.blockedCount || 0) +
          " / 隐藏 " + (u.hiddenCount || 0) +
          " / 失败 " + (u.failCount || 0) +
          ((u.savedCount && u.itemCount && u.savedCount < u.itemCount)
            ? ("（本地只存下 " + u.savedCount + " 条，已被配额降档）") : ""));
      });
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
    lines.push("");
    lines.push("三、提示");
    const c = r.hls;
    if (!c) {
      lines.push("hls.js 版本 " + hlsLocalVersion() + "（更新检查中）");
    } else if (c.status === "ok" && c.hasUpdate) {
      lines.push("hls.js 有新版本：当前 " + c.local + " → 最新 " + c.latest +
        "（请下载新版 hls.min.js 覆盖 js/hls.min.js，并把 log.js 的 HLS_BUNDLED_VERSION 改为 " + c.latest + "）" +
        " ［检查于 " + c.checkedAt + "］");
    } else if (c.status === "ok") {
      lines.push("hls.js 版本 " + c.local + "（已是最新，检查于 " + c.checkedAt + "）");
    } else {
      lines.push("hls.js 版本 " + hlsLocalVersion() + "（更新检查失败：网络受限或接口不可达，明天自动重试）");
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
    const data = { app: "rss-twitter-viewer", version: "5.2", exportedAt: new Date().toISOString(), report: r };
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
    renderConn: renderConn,
    checkConn: checkConn,
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
