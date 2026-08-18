// ===== feed.js (从 index.html 拆出) =====
// 从 RSS 文本提取 <channel> 级别的 <description>（后端在抓取失败时写入诊断原因）
function extractChannelDesc(xml) {
  try {
    const m = xml.match(/<channel>[\s\S]*?<description>([\s\S]*?)<\/description>/i);
    return m ? fullDecodeXml(m[1]).trim() : "";
  } catch (e) {
    return "";
  }
}

// 页面状态机：主页/搜索/添加订阅/管理订阅/收藏 各为独立标签界面，单源浏览再独立成一个界面。
// 去重与快照一律以【页面 DOM】(currentPage) 为依据，不再依赖标题字符串，
// 这样单源视图（标题=订阅名）与主页（标题=“RSS媒体阅读器”）不会再被当成同一个界面而相互污染。
function showPage(targetDom, titleText) {
    // 去重：当前已在该页面则直接返回（主页重复点击交给 btnHome 的更新提示逻辑处理）
    if (currentPage === targetDom) {
        return;
    }

    // 离开【主页】时记录快照（滚动位置 + HTML），返回时恢复到上次阅读位置
    const leavingHome = (currentPage === pageHome);
    if (leavingHome) {
        markReadByScroll();
        homeScrollTop = mainWrap.scrollTop;
        homeArticleHtml = articleBox.innerHTML;
        homeIsCached = true;
        // 离开首页时断开已读观察器，避免非首页卡片被误标记已读
        if(readObserver){
            readObserver.disconnect();
            readObserver = null;
        }
    }

    pageHome.style.display = "none";
    pageManage.style.display = "none";
    pageAdd.style.display = "none";
    pageFav.style.display = "none";
    pageSearch.style.display = "none";
    pageSingle.style.display = "none";

    feedPanel.innerHTML = "";
    favPanel.innerHTML = "";

    targetDom.style.display = "block";
    currentPage = targetDom;
    // 非主页界面进入时滚动到顶部（主页由下方快照/渲染自行决定）
    if (targetDom !== pageHome) {
        mainWrap.scrollTop = 0;
    }

    const textNode = Array.from(pageTitle.childNodes).find(n => n.nodeType === 3);
    if (textNode) {
        textNode.textContent = titleText;
    }

    allBtns.forEach(b => b.classList.remove("active"));
    if (targetDom === pageHome) btnHome.classList.add("active");
    else if (targetDom === pageManage) btnManage.classList.add("active");
    else if (targetDom === pageAdd) btnAdd.classList.add("active");
    else if (targetDom === pageFav) btnFav.classList.add("active");
    else if (targetDom === pageSearch) btnSearch.classList.add("active");
    // 单源界面不属于任一底部固定 tab，不高亮

    if (targetDom === pageHome) {
        // 恢复到【完整主页】：优先用快照（保留上次滚动位置），否则重新渲染
        if (homeIsCached && homeArticleHtml) {
            currentArticleBox = articleBox;
            articleBox.innerHTML = homeArticleHtml;
            // 关键修复：innerHTML 恢复不会保留事件监听器，但会保留 data-* 绑定标记。
            // 若不清除，initHlsVideo/bindCustomMediaControls 会因“已绑定”而跳过，
            // 导致主页视频（离开再回来后）点击无反应、播放按钮不变。
            articleBox.querySelectorAll(".media-video, .media-video-mp4, .video-single-wrap").forEach(el => {
                el.removeAttribute("data-player-bind");
                el.removeAttribute("data-control-bind");
                el.removeAttribute("data-media-click-bind");
            });
            const restoreHomeScroll = ()=>{
                mainWrap.scrollTop = homeScrollTop;
                requestAnimationFrame(()=>{ mainWrap.scrollTop = homeScrollTop; });
            };
            setTimeout(restoreHomeScroll, 0);
            setTimeout(restoreHomeScroll, 80);
            setTimeout(restoreHomeScroll, 250);
            bindAllCardEvent();
            bindVideoPauseObserver();
            initHlsVideo();
            bindScrollLoadMore();
            if(window.updateUnreadBadge) window.updateUnreadBadge();
            // 切回主页时做轻量本地更新检测（不重复拉网络）：单源/后台刷新已更新 localCacheArticles，
            // 若其中有「主页快照未渲染过 + 未读」的新条目，弹「更新N条」浮条引导点击查看。
            promptHomeUpdateIfAny();
            return;
        }
        renderHomeFromCache();
    } else if (targetDom === pageSingle) {
        currentArticleBox = articleBoxSingle; // 单源渲染目标指向独立容器
    } else if (targetDom === pageManage) {
        renderManage();
    } else if (targetDom === pageFav) {
        renderFav();
    } else if (targetDom === pageSearch) {
        searchInput.value = "";
        searchResultBox.innerHTML = "";
    } else if (targetDom === pageAdd) {
        renderKeywordList();
    }
    // 切到任意界面后统一刷新未读角标（管理订阅/收藏等也即时反映未读数变化）
    if(window.updateUnreadBadge) window.updateUnreadBadge();
}

// 切回主页时的轻量本地更新检测：用本地缓存对比主页快照已渲染的 link 集合，
// 若存在「未读 + 主页未渲染」的新条目，则弹「更新N条」浮条（沿用 showHomeFresh 回到顶部加载）。
// 不重复拉网络（单源/后台刷新已更新 localCacheArticles），仅做提示引导。
// 注意：仅在 showPage 主页「恢复快照」分支调用（即"从其它界面切回主页"时），所以无需判断 currentPage。
function promptHomeUpdateIfAny(){
    const renderedLinks = new Set();
    articleBox.querySelectorAll(".tweet-card").forEach(c=>{
        if(c.dataset.link) renderedLinks.add(c.dataset.link);
    });
    const fresh = (localCacheArticles || []).filter(item =>
        item && item.link &&
        !sessionStartReadSet.has(item.link) &&
        !readLinkSet.has(item.link) &&
        !renderedLinks.has(item.link)
    );
    if(fresh.length > 0){
        showUpdateFloat(`更新${fresh.length}条内容，点击查看`, ()=>{
            filterSourceUrl = "";
            homeIsCached = false;
            homeArticleHtml = "";
            renderedArticleCount = 0;
            showHomeFresh();
        });
    }
}

btnHome.onclick = async () => {
    if (currentPage === pageHome) {
        // 已在主页：触发更新检查与提示
        await checkAndPromptUpdate(true);
        return;
    }
    // 从任意其它界面（含单源）点主页：恢复到主页上次离开的位置
    showPage(pageHome, "RSS媒体阅读器");
};

// 进入单源浏览：作为独立的第 6 个界面展示，完全不触碰主页的 articleBox / 状态
async function openSingleSource(sourceUrl){
    const feed = feedList.find(f => String(f.url).trim() === String(sourceUrl).trim());
    const title = feed ? feed.name : "单源订阅";
    if (currentPage === pageSingle) {
        // 已在单源界面，只是切换不同源：直接重渲染（不走 showPage 去重，因为容器相同）
        await renderSingleFeedFromSource(sourceUrl);
        const textNode = Array.from(pageTitle.childNodes).find(n => n.nodeType === 3);
        if (textNode) textNode.textContent = title;
        return;
    }
    showPage(pageSingle, title);
    await renderSingleFeedFromSource(sourceUrl);
}

// 强制回到主页并渲染最新内容（用于「点击查看更新」浮条，无论当前在哪个界面）
function showHomeFresh(){
    if (currentPage !== pageHome) {
        pageHome.style.display = "block";
        pageManage.style.display = "none";
        pageAdd.style.display = "none";
        pageFav.style.display = "none";
        pageSearch.style.display = "none";
        pageSingle.style.display = "none";
        currentPage = pageHome;
        allBtns.forEach(b => b.classList.remove("active"));
        btnHome.classList.add("active");
        const textNode = Array.from(pageTitle.childNodes).find(n => n.nodeType === 3);
        if (textNode) textNode.textContent = "RSS媒体阅读器";
    }
    homeIsCached = false;
    homeArticleHtml = "";
    renderHomeFromCache();
    const toTop = ()=>{
        mainWrap.scrollTop = 0;
        requestAnimationFrame(()=>{ mainWrap.scrollTop = 0; });
    };
    toTop();
    setTimeout(toTop, 80);
    setTimeout(toTop, 250);
    const bar = document.getElementById("updateFloatBar");
    if(bar) bar.remove();
}
btnManage.onclick = () => showPage(pageManage, "管理订阅");
btnAdd.onclick = () => showPage(pageAdd, "添加订阅");
btnFav.onclick = () => showPage(pageFav, "我的收藏");
btnSearch.onclick = () => showPage(pageSearch, "内容搜索");

async function refreshAllRSSWithLock(){
    if(rssRefreshPromise) return rssRefreshPromise;
    rssRefreshPromise = (async ()=>{
        const data = await loadAllRSS();
        const cacheData = data.slice(0, ARTICLE_CACHE_LIMIT);
        allArticles = cacheData;
        localCacheArticles = [...cacheData];
        saveArticleCacheToStorage(cacheData);
        lastRefreshTime = Date.now();
        localStorage.setItem(LAST_REFRESH_KEY, String(lastRefreshTime));
        return cacheData;
    })();
    try{
        return await rssRefreshPromise;
    }finally{
        rssRefreshPromise = null;
    }
}

async function checkAndPromptUpdate(isManual = false){
    if(feedList.length === 0) return;
    if(rssRefreshPromise){
        showUpdateFloat("正在检查更新，请稍候");
        return;
    }
    const now = Date.now();
    const hour = new Date().getHours();
    const isEvening = hour >= 21 || hour < 6;
    const baseInterval = isManual ? MANUAL_REFRESH_INTERVAL : AUTO_REFRESH_INTERVAL;
    const minInterval = isEvening && !isManual ? baseInterval * 6 : baseInterval;
    if(lastRefreshTime && now - lastRefreshTime < minInterval){
        if(isManual) showUpdateFloat("刚刚检查过，稍后再试");
        return;
    }
    const oldLinkSet = new Set(localCacheArticles.map(i=>i.link));
    let newAll = [];
    try{
        newAll = await refreshAllRSSWithLock();
    }catch(err){
        console.warn("检查更新失败：", err);
        if(isManual) showUpdateFloat("检查更新失败，请稍后重试");
        return;
    }
    const visibleNewList = filterPureTextTwitter(newAll.filter(item => !oldLinkSet.has(item.link) && !sessionStartReadSet.has(item.link)));
    const newCount = visibleNewList.length;
    if(newCount > 0){
        showUpdateFloat(`更新${newCount}条内容，点击查看`, ()=>{
            filterSourceUrl = "";
            homeIsCached = false;
            homeArticleHtml = "";
            renderedArticleCount = 0;
            allArticles = [...newAll];
            localCacheArticles = [...newAll];
            saveArticleCacheToStorage(newAll);
            showHomeFresh();
        });
    }else if(isManual){
        showUpdateFloat("暂无更新内容");
    }
}

async function initLoadAllCache() {
    const cacheCount = loadArticleCacheFromStorage();
    if(cacheCount > 0){
        renderHomeFromCache();
    }
    if(feedList.length === 0) return;
    if(cacheCount === 0){
        try{
            await refreshAllRSSWithLock();
            renderHomeFromCache();
        }catch(e){
            console.warn("初始化加载失败",e);
        }
    }else{
        checkAndPromptUpdate(false);
    }
}

function renderHomeFromCache() {
    if(scrollObserver) scrollObserver.disconnect();
    currentArticleBox = articleBox; // 主页渲染目标
    renderPageNum = 0;
    renderedArticleCount = 0;
    loadLock = false;
    if(localCacheArticles.length === 0) {
        articleBox.innerHTML = `<div class="empty-tip">暂无文章内容</div>`;
        return;
    }
    const visibleArticles = getVisibleHomeArticles(localCacheArticles);

    currentArticles = [...visibleArticles];
    renderPageNum = 1;
    renderPagedList(true);
    bindScrollLoadMore();
    if(window.updateUnreadBadge) window.updateUnreadBadge();
}

async function renderSingleFeedFromSource(sourceUrl){
    if(scrollObserver) scrollObserver.disconnect();
    currentArticleBox = articleBoxSingle; // 单源视图使用独立容器，绝不污染主页
    singleSourceUrl = String(sourceUrl || "").trim();
    const feed = feedList.find(f => String(f.url).trim() === singleSourceUrl);
    const fallbackList = filterPureTextTwitter(localCacheArticles.filter(item => item.sourceUrl.trim() === singleSourceUrl));
    // 先渲染本地缓存（主页已加载的数据），实现「切换即见」，随后后台静默刷新覆盖
    if(fallbackList.length > 0){
        currentArticles = [...fallbackList];
        renderPageNum = 1;
        renderedArticleCount = 0;
        loadLock = false;
        renderPagedList(true);
        bindScrollLoadMore();
        showToast("正在后台刷新该订阅…");
    }else{
        articleBoxSingle.innerHTML = `<div class="empty-tip">正在加载该订阅内容...</div>`;
    }
    try{
        const xmlText = await fetchRSSFeed(sourceUrl);
        const parsed = parseRSS(xmlText, feed ? feed.name : "未命名订阅", sourceUrl, feed ? feed.category : "img")
            .sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime());
        const list = filterPureTextTwitter(parsed);
        if(list.length > 0){
            currentArticles = list;
            // 保存缓存
            saveRssCache(sourceUrl, list);
            const merged = [...list, ...localCacheArticles.filter(item => item.sourceUrl.trim() !== String(sourceUrl).trim())]
                .sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime())
                .slice(0, ARTICLE_CACHE_LIMIT);
            localCacheArticles = merged;
            allArticles = [...merged];
            saveArticleCacheToStorage(merged);
            renderPageNum = 1;
            renderedArticleCount = 0;
            loadLock = false;
            renderPagedList(true);
            bindScrollLoadMore();
        }else{
            // 解析为空：已有缓存则保留，无需重绘
            const cache = getRssCache(sourceUrl);
            if(fallbackList.length === 0 && (!cache || !cache.items || cache.items.length === 0)){
                // 显示后端透传的诊断原因（哪个实例失败/验证页/超时），不再静默“无内容”
                const diag = extractChannelDesc(xmlText);
                const tip = document.createElement('div');
                tip.className = 'empty-tip';
                tip.textContent = diag ? `该订阅暂未解析到内容：${diag}` : '该订阅暂未解析到内容';
                articleBoxSingle.innerHTML = '';
                articleBoxSingle.appendChild(tip);
            }
        }
    }catch(err){
        console.warn("单订阅加载失败：", err);
        const errDesc = describeRssError(err);
        // 已有本地缓存则保留显示，仅提示后台刷新失败
        if(fallbackList.length > 0){
            showToast("后台刷新失败，仍显示本地缓存：" + errDesc);
        }else{
            const cache = getRssCache(sourceUrl);
            if(cache && cache.items && cache.items.length > 0){
                currentArticles = filterPureTextTwitter(cache.items);
                showToast("订阅加载失败，已回退至本地缓存：" + errDesc);
                renderPageNum = 1; renderedArticleCount = 0; loadLock = false;
                renderPagedList(true); bindScrollLoadMore();
            }else{
                articleBoxSingle.innerHTML = `<div class="empty-tip">该订阅加载失败：${errDesc}</div>`;
            }
        }
    }
}

window.mergeNewData = async function(){
    if(scrollObserver) scrollObserver.disconnect();
    const fresh = filterPureTextTwitter(await loadAllRSS());
    // 累积合并：保留本地缓存中「本次刷新未返回」的旧条目（按 link 去重），
    // 避免 twitter 源（每源仅返回最新 N 条）刷新后，更早的未读内容被整批清除。
    const freshLinks = new Set(fresh.map(i => i.link));
    const oldKept = localCacheArticles.filter(i => i.link && !freshLinks.has(i.link));
    const merged = filterPureTextTwitter([...fresh, ...oldKept]
        .sort((a,b) => new Date(b.date).getTime() - new Date(a.date).getTime())
        .slice(0, ARTICLE_CACHE_LIMIT));
    allArticles = merged;
    localCacheArticles = [...merged];
    saveArticleCacheToStorage(merged);
    if (currentPage === pageSingle && singleSourceUrl) {
        currentArticleBox = articleBoxSingle;
        currentArticles = merged.filter(item => item.sourceUrl.trim() === singleSourceUrl.trim());
    } else {
        currentArticleBox = articleBox;
        currentArticles = getVisibleHomeArticles(merged);
    }
    renderPageNum = 1;
    renderedArticleCount = 0;
    renderPagedList(true);
    bindScrollLoadMore();
    if(window.updateUnreadBadge) window.updateUnreadBadge();
}

function renderPagedList(reset = false){
    if(reset){
        currentArticleBox.innerHTML = "";
        renderedArticleCount = 0;
    }else{
        const oldTip = currentArticleBox.querySelector("#loadMoreDom,.bottom-tip");
        if(oldTip) oldTip.remove();
    }
    const nextCount = Math.min(renderPageNum * PAGE_SIZE, currentArticles.length);
    const appendList = currentArticles.slice(renderedArticleCount, nextCount);
    if(appendList.length > 0){
        currentArticleBox.insertAdjacentHTML("beforeend", renderCardList(appendList));
        renderedArticleCount = nextCount;
    }
    const remain = currentArticles.length - renderedArticleCount;
    currentArticleBox.insertAdjacentHTML("beforeend", remain > 0
        ? `<div class="load-more-tip" id="loadMoreDom">滚动加载更多...</div>`
        : `<div class="bottom-tip">全部内容加载完毕</div>`);
    bindAllCardEvent();
    bindVideoPauseObserver();
    initHlsVideo();
}
let mainScrollHandler = null;
function doLoadMore(){
    if(loadLock) return;
    loadLock = true;
    const prevCount = renderedArticleCount;
    renderPageNum += 1;
    renderPagedList();
    // 如果没有新内容，不再重复绑定
    if(renderedArticleCount === prevCount){
        loadLock = false;
        return;
    }
    setTimeout(()=>bindScrollLoadMore(), 30);
    loadLock = false;
}
function bindScrollLoadMore(){
    if(scrollObserver) scrollObserver.disconnect();
    const loadDom = document.getElementById("loadMoreDom");
    if(!loadDom) return;
    // 滚动事件兜底：内部滚动容器(.main-wrap)下，IntersectionObserver 默认 root=视口不可靠，
    // 用 scrollTop+clientHeight 判断是否接近底部，确保「划不动」不再发生。
    if(!mainScrollHandler){
        mainScrollHandler = () => {
            if(currentPage !== pageHome && currentPage !== pageSingle) return;
            const dom = document.getElementById("loadMoreDom");
            if(!dom) return;
            if(mainWrap.scrollTop + mainWrap.clientHeight >= mainWrap.scrollHeight - 200){
                doLoadMore();
            }
        };
        mainWrap.addEventListener("scroll", mainScrollHandler, {passive: true});
    }
    scrollObserver = new IntersectionObserver(async (entries)=>{
        const entry = entries[0];
        if(entry.isIntersecting && !loadLock){
            doLoadMore();
        }
    }, {root: mainWrap, rootMargin: "150px 0px"});
    scrollObserver.observe(loadDom);
}

function renderCardList(list){
    let html = "";
    list.forEach(item => html += buildCard(item, false));
    return html;
}

function getPureText(str){
    if(!str) return "无标题";
    let div = document.createElement("div");
    div.innerHTML = str;
    let text = div.textContent || div.innerText;
    text = text.replace(/<[^>]+>/g, "").trim();
    return text || "无标题";
}

function sanitizeIframeHtml(iframeHtml) {
    const box = document.createElement("template");
    box.innerHTML = iframeHtml || "";
    const iframe = box.content.querySelector("iframe");
    if (!iframe) return "";
    const src = iframe.getAttribute("src") || "";
    if (!isHttpUrl(src)) return "";
    return `<iframe src="${escapeAttr(src)}" width="100%" height="260px" frameborder="0" allowfullscreen loading="lazy" referrerpolicy="no-referrer"></iframe>`;
}

function formatCardDate(dateStr){
    if(!dateStr || dateStr === "未知时间") return "未知时间";
    const date = new Date(dateStr);
    if(Number.isNaN(date.getTime())) return escapeHtml(dateStr);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hour = String(date.getHours()).padStart(2, "0");
    const minute = String(date.getMinutes()).padStart(2, "0");
    const second = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function buildCard(item, isFav = false){
    let mediaHtml = "";

            if (item.isM3u8Video === true) {
    // M3U8视频，保留原有标记，仅给HLS调用
    const imgs = [...new Set(item.media.imgs || [])];
    // 优先使用 videoPoster（从 <video poster="..."> 属性提取的视频缩略图）
    // 回退到 imgs[0]（兼容旧格式 RSS）
    const posterImg = item.videoPoster || (imgs.length > 0 ? imgs[0] : "");
    const posterProxy = posterImg ? getProxyUrl(posterImg, isFav) : "";
    const posterDirect = posterImg ? cleanMediaUrl(posterImg) : "";
    const posterAttr = posterProxy ? `poster="${escapeAttr(posterProxy)}"` : ""; // 原生 <video poster>：渲染即显示封面；封面图不加 twname（对齐稳定版，避免部分代理封面加载失败）
    const posterDirectAttr = posterDirect ? `data-poster-direct="${escapeAttr(posterDirect)}"` : "";
    const posterFallbacksArr = posterImg && hostMatched(posterImg) ? getMediaProxyCandidates(posterImg, isFav).slice(1) : [];
    const posterFallbacksAttr = posterFallbacksArr.length > 0 ? `data-poster-proxy-fallbacks="${escapeAttr(JSON.stringify(posterFallbacksArr))}"` : "";
    const videoDirect = cleanMediaUrl(item.videoUrl);
    const preferProxy = hostMatched(item.videoUrl);
    const isTwRss = !!item.isTwitterRss;
    let videoProxy = preferProxy ? getProxyUrl(item.videoUrl, isFav) : "";
    if(isTwRss && videoProxy) videoProxy += "&src=twrss";
    const firstSrc = preferProxy ? videoProxy : videoDirect;
    // altSrc 留空：直连 m3u8 因 CORS 限制无法在浏览器播放，回退到直连只会导致彻底失败
    const altSrc = "";
    const proxyVideoAttr = preferProxy ? 'data-proxy-video="1"' : "";
    const videoFallbacks = preferProxy ? getMediaProxyCandidates(item.videoUrl, isFav).slice(1).map(u => isTwRss ? u + "&src=twrss" : u) : [];
    const videoFallbacksAttr = videoFallbacks.length > 0 ? `data-proxy-fallbacks="${escapeAttr(JSON.stringify(videoFallbacks))}"` : "";
    const twRssAttr = isTwRss ? ' data-twitter-rss="1"' : "";

    mediaHtml = `<div class="video-single-wrap">
        <video class="media-video" data-m3u8="1" ${proxyVideoAttr}${twRssAttr} preload="none" playsinline ${posterAttr} ${posterDirectAttr} ${posterFallbacksAttr} data-src="${escapeAttr(firstSrc)}" data-alt-src="${escapeAttr(altSrc)}" ${videoFallbacksAttr}>
</video>${mediaControlsHtml()}</div>`;
}else if(item.videoUrl){
    // MP4视频：单独class media-video-mp4，完全脱离HLS逻辑
    const imgs = [...new Set(item.media.imgs || [])];
    // 优先使用 videoPoster（从 <video poster="..."> 属性提取的视频缩略图）
    // 回退到 imgs[0]（兼容旧格式 RSS）
    const posterImg = item.videoPoster || (imgs.length > 0 ? imgs[0] : "");
    const posterProxy = posterImg ? getProxyUrl(posterImg, isFav) : "";
    const posterDirect = posterImg ? cleanMediaUrl(posterImg) : "";
    const posterAttr = posterProxy ? `poster="${escapeAttr(posterProxy)}"` : ""; // 原生 <video poster>：渲染即显示封面；封面图不加 twname（对齐稳定版，避免部分代理封面加载失败）
    const posterDirectAttr = posterDirect ? `data-poster-direct="${escapeAttr(posterDirect)}"` : "";
    const posterFallbacksArr = posterImg && hostMatched(posterImg) ? getMediaProxyCandidates(posterImg, isFav).slice(1) : [];
    const posterFallbacksAttr = posterFallbacksArr.length > 0 ? `data-poster-proxy-fallbacks="${escapeAttr(JSON.stringify(posterFallbacksArr))}"` : "";
    const videoProxy = getProxyUrl(item.videoUrl, isFav);
    const videoDirect = cleanMediaUrl(item.videoUrl);
    const useProxy = hostMatched(item.videoUrl);
    const isTwRss = !!item.isTwitterRss;
    const proxyVideoAttr = useProxy ? 'data-proxy-video="1"' : "";
    const videoFallbacksAttr = useProxy ? getProxyFallbacksAttr(item.videoUrl, isFav) : "";
    // 代理域名强制走代理，直连域名保持直连
    const videoSrc = useProxy ? videoProxy : videoDirect;
    const videoDirectAttr = useProxy && videoDirect ? `data-direct-src="${escapeAttr(videoDirect)}"` : "";
    const twRssAttr = isTwRss ? ' data-twitter-rss="1"' : "";

    mediaHtml = `<div class="video-single-wrap">
        <video class="media-video-mp4"${twRssAttr} ${proxyVideoAttr} preload="none" playsinline ${posterAttr} ${posterDirectAttr} ${posterFallbacksAttr} src="${escapeAttr(videoSrc)}" ${videoFallbacksAttr} ${videoDirectAttr}>
</video>${mediaControlsHtml()}</div>`;
}else if(item.iframe){
    let iframeStr = sanitizeIframeHtml(item.iframe);

    if (iframeStr) {
        mediaHtml = `<div class="video-single-wrap" style="background:#000;overflow:hidden;border-radius:10px;">
        ${iframeStr}
    </div>`;
    }
}else{
    const imgs = [...new Set(item.media.imgs || [])];
    if(imgs.length > 0){
        const total = imgs.length;
        const gridClass = total === 1 ? "grid-single" : "grid-multi";
        mediaHtml = `<div class="img-grid-wrap"><div class="img-grid ${gridClass}">`;
        const show = imgs.slice(0,4);
        show.forEach((src,i)=>{
            let overlay = "";
            if(i === 3 && total > 4){
                const rest = total - 4;
                overlay = `<div class="img-overlay-more">+${rest}张</div>`;
            }
            const imgProxy = getProxyUrl(src, isFav) + "&twname=medium";
            const imgDirect = cleanMediaUrl(src);
            const imgIsProxy = hostMatched(src);
            const imgFallbacksAttr = imgIsProxy ? getProxyFallbacksAttr(src, isFav) : "";
            const imgSrc = imgIsProxy ? imgProxy : imgDirect;
            mediaHtml += `<div class="grid-img-box">
                <img class="grid-img" ${imgIsProxy ? 'crossorigin="anonymous"' : ""} referrerpolicy="no-referrer" decoding="async" data-imggroup='${escapeAttr(JSON.stringify(imgs))}' data-direct-src="${escapeAttr(imgDirect)}" src="${escapeAttr(imgSrc)}" loading="lazy" ${imgFallbacksAttr} onerror="if(!fallbackMediaProxy(this) && this.dataset.directSrc && this.src!==this.dataset.directSrc){this.src=this.dataset.directSrc;}">${overlay}
            </div>`;
        })
        mediaHtml += `</div></div>`;
    }
}

    const titleRaw = escapeHtml(getPureText(item.title));
    const isCollected = favList.some(f=>f.link === item.link);
    const favTxt = isCollected ? "已收藏" : "收藏";
    const favCls = isCollected ? "btn-fav collected" : "btn-fav";
    const itemLink = item.link || "";
    const itemLinkAttr = escapeAttr(itemLink);
    const sourceUrlAttr = escapeAttr(item.sourceUrl || "");
    const sourceNameText = escapeHtml(item.sourceName || "未知来源");
    const avatarKey = (item.sourceUrl || "") + "|" + (item.sourceName || "");
    const avatarIndex = hashText(avatarKey);
    const avatarStyle = escapeAttr(getAvatarStyle(avatarKey));
    const avatarSvg = avatarIconSvg(avatarIndex);
    const dateText = formatCardDate(item.date);

    // 分享链接：优先使用原始媒体 URL（不带代理），方便分享、查看和下载
    // 视频帖用视频 URL，图片帖用第一张图片 URL，无媒体则用文章链接
    let shareUrl = itemLink;
    if (item.videoUrl) {
        shareUrl = cleanMediaUrl(item.videoUrl);
    } else if (item.media && item.media.imgs && item.media.imgs.length > 0) {
        shareUrl = cleanMediaUrl(item.media.imgs[0]);
    }
    const shareUrlAttr = escapeAttr(shareUrl);

    if(isFav){
        return `
        <div class="tweet-card" data-link="${itemLinkAttr}" data-source-url="${sourceUrlAttr}" data-share-url="${shareUrlAttr}">
            <div class="card-top">
                <div class="card-avatar" style="background:${avatarStyle}">${avatarSvg}</div>
                <div class="source-name-text">${sourceNameText}</div>
            </div>
            <div class="card-title-wrap">
                <div class="card-title">${titleRaw}</div>
                <button class="title-toggle-btn">展开</button>
            </div>
            ${mediaHtml}
            <div class="fav-card-bottom">
                <div class="card-bottom-left">${dateText}</div>
                <div class="card-bottom-right">
                    <button class="btn-share" type="button" aria-label="分享" title="分享">${shareIconSvg()}</button>
                    <button class="del-fav" data-link="${itemLinkAttr}" title="取消收藏">${favIconSvg(true)}</button>
                </div>
            </div>
        </div>`;
    }else{
        return `
        <div class="tweet-card" data-link="${itemLinkAttr}" data-source-url="${sourceUrlAttr}" data-share-url="${shareUrlAttr}">
            <div class="card-top">
                <div class="card-avatar" style="background:${avatarStyle}">${avatarSvg}</div>
                <div class="source-name-text">${sourceNameText}</div>
            </div>
            <div class="card-title-wrap">
                <div class="card-title">${titleRaw}</div>
                <button class="title-toggle-btn">展开</button>
            </div>
            ${mediaHtml}
            <div class="card-bottom">
                <div class="card-bottom-left">${dateText}</div>
                <div class="card-bottom-right">
                    <button class="btn-share" type="button" aria-label="分享" title="分享">${shareIconSvg()}</button>
                    <button class="${favCls}" type="button" data-link="${itemLinkAttr}" aria-label="${favTxt}" title="${favTxt}">${favIconSvg(isCollected)}</button>
                </div>
            </div>
        </div>`;
    }
}

