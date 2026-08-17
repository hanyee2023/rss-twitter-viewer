
// 全局代理配置：RSS 拉取和媒体资源分开，避免两套逻辑互相影响。
// 多个代理会并发竞速（RSS）或级联回退（媒体），修改下面的端点列表即可。
const RSS_PROXY_ENDPOINTS = [
    "https://rss-twitter-viewer.pages.dev/rss-proxy",
    "https://rss-twitter-viewer.pages.dev/media-proxy"
];
const MEDIA_PROXY_ENDPOINTS = [
    "https://rss-twitter-viewer.pages.dev/media-proxy"
];

// 这些域名的 RSS 或媒体资源默认走代理。需要新增国外或特殊域名时，加到这里即可。
const FORCE_PROXY_HOSTS = [
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
    "video.3go.fun",
    "rsshub.app",
    "venexa.site",
    "aguea.com",
    "htumeng.com",
    "642p.com",
    "tutu1.space",
    "freeshare58.com"
];

function normalizeUrl(rawUrl) {
    return String(rawUrl || "").trim();
}

function cleanMediaUrl(rawUrl) {
    let url = fullDecodeXml(String(rawUrl || ""))
        .trim()
        .replace(/^<!\[CDATA\[/, "")
        .replace(/\]\]>$/, "")
        .replace(/^["'“”‘’]+|["'“”‘’，。,;；)）\]>]+$/g, "");
    url = url.replace(/\s+/g, " ");
    url = url.replace(/ /g, "%20");
    return url;
}

function getUrlCandidates(text, ext) {
    const source = fullDecodeXml(String(text || ""));
    const escapedExt = ext.replace(".", "\\.");
    const reg = new RegExp(`https?:\\/\\/[\\s\\S]{0,1200}?${escapedExt}(?:\\?[^<>"']*)?`, "gi");
    const list = [];
    let m;
    while((m = reg.exec(source)) !== null){
        let url = m[0];
        const httpIndex = url.lastIndexOf("http");
        if(httpIndex > 0) url = url.slice(httpIndex);
        url = url.replace(/<[^>]*$/g, "");
        url = url.replace(/\\s+(?=[a-zA-Z]+=|class=|style=|poster=|src=|href=|data-)/g, "");
        list.push(cleanMediaUrl(url));
    }
    return list.filter(Boolean);
}

function getUrlHost(rawUrl) {
    try {
        return new URL(normalizeUrl(rawUrl)).hostname.toLowerCase();
    } catch (e) {
        return "";
    }
}

function hostMatchesRule(host, rule) {
    const key = String(rule || "").toLowerCase().trim().replace(/\.+$/, "");
    if(!host || !key) return false;
    const cleanHost = String(host || "").toLowerCase().replace(/\.+$/, "");
    return cleanHost === key || cleanHost.endsWith("." + key);
}

function decodeMaybeUrl(str) {
    let value = String(str || "");
    for(let i = 0; i < 2; i++){
        try{
            const decoded = decodeURIComponent(value);
            if(decoded === value) break;
            value = decoded;
        }catch(e){
            break;
        }
    }
    return value;
}

function getEmbeddedHttpUrls(rawUrl) {
    const list = [];
    const addFromText = text => {
        const decoded = decodeMaybeUrl(text);
        const reg = /https?:\/\/[^<>"'\s&]+/gi;
        let m;
        while((m = reg.exec(decoded)) !== null){
            const candidate = cleanMediaUrl(m[0]);
            if(candidate && candidate !== normalizeUrl(rawUrl)) list.push(candidate);
        }
    };
    try{
        const u = new URL(normalizeUrl(rawUrl));
        u.searchParams.forEach(value => addFromText(value));
    }catch(e){}
    addFromText(rawUrl);
    return [...new Set(list)];
}

function hostMatched(rawUrl, hostList = FORCE_PROXY_HOSTS) {
    const url = normalizeUrl(rawUrl);
    const host = getUrlHost(url);
    if(hostList.some(rule => hostMatchesRule(host, rule))) return true;

    // 只额外识别参数里明确嵌套的完整 http/https 链接，避免 123.com/456.com/789.mp4 这种路径误判。
    return getEmbeddedHttpUrls(url).some(nestedUrl => {
        const nestedHost = getUrlHost(nestedUrl);
        return hostList.some(rule => hostMatchesRule(nestedHost, rule));
    });
}

function isHttpUrl(rawUrl) {
    return /^https?:\/\//i.test(normalizeUrl(rawUrl));
}

function buildProxyUrl(endpoint, rawUrl, extraParams = {}) {
    const u = new URL(endpoint);
    u.searchParams.set("url", normalizeUrl(rawUrl));
    Object.keys(extraParams).forEach(key => {
        if (extraParams[key] !== undefined && extraParams[key] !== null) {
            u.searchParams.set(key, extraParams[key]);
        }
    });
    return u.toString();
}

function getRSSProxyCandidates(rssUrl) {
    return RSS_PROXY_ENDPOINTS.map(endpoint => buildProxyUrl(endpoint, rssUrl));
}

function getMediaProxyCandidates(rawUrl, isFav = false) {
    const url = cleanMediaUrl(rawUrl);
    if (!isHttpUrl(url)) return [];
    if (!hostMatched(url)) return [];
    const params = { raw: "1" };
    if (isFav) params.cache = "long";
    return MEDIA_PROXY_ENDPOINTS.map(endpoint => buildProxyUrl(endpoint, url, params));
}

function getProxyUrl(rawUrl, isFav = false) {
    const url = cleanMediaUrl(rawUrl);
    if (!isHttpUrl(url)) return url;
    if (!hostMatched(url)) return url;
    const params = { raw: "1" };
    if (isFav) params.cache = "long";
    return buildProxyUrl(MEDIA_PROXY_ENDPOINTS[0], url, params);
}

function getProxyFallbacksAttr(rawUrl, isFav = false) {
    const candidates = getMediaProxyCandidates(rawUrl, isFav);
    const fallbacks = candidates.slice(1);
    if (fallbacks.length === 0) return "";
    return `data-proxy-fallbacks="${escapeAttr(JSON.stringify(fallbacks))}"`;
}

function fallbackMediaProxy(el) {
    const fallbacksStr = el.dataset.proxyFallbacks;
    if (!fallbacksStr) return false;
    try {
        const fallbacks = JSON.parse(fallbacksStr);
        let idx = parseInt(el.dataset.proxyIdx || "0", 10);
        idx++;
        if (idx < fallbacks.length) {
            el.dataset.proxyIdx = String(idx);
            el.src = fallbacks[idx];
            return true;
        }
    } catch (e) {}
    return false;
}

function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g,"&amp;")
               .replace(/</g,"&lt;")
               .replace(/>/g,"&gt;")
               .replace(/"/g,"&quot;")
               .replace(/'/g,"&#039;");
}

function escapeAttr(str) {
    return escapeHtml(str);
}

function fullDecodeXml(str){
    if(!str) return str;
    return str.replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,"\"")
    .replace(/&#039;/g,"'");
}

const FEED_KEY = "local_rss_feeds";
const FAV_KEY = "rss_fav_list";
const READ_KEY = "rss_read_links";
const ARTICLE_CACHE_KEY = "rss_article_cache";
const BLOCK_KEYWORD_KEY = "rss_block_keywords";
const LAST_REFRESH_KEY = "rss_last_refresh_time";
const PAGE_SIZE = 30;
const ARTICLE_CACHE_LIMIT = 800; // 全局文章缓存上限：原 600，提高到 800（约 2 天 @400条/天），localStorage 约 2-3MB 安全范围内
const FETCH_TIMEOUT = 10000;
const RSS_CONCURRENCY = 5;
const AUTO_REFRESH_INTERVAL = 5 * 60 * 1000;
const MANUAL_REFRESH_INTERVAL = 60 * 1000;
let feedList = JSON.parse(localStorage.getItem(FEED_KEY)) || [];
let favList = JSON.parse(localStorage.getItem(FAV_KEY)) || [];
let readLinkSet = new Set(JSON.parse(localStorage.getItem(READ_KEY)) || []);
let blockKeywordList = JSON.parse(localStorage.getItem(BLOCK_KEYWORD_KEY)) || [];
let sessionStartReadSet = new Set(readLinkSet);
let currentArticles = [];
let renderPageNum = 0;
let allArticles = [];
let scrollObserver = null;
let loadLock = false;
let currentPreviewImgs = [];
let videoObserver = null;
let preloadCount = 0;
const MAX_PRELOAD = 2;
let filterSourceUrl = "";
let localCacheArticles = [];
let hasNewUpdate = false;
let newArticleCount = 0;
let currentPage = null;        // 当前显示的页面 DOM，作为去重与快照的唯一依据（取代标题判重）
let currentArticleBox = null;  // 当前渲染用的文章容器：主页=articleBox，单源=articleBoxSingle
let homeScrollTop = 0;
let homeArticleHtml = "";
let homeIsCached = false;
let singleSourceUrl = "";      // 当前单源浏览的源 URL（用于单源界面内刷新/合并）
let readObserver = null;
let updateFloatTimer = null;
let lastRefreshTime = Number(localStorage.getItem(LAST_REFRESH_KEY)) || 0;
let rssRefreshPromise = null;
let renderedArticleCount = 0;

async function fetchTextWithTimeout(fetchUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
        const res = await fetch(fetchUrl, { signal: controller.signal, cache: "no-store" });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`请求失败(${res.status})`);
        let text = await res.text();
        return fullDecodeXml(text);
    } catch (err) {
        clearTimeout(timer);
        throw err;
    }
}

// 检查响应是否像 RSS/Atom XML，而不是 HTML 页面
function isRssContent(text){
    const sample = String(text || "").slice(0, 2000).toLowerCase();
    // RSS/Atom 标志
    if(sample.includes("<rss") || sample.includes("<feed") || 
       sample.includes("<channel") || sample.includes("<rdf:rdf")){
        return true;
    }
    // 明显是 HTML
    if(sample.includes("<!doctype html") || sample.includes("<html")){
        return false;
    }
    // 有 <item> 或 <entry> 标签
    if(/<(item|entry)[\s>]/i.test(sample)) return true;
    return false;
}

async function fetchRSSFeed(rssUrl) {
    const url = normalizeUrl(rssUrl);
    if (!isHttpUrl(url)) throw new Error("RSS 链接格式不正确");

    const candidates = hostMatched(url)
        ? getRSSProxyCandidates(url)
        : [url];

    // 级联回退：依次尝试每个代理端点，第一个失败才试下一个，避免同时请求浪费配额
    let lastErr = null;
    for(const candidate of candidates){
        try{
            const text = await fetchTextWithTimeout(candidate);
            if(isRssContent(text)){
                return text;
            }else{
                console.warn("RSS 代理返回了非 RSS 内容：", candidate);
                lastErr = new Error("代理返回了无效内容");
            }
        }catch(err){
            console.warn("RSS 拉取失败：", candidate, err.message);
            lastErr = err;
        }
    }
    throw lastErr || new Error("RSS 拉取失败");
}

function exportJsonFile(jsonData, fileName = "rss订阅备份.json") {
    try {
        const jsonStr = JSON.stringify(jsonData, null, 2);
        const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(blobUrl);
    } catch (e) {
        const jsonStr = JSON.stringify(jsonData, null, 2);
        const base64 = btoa(unescape(encodeURIComponent(jsonStr)));
        const dataUrl = `data:application/json;base64,${base64}`;
        const a2 = document.createElement("a");
        a2.href = dataUrl;
        a2.download = fileName;
        document.body.appendChild(a2);
        a2.click();
        a2.remove();
    }
}

const pageHome = document.getElementById("pageHome");
const pageManage = document.getElementById("pageManage");
const pageAdd = document.getElementById("pageAdd");
const pageFav = document.getElementById("pageFav");
const pageSearch = document.getElementById("pageSearch");
const pageSingle = document.getElementById("pageSingle");

const articleBox = document.getElementById("articleBox");
const articleBoxSingle = document.getElementById("articleBoxSingle");
currentArticleBox = articleBox; // 默认渲染目标=主页容器
const feedPanel = document.getElementById("feedPanel");
const favPanel = document.getElementById("favPanel");
const searchResultBox = document.getElementById("searchResultBox");
const searchInput = document.getElementById("searchInput");

const btnHome = document.getElementById("btnHome");
const btnManage = document.getElementById("btnManage");
const btnAdd = document.getElementById("btnAdd");
const btnFav = document.getElementById("btnFav");
const btnSearch = document.getElementById("btnSearch");

const pageTitle = document.getElementById("pageTitle");
let allBtns = [btnHome, btnManage, btnAdd, btnFav, btnSearch];

const editModal = document.getElementById("editModal");
const imgPreviewMask = document.getElementById("imgPreviewMask");
const previewWrap = document.getElementById("previewWrap");
const previewTip = document.getElementById("previewTip");
const previewClose = document.getElementById("previewClose");
const toastDom = document.getElementById("slideTip");
const mainWrap = document.querySelector(".main-wrap");
let readScrollTimer = null;

mainWrap.addEventListener("scroll", ()=>{
    if(readScrollTimer) return;
    readScrollTimer = setTimeout(()=>{
        readScrollTimer = null;
        markReadByScroll();
    }, 120);
});
window.addEventListener("beforeunload", markReadByScroll);

function showToast(msg){
    toastDom.innerText = msg;
    toastDom.style.display = "block";
    setTimeout(()=>toastDom.style.display = "none",1500);
}

function showUpdateFloat(message, onClick){
    const old = document.getElementById("updateFloatBar");
    if(old) old.remove();
    if(updateFloatTimer) clearTimeout(updateFloatTimer);
    const bar = document.createElement("div");
    bar.id = "updateFloatBar";
    bar.className = "update-float-bar";
    bar.innerText = message;
    if(onClick) bar.onclick = onClick;
    document.body.appendChild(bar);
    updateFloatTimer = setTimeout(()=>bar.remove(), 10000);
}

function saveReadLinks(){
    try{
        // 已读记录超过 2000 条时，只保留最近 2000 条，防止无限增长撑爆 localStorage
        const arr = [...readLinkSet];
        if(arr.length > 2000){
            const trimmed = arr.slice(arr.length - 2000);
            readLinkSet = new Set(trimmed);
        }
        localStorage.setItem(READ_KEY, JSON.stringify([...readLinkSet]));
    }catch(e){
        console.warn("保存已读记录失败：", e.message);
    }
}

function markCardRead(card){
    const link = card && card.dataset ? card.dataset.link : "";
    if(!link || readLinkSet.has(link)) return;
    readLinkSet.add(link);
    saveReadLinks();
}

function markReadByScroll(){
    if(currentPage !== pageHome) return;
    const lineY = mainWrap.getBoundingClientRect().top + 56;
    let changed = false;
    articleBox.querySelectorAll(".tweet-card").forEach(card=>{
        const link = card.dataset.link;
        if(!link || readLinkSet.has(link)) return;
        if(card.getBoundingClientRect().bottom < lineY){
            readLinkSet.add(link);
            changed = true;
        }
    });
    if(changed) saveReadLinks();
}

function loadArticleCacheFromStorage(){
    try{
        const cache = JSON.parse(localStorage.getItem(ARTICLE_CACHE_KEY) || "[]");
        if(Array.isArray(cache)){
            allArticles = cache;
            localCacheArticles = [...cache];
            return cache.length;
        }
    }catch(e){
        console.warn("读取本地文章缓存失败：", e);
    }
    return 0;
}

function saveArticleCacheToStorage(list){
    const trySave = (limit) => {
        try{
            const slimList = (list || []).slice(0, limit);
            localStorage.setItem(ARTICLE_CACHE_KEY, JSON.stringify(slimList));
            return true;
        }catch(e){
            return false;
        }
    };
    // 逐步降级：600 → 300 → 150 → 50 → 放弃
    const levels = [ARTICLE_CACHE_LIMIT, 300, 150, 50];
    for(const limit of levels){
        if(trySave(limit)) return;
    }
    // 全部失败，清理旧的 RSS 源缓存腾出空间后最后试一次
    cleanExpiredRssCache();
    if(!trySave(50)){
        console.warn("保存文章缓存失败：localStorage 容量不足，已尝试降级");
    }
}

// 清理过期的 RSS 源缓存，腾出 localStorage 空间
function cleanExpiredRssCache(){
    const now = Date.now();
    const keysToRemove = [];
    for(let i = 0; i < localStorage.length; i++){
        const key = localStorage.key(i);
        if(key && key.startsWith(RSS_CACHE_PREFIX)){
            try{
                const data = JSON.parse(localStorage.getItem(key));
                if(data && data.time && now - data.time > RSS_CACHE_TTL){
                    keysToRemove.push(key);
                }
            }catch(e){
                keysToRemove.push(key); // 解析失败也清理
            }
        }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
}

function hasBlockedKeyword(title){
    if(!blockKeywordList || blockKeywordList.length === 0) return false;
    const titleLower = (title || "").toLowerCase();
    return blockKeywordList.some(kw => kw && titleLower.includes(kw.toLowerCase()));
}

function getVisibleHomeArticles(list){
    if(filterSourceUrl) return list.filter(item => !hasBlockedKeyword(getPureText(item.title)));
    return list.filter(item => !sessionStartReadSet.has(item.link) && !hasBlockedKeyword(getPureText(item.title)));
}

function shareIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="M8.59 13.51 15.42 17.49"></path><path d="M15.41 6.51 8.59 10.49"></path></svg>`;
}

function favIconSvg(filled = false){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${filled ? "currentColor" : "none"}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
}

function viewIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
}

function editIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"></path></svg>`;
}

function trashIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>`;
}

function playIconSvg(){
    return `<svg class="fill-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"></path></svg>`;
}

function pauseIconSvg(){
    return `<svg class="fill-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M7 5h4v14H7z"></path><path d="M13 5h4v14h-4z"></path></svg>`;
}

function volumeIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"></path><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;
}

function muteIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"></path><path d="m23 9-6 6"></path><path d="m17 9 6 6"></path></svg>`;
}

function fullscreenIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"></path><path d="M21 8V5a2 2 0 0 0-2-2h-3"></path><path d="M3 16v3a2 2 0 0 0 2 2h3"></path><path d="M16 21h3a2 2 0 0 0 2-2v-3"></path></svg>`;
}
function exitFullscreenIconSvg(){
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3v3a2 2 0 0 1-2 2H3"></path><path d="M21 8h-3a2 2 0 0 1-2-2V3"></path><path d="M3 16h3a2 2 0 0 1 2 2v3"></path><path d="M16 21v-3a2 2 0 0 1 2-2h3"></path></svg>`;
}

function mediaControlsHtml(){
    return `<div class="custom-media-controls">
        <button class="media-control-btn media-play-btn" type="button" aria-label="播放">${playIconSvg()}</button>
        <input class="media-progress" type="range" min="0" max="1000" value="0" step="1" aria-label="播放进度">
        <span class="media-time">00:00</span>
        <button class="media-control-btn media-mute-btn" type="button" aria-label="静音">${volumeIconSvg()}</button>
        <button class="media-control-btn media-fullscreen-btn" type="button" aria-label="全屏">${fullscreenIconSvg()}</button>
    </div>`;
}

function hashText(str){
    const text = String(str || "");
    let hash1 = 5381;
    let hash2 = 0;
    for(let i = 0; i < text.length; i++){
        const ch = text.charCodeAt(i);
        hash1 = ((hash1 << 5) + hash1) ^ ch;
        hash2 = (hash2 * 33) ^ ch;
    }
    return Math.abs((hash1 >>> 0) + (hash2 >>> 0));
}

function avatarIconSvg(index){
    // 基于 hash 值确定性生成独特几何图案，理论上可产生数千种不同组合
    let s = Math.abs(index >>> 0) || 1;
    function next(){
        s = (s * 1664525 + 1013904223) | 0;
        return (s >>> 0) / 0x100000000;
    }
    const nextInt = (min, max) => Math.floor(next() * (max - min + 1)) + min;

    const elements = [];
    const layout = nextInt(0, 7);

    // 所有图案共享一个 SVG viewBox="0 0 24 24"
    if(layout === 0){
        // 3x3 点阵 + 外框
        const shape = nextInt(0, 2);
        if(shape === 0) elements.push(`<rect x="2" y="2" width="20" height="20" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        else if(shape === 1) elements.push(`<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        else elements.push(`<polygon points="12,2 21,7 21,17 12,22 3,17 3,7" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        for(let r = 0; r < 3; r++){
            for(let c = 0; c < 3; c++){
                if(next() > 0.45){
                    const dot = nextInt(0, 2);
                    const cx = 5 + c * 7, cy = 5 + r * 7;
                    if(dot === 0) elements.push(`<circle cx="${cx}" cy="${cy}" r="2" fill="currentColor"/>`);
                    else if(dot === 1) elements.push(`<rect x="${cx-1.5}" y="${cy-1.5}" width="3" height="3" rx="0.5" fill="currentColor"/>`);
                    else elements.push(`<polygon points="${cx},${cy-1.5} ${cx+1.5},${cy} ${cx},${cy+1.5} ${cx-1.5},${cy}" fill="currentColor"/>`);
                }
            }
        }
    }else if(layout === 1){
        // 双层同心形状
        const outer = nextInt(0, 2);
        if(outer === 0) elements.push(`<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        else if(outer === 1) elements.push(`<rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        else elements.push(`<polygon points="12,3 20,8 20,16 12,21 4,16 4,8" fill="none" stroke="currentColor" stroke-width="1.5"/>`);
        const inner = nextInt(0, 3);
        if(inner === 0) elements.push(`<circle cx="12" cy="12" r="3" fill="currentColor"/>`);
        else if(inner === 1) elements.push(`<rect x="9" y="9" width="6" height="6" rx="1" fill="currentColor"/>`);
        else if(inner === 2) elements.push(`<polygon points="12,8 16,12 12,16 8,12" fill="currentColor"/>`);
        else elements.push(`<path d="M9,12 Q12,7 15,12 Q12,17 9,12" fill="currentColor"/>`);
    }else if(layout === 2){
        // 对角线条纹 + 点缀
        const angle = nextInt(0, 1);
        if(angle === 0){
            elements.push(`<line x1="4" y1="20" x2="20" y2="4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
            if(next() > 0.4) elements.push(`<line x1="2" y1="14" x2="10" y2="6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
            if(next() > 0.4) elements.push(`<line x1="14" y1="18" x2="22" y2="10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
        }else{
            elements.push(`<line x1="4" y1="4" x2="20" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
            if(next() > 0.4) elements.push(`<line x1="10" y1="2" x2="22" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
            if(next() > 0.4) elements.push(`<line x1="2" y1="10" x2="14" y2="22" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
        }
        const dotCount = nextInt(1, 4);
        for(let i = 0; i < dotCount; i++){
            const dx = nextInt(3, 21), dy = nextInt(3, 21);
            elements.push(`<circle cx="${dx}" cy="${dy}" r="${nextInt(1, 2)}" fill="currentColor"/>`);
        }
    }else if(layout === 3){
        // 折线 + 端点
        const midX = nextInt(6, 18), midY = nextInt(6, 18);
        elements.push(`<polyline points="${nextInt(2,6)},${nextInt(2,6)} ${midX},${midY} ${nextInt(18,22)},${nextInt(18,22)}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
        elements.push(`<circle cx="${midX}" cy="${midY}" r="2" fill="currentColor"/>`);
        if(next() > 0.5){
            elements.push(`<circle cx="${nextInt(2,10)}" cy="${nextInt(14,22)}" r="1.5" fill="currentColor"/>`);
        }
        if(next() > 0.5){
            elements.push(`<circle cx="${nextInt(14,22)}" cy="${nextInt(2,10)}" r="1.5" fill="currentColor"/>`);
        }
    }else if(layout === 4){
        // 上下对称 + 中间
        const top = nextInt(0, 2);
        if(top === 0) elements.push(`<path d="M6,8 Q12,2 18,8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        else if(top === 1) elements.push(`<polyline points="2,8 12,3 22,8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
        else elements.push(`<line x1="4" y1="8" x2="20" y2="8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        const bottom = nextInt(0, 2);
        if(bottom === 0) elements.push(`<path d="M6,16 Q12,22 18,16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        else if(bottom === 1) elements.push(`<polyline points="2,16 12,21 22,16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`);
        else elements.push(`<line x1="4" y1="16" x2="20" y2="16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        const mid = nextInt(0, 3);
        if(mid === 0) elements.push(`<circle cx="12" cy="12" r="2" fill="currentColor"/>`);
        else if(mid === 1) elements.push(`<rect x="10" y="10" width="4" height="4" rx="0.5" fill="currentColor"/>`);
        else if(mid === 2) elements.push(`<polygon points="12,9 15,12 12,15 9,12" fill="currentColor"/>`);
        else elements.push(`<path d="M10,12 h4 M12,10 v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
    }else if(layout === 5){
        // 放射状/太阳状
        const rays = nextInt(4, 8);
        const r = nextInt(7, 9);
        for(let i = 0; i < rays; i++){
            const a = (i / rays) * Math.PI * 2;
            const x1 = 12 + Math.cos(a) * 4, y1 = 12 + Math.sin(a) * 4;
            const x2 = 12 + Math.cos(a) * r, y2 = 12 + Math.sin(a) * r;
            elements.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
        }
        elements.push(`<circle cx="12" cy="12" r="3" fill="currentColor"/>`);
    }else if(layout === 6){
        // 十字 + 角标
        elements.push(`<line x1="12" y1="4" x2="12" y2="20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        elements.push(`<line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        const corners = nextInt(1, 4);
        const cornerPos = [
            [4, 4], [20, 4], [4, 20], [20, 20]
        ];
        const used = new Set();
        for(let i = 0; i < corners; i++){
            let ci;
            do{ ci = nextInt(0, 3); }while(used.has(ci));
            used.add(ci);
            const [cx, cy] = cornerPos[ci];
            const ct = nextInt(0, 2);
            if(ct === 0) elements.push(`<circle cx="${cx}" cy="${cy}" r="2" fill="currentColor"/>`);
            else if(ct === 1) elements.push(`<rect x="${cx-2}" y="${cy-2}" width="4" height="4" rx="0.5" fill="currentColor"/>`);
            else elements.push(`<polygon points="${cx},${cy-2} ${cx+2},${cy} ${cx},${cy+2} ${cx-2},${cy}" fill="currentColor"/>`);
        }
    }else if(layout === 7){
        // 弧形 + 浮动圆点
        const arcDir = nextInt(0, 3);
        if(arcDir === 0) elements.push(`<path d="M4,18 Q12,4 20,18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        else if(arcDir === 1) elements.push(`<path d="M4,6 Q12,20 20,6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        else if(arcDir === 2) elements.push(`<path d="M4,4 Q20,12 4,20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        else elements.push(`<path d="M20,4 Q4,12 20,20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>`);
        const dots = nextInt(2, 5);
        for(let i = 0; i < dots; i++){
            const dx = nextInt(4, 20), dy = nextInt(4, 20);
            elements.push(`<circle cx="${dx}" cy="${dy}" r="${nextInt(1, 2)}" fill="currentColor"/>`);
        }
    }

    return `<svg viewBox="0 0 24 24">${elements.join('')}</svg>`;
}

function getAvatarStyle(key){
    const gradients = [
        "linear-gradient(135deg,#667eea,#764ba2)",
        "linear-gradient(135deg,#ff7e5f,#feb47b)",
        "linear-gradient(135deg,#00c6ff,#0072ff)",
        "linear-gradient(135deg,#43cea2,#185a9d)",
        "linear-gradient(135deg,#f093fb,#f5576c)",
        "linear-gradient(135deg,#4facfe,#00f2fe)",
        "linear-gradient(135deg,#fa709a,#fee140)",
        "linear-gradient(135deg,#30cfd0,#330867)",
        "linear-gradient(135deg,#a8edea,#fed6e3)",
        "linear-gradient(135deg,#ff9a9e,#fecfef)",
        "linear-gradient(135deg,#fccb90,#d57eeb)",
        "linear-gradient(135deg,#e0c3fc,#8ec5fc)",
        "linear-gradient(135deg,#f5576c,#ff6a88)",
        "linear-gradient(135deg,#96fbc4,#f9f586)",
        "linear-gradient(135deg,#fcb69f,#ffecd2)",
        "linear-gradient(135deg,#a18cd1,#fbc2eb)",
        "linear-gradient(135deg,#fad0c4,#ffd1ff)",
        "linear-gradient(135deg,#ffecd2,#fcb69f)",
        "linear-gradient(135deg,#89f7fe,#66a6ff)",
        "linear-gradient(135deg,#fddb92,#d1fdff)",
        "linear-gradient(135deg,#c471f5,#fa71cd)",
        "linear-gradient(135deg,#11998e,#38ef7d)",
        "linear-gradient(135deg,#ee9ca7,#ffdde1)",
        "linear-gradient(135deg,#76b2fe,#b69efe)",
        "linear-gradient(135deg,#f53844,#42378f)",
        "linear-gradient(135deg,#3b82f6,#8b5cf6)",
        "linear-gradient(135deg,#f97316,#f59e0b)",
        "linear-gradient(135deg,#10b981,#34d399)",
        "linear-gradient(135deg,#ec4899,#f472b6)",
        "linear-gradient(135deg,#6366f1,#a78bfa)",
        "linear-gradient(135deg,#14b8a6,#2dd4bf)",
        "linear-gradient(135deg,#e11d48,#fb7185)",
        "linear-gradient(135deg,#7c3aed,#c084fc)",
        "linear-gradient(135deg,#f59e0b,#fbbf24)",
        "linear-gradient(135deg,#059669,#6ee7b7)",
        "linear-gradient(135deg,#d97706,#fcd34d)",
        "linear-gradient(135deg,#9333ea,#d8b4fe)",
        "linear-gradient(135deg,#0ea5e9,#38bdf8)",
        "linear-gradient(135deg,#db2777,#f9a8d4)",
        "linear-gradient(135deg,#2563eb,#60a5fa)",
    ];
    return gradients[hashText(key) % gradients.length];
}

// 当前在视口内的视频集合（用于播放停止后恢复附近视频的预加载）
const _visibleVideos = new Set();

