// —— 标题自动翻译（2026-11-18 新增）——
// 纯前端异步实现：卡片先渲染原文，检测到非中文标题后在后台翻译，译文就位后替换显示。
// 不经过 Cloudflare Workers → 不耗 CF CPU/请求额度，不影响卡片显示速度。
// 接口：优先微软 Edge 免费接口（支持批量、无需 key）→ 失败回退 Google gtx 免费接口（逐条）。
// 译文缓存：localStorage「rss_trans_cache」，上限 2000 条 FIFO（防止撑爆 5MB 配额）。
// 开关：localStorage「rss_trans_enabled」，默认开启；管理页顶部按钮切换。
// 失败策略：接口不可用时静默保留原文，绝不阻塞渲染。

const TRANS_CACHE_KEY = "rss_trans_cache";
const TRANS_ON_KEY = "rss_trans_enabled";
const TRANS_CACHE_LIMIT = 2000;

let transEnabled = localStorage.getItem(TRANS_ON_KEY) !== "0";
let transCache = {};
try {
    const parsed = JSON.parse(localStorage.getItem(TRANS_CACHE_KEY) || "{}");
    if (parsed && typeof parsed === "object") transCache = parsed;
} catch (e) { transCache = {}; }

function saveTransCache() {
    try {
        // FIFO 裁剪：超过上限时删除最早的译文
        const keys = Object.keys(transCache);
        if (keys.length > TRANS_CACHE_LIMIT) {
            keys.slice(0, keys.length - TRANS_CACHE_LIMIT).forEach(k => delete transCache[k]);
        }
        localStorage.setItem(TRANS_CACHE_KEY, JSON.stringify(transCache));
    } catch (e) {
        // 配额不足时清空重试一次
        try { transCache = {}; localStorage.setItem(TRANS_CACHE_KEY, "{}"); } catch (e2) {}
    }
}

function isChineseText(t) {
    return /[\u4e00-\u9fff]/.test(t || "");
}

// 独立 hash（不依赖 core.js，避免加载顺序耦合）
function transHash(str) {
    let h = 0;
    const s = String(str || "");
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h) + s.charCodeAt(i);
        h = h & h;
    }
    return "t" + Math.abs(h).toString(36) + "_" + s.length;
}

// ─── 接口层 ──────────────────────────────────────────────

// 微软 Edge 免费接口：POST JSON 数组批量翻译，返回 [{TranslatedText}]
async function edgeTranslateBatch(texts) {
    const body = texts.map(t => ({
        Text: t,
        LanguageDirection: { TargetLanguage: "zh-CN" },
    }));
    const res = await fetch("https://edge.microsoft.com/translate/trans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("edge " + res.status);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error("edge 格式");
    return data.map(d => (d && d.TranslatedText) || "");
}

// Google gtx 免费接口兜底：GET 逐条，响应 [[["译文","原文",...],...]]
async function gtxTranslateOne(text) {
    const url = "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q="
        + encodeURIComponent(text.slice(0, 800));
    const res = await fetch(url);
    if (!res.ok) throw new Error("gtx " + res.status);
    const data = await res.json();
    const segs = data && data[0];
    if (!Array.isArray(segs)) throw new Error("gtx 格式");
    return segs.map(s => (s && s[0]) || "").join("");
}

// 并发去重：同一文本在飞的翻译只发一次请求
const transInflight = new Map();

async function translateTexts(texts) {
    const out = {};
    const need = [];
    for (const t of texts) {
        const h = transHash(t);
        if (transCache[h]) { out[h] = transCache[h]; continue; }
        if (transInflight.has(h)) { need.push({ t, h, wait: transInflight.get(h) }); continue; }
        need.push({ t, h });
    }
    const fresh = need.filter(n => !n.wait);
    if (fresh.length > 0) {
        const job = (async () => {
            const map = {};
            // 每批 ≤ 16 条，避免单请求过大；Edge 批量失败时 gtx 逐条兜底
            for (let i = 0; i < fresh.length; i += 16) {
                const batch = fresh.slice(i, i + 16);
                let results = null;
                try {
                    results = await edgeTranslateBatch(batch.map(b => b.t));
                } catch (e) {
                    results = [];
                    for (const b of batch) {
                        try { results.push(await gtxTranslateOne(b.t)); }
                        catch (e2) { results.push(""); }
                    }
                }
                batch.forEach((b, j) => {
                    const tr = String(results[j] || "").trim();
                    if (tr) map[b.h] = tr;
                });
            }
            return map;
        })();
        fresh.forEach(n => transInflight.set(n.h, job));
        try {
            const map = await job;
            Object.assign(transCache, map);
            saveTransCache();
            Object.assign(out, map);
        } finally {
            fresh.forEach(n => transInflight.delete(n.h));
        }
    }
    // 等待同文本的在飞任务结果
    for (const n of need) {
        if (n.wait && !out[n.h]) {
            try {
                const map = await n.wait;
                if (map[n.h]) out[n.h] = map[n.h];
            } catch (e) { /* ignore */ }
        }
    }
    return out;
}

// ─── DOM 层：扫描卡片标题，异步替换为中文 ─────────────────
// 挂钩点：renderPagedList 渲染完成后调用（主页 / 单源 / 搜索 / 收藏统一覆盖）。
// 120ms debounce 合并同屏批量；单次最多处理 30 条，防止整页上百条打爆接口。

let transTimer = null;
function translateCardTitles(root) {
    if (!transEnabled || !root) return;
    clearTimeout(transTimer);
    transTimer = setTimeout(() => doTranslateCardTitles(root), 120);
}

async function doTranslateCardTitles(root) {
    if (!transEnabled) return;
    const nodes = [];
    const texts = [];
    root.querySelectorAll(".card-title").forEach(el => {
        if (el.dataset.translated === "1") return;
        // data-trans-src 保存原始纯文本（首次扫描时记录），翻译失败重扫时不再丢失
        const raw = el.dataset.transSrc || (el.textContent || "").trim();
        if (!raw || raw === "无标题" || isChineseText(raw)) {
            el.dataset.translated = "1";
            return;
        }
        el.dataset.transSrc = raw;
        nodes.push(el);
        texts.push(raw);
    });
    if (nodes.length === 0) return;
    const limit = Math.min(nodes.length, 30);
    const batchNodes = nodes.slice(0, limit);
    const batchTexts = texts.slice(0, limit);
    try {
        const map = await translateTexts(batchTexts);
        batchNodes.forEach((el, i) => {
            const zh = map[transHash(batchTexts[i])];
            if (!zh) return;
            // 译文替换显示，原文放入 title 属性（长按/hover 可见）
            el.innerHTML = escapeHtml(zh).replace(/@([A-Za-z0-9_一-龥]+)/g, '<span class="mention">@$1</span>');
            el.title = batchTexts[i];
            el.dataset.translated = "1";
        });
    } catch (e) { /* 接口全失败：静默保留原文 */ }
}

// ─── 开关 ────────────────────────────────────────────────

function toggleTranslate() {
    transEnabled = !transEnabled;
    localStorage.setItem(TRANS_ON_KEY, transEnabled ? "1" : "0");
    return transEnabled;
}

function isTranslateEnabled() {
    return transEnabled;
}
