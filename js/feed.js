// ===== feed.js (从 index.html 拆出) =====
function showPage(targetDom, titleText) {
    if (lastPageTitle === titleText) {
        return;
    }
    const willRestoreHome = titleText === "RSS媒体阅读器" && homeIsCached && homeCachedFilterSourceUrl === filterSourceUrl;

    if (lastPageTitle === "RSS媒体阅读器") {
        markReadByScroll();
        homeScrollTop = mainWrap.scrollTop;
        homeArticleHtml = articleBox.innerHTML;
        homeIsCached = true;
        homeCachedFilterSourceUrl = filterSourceUrl;
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

    feedPanel.innerHTML = "";
    favPanel.innerHTML = "";
    if (targetDom === pageHome && !willRestoreHome) {
        articleBox.innerHTML = "";
    }

    if (willRestoreHome && !articleBox.innerHTML) {
        articleBox.innerHTML = homeArticleHtml;
    }
    targetDom.style.display = "block";
    targetDom.scrollTop = 0;

    const textNode = Array.from(pageTitle.childNodes).find(n => n.nodeType === 3);
    if (textNode) {
        textNode.textContent = titleText;
    }

    allBtns.forEach(b => b.classList.remove("active"));
    if (titleText === "RSS媒体阅读器") btnHome.classList.add("active");
    if (titleText === "管理订阅") btnManage.classList.add("active");
    if (titleText === "添加订阅") btnAdd.classList.add("active");
    if (titleText === "我的收藏") btnFav.classList.add("active");
    if (titleText === "内容搜索") btnSearch.classList.add("active");

    if (willRestoreHome) {
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
        lastPageTitle = titleText;
        return;
    }

    if (titleText === "RSS媒体阅读器") {
        renderHomeFromCache();
        homeIsCached = false;
    } else if (titleText === "管理订阅") {
        renderManage();
    } else if (titleText === "我的收藏") {
        renderFav();
    } else if (titleText === "内容搜索") {
        searchInput.value = "";
        searchResultBox.innerHTML = "";
    }

    // 显示添加订阅页时渲染关键字列表
    if (targetDom === pageAdd) {
        renderKeywordList();
    }

    lastPageTitle = titleText;
}

btnHome.onclick = async () => {
    const wasFiltered = !!filterSourceUrl;
    filterSourceUrl = "";

    if(lastPageTitle === "RSS媒体阅读器"){
        if(wasFiltered){
            homeIsCached = false;
            renderHomeFromCache();
            mainWrap.scrollTop = 0;
            return;
        }
        await checkAndPromptUpdate(true);
        return;
    }
    showPage(pageHome, "RSS媒体阅读器");
};
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
    const visibleNewList = newAll.filter(item => !oldLinkSet.has(item.link) && !sessionStartReadSet.has(item.link));
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
            renderHomeFromCache();
            const scrollTopNow = ()=>{
                mainWrap.scrollTop = 0;
                requestAnimationFrame(()=>{ mainWrap.scrollTop = 0; });
            };
            scrollTopNow();
            setTimeout(scrollTopNow, 80);
            setTimeout(scrollTopNow, 250);
            const bar = document.getElementById("updateFloatBar");
            if(bar) bar.remove();
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
    renderPageNum = 0;
    renderedArticleCount = 0;
    loadLock = false;
    if(localCacheArticles.length === 0) {
        articleBox.innerHTML = `<div class="empty-tip">暂无文章内容</div>`;
        return;
    }
    let filterArticles = getVisibleHomeArticles(localCacheArticles);
    if(filterSourceUrl) {
        filterArticles = localCacheArticles.filter(item => item.sourceUrl.trim() === filterSourceUrl.trim());
    }

    currentArticles = [...filterArticles];
    renderPageNum = 1;
    renderPagedList(true);
    bindScrollLoadMore();
}

async function renderSingleFeedFromSource(sourceUrl){
    if(scrollObserver) scrollObserver.disconnect();
    const feed = feedList.find(f => String(f.url).trim() === String(sourceUrl).trim());
    const fallbackList = localCacheArticles.filter(item => item.sourceUrl.trim() === String(sourceUrl).trim());
    articleBox.innerHTML = `<div class="empty-tip">正在加载该订阅内容...</div>`;
    try{
        const xmlText = await fetchRSSFeed(sourceUrl);
        const list = parseRSS(xmlText, feed ? feed.name : "未命名订阅", sourceUrl, feed ? feed.category : "img")
            .sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime());
        if(list.length === 0){
            // 解析为空，尝试缓存
            const cache = getRssCache(sourceUrl);
            if(cache && cache.items && cache.items.length > 0){
                currentArticles = cache.items;
                showToast("该订阅未解析到新内容，已显示缓存");
            }else{
                currentArticles = fallbackList;
                articleBox.innerHTML = fallbackList.length ? "" : `<div class="empty-tip">该订阅暂未解析到内容</div>`;
            }
        }else{
            currentArticles = list;
            // 保存缓存
            saveRssCache(sourceUrl, list);
            const merged = [...list, ...localCacheArticles.filter(item => item.sourceUrl.trim() !== String(sourceUrl).trim())]
                .sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime())
                .slice(0, ARTICLE_CACHE_LIMIT);
            localCacheArticles = merged;
            allArticles = [...merged];
            saveArticleCacheToStorage(merged);
        }
    }catch(err){
        console.warn("单订阅加载失败：", err);
        const errDesc = describeRssError(err);
        // 尝试使用 RSS 缓存
        const cache = getRssCache(sourceUrl);
        if(cache && cache.items && cache.items.length > 0){
            currentArticles = cache.items;
            console.warn("订阅加载失败，已回退至本地缓存：", errDesc);
        }else{
            currentArticles = fallbackList;
            articleBox.innerHTML = fallbackList.length ? "" : `<div class="empty-tip">该订阅加载失败：${errDesc}</div>`;
        }
    }
    if(currentArticles.length > 0){
        renderPageNum = 1;
        renderedArticleCount = 0;
        loadLock = false;
        renderPagedList(true);
        bindScrollLoadMore();
    }
}

window.mergeNewData = async function(){
    if(scrollObserver) scrollObserver.disconnect();
    allArticles = await loadAllRSS();
    localCacheArticles = [...allArticles];
    saveArticleCacheToStorage(allArticles);
    let filterArticles = allArticles;
    if(filterSourceUrl) filterArticles = allArticles.filter(item => item.sourceUrl === filterSourceUrl);
    currentArticles = [...filterArticles];
    renderPageNum = 1;
    renderedArticleCount = 0;
    renderPagedList(true);
}

function renderPagedList(reset = false){
    if(reset){
        articleBox.innerHTML = "";
        renderedArticleCount = 0;
    }else{
        const oldTip = articleBox.querySelector("#loadMoreDom,.bottom-tip");
        if(oldTip) oldTip.remove();
    }
    const nextCount = Math.min(renderPageNum * PAGE_SIZE, currentArticles.length);
    const appendList = currentArticles.slice(renderedArticleCount, nextCount);
    if(appendList.length > 0){
        articleBox.insertAdjacentHTML("beforeend", renderCardList(appendList));
        renderedArticleCount = nextCount;
    }
    const remain = currentArticles.length - renderedArticleCount;
    articleBox.insertAdjacentHTML("beforeend", remain > 0
        ? `<div class="load-more-tip" id="loadMoreDom">滚动加载更多...</div>`
        : `<div class="bottom-tip">全部内容加载完毕</div>`);
    bindAllCardEvent();
    bindVideoPauseObserver();
    initHlsVideo();
}
function bindScrollLoadMore(){
    if(scrollObserver) scrollObserver.disconnect();
    const loadDom = document.getElementById("loadMoreDom");
    if(!loadDom) return;
    scrollObserver = new IntersectionObserver(async (entries)=>{
        const entry = entries[0];
        if(entry.isIntersecting && !loadLock){
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
    }, {rootMargin: "150px 0px"});
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
    const posterProxy = posterImg ? getProxyUrl(posterImg, isFav) + "&twname=medium" : "";
    const posterDirect = posterImg ? cleanMediaUrl(posterImg) : "";
    let posterAttr = ""; // 预览图改由 overlay 图懒加载（见 IntersectionObserver），不再让 video 原生 poster 也 eager 拉图
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
        ${posterProxy ? `<img class="video-poster-img" data-poster-src="${escapeAttr(posterProxy)}" referrerpolicy="no-referrer" decoding="async" data-poster-direct="${escapeAttr(posterDirect)}" onerror="if(this.dataset.posterDirect && this.src!==this.dataset.posterDirect){this.src=this.dataset.posterDirect;}">` : ""}
        <video class="media-video" data-m3u8="1" ${proxyVideoAttr}${twRssAttr} preload="none" playsinline ${posterAttr} ${posterDirectAttr} ${posterFallbacksAttr} data-src="${escapeAttr(firstSrc)}" data-alt-src="${escapeAttr(altSrc)}" ${videoFallbacksAttr}>
</video><div class="video-loading-spinner"></div>${mediaControlsHtml()}</div>`;
}else if(item.videoUrl){
    // MP4视频：单独class media-video-mp4，完全脱离HLS逻辑
    const imgs = [...new Set(item.media.imgs || [])];
    // 优先使用 videoPoster（从 <video poster="..."> 属性提取的视频缩略图）
    // 回退到 imgs[0]（兼容旧格式 RSS）
    const posterImg = item.videoPoster || (imgs.length > 0 ? imgs[0] : "");
    const posterProxy = posterImg ? getProxyUrl(posterImg, isFav) + "&twname=medium" : "";
    const posterDirect = posterImg ? cleanMediaUrl(posterImg) : "";
    let posterAttr = ""; // 预览图改由 overlay 图懒加载（见 IntersectionObserver），不再让 video 原生 poster 也 eager 拉图
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
        ${posterProxy ? `<img class="video-poster-img" data-poster-src="${escapeAttr(posterProxy)}" referrerpolicy="no-referrer" decoding="async" data-poster-direct="${escapeAttr(posterDirect)}" onerror="if(this.dataset.posterDirect && this.src!==this.dataset.posterDirect){this.src=this.dataset.posterDirect;}">` : ""}
        <video class="media-video-mp4"${twRssAttr} ${proxyVideoAttr} preload="none" playsinline ${posterAttr} ${posterDirectAttr} ${posterFallbacksAttr} src="${escapeAttr(videoSrc)}" ${videoFallbacksAttr} ${videoDirectAttr}>
</video><div class="video-loading-spinner"></div>${mediaControlsHtml()}</div>`;
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
                <button class="del-fav" data-link="${itemLinkAttr}" title="取消收藏">${favIconSvg(true)}</button>
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

