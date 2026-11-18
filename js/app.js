// ===== app.js (从 index.html 拆出) =====
// ─── 收藏「待取消」标记（防误触，2026-11-18）─────────────────
// 点击收藏按钮：实心→空心仅是标记，不立即删除；再点一次空心→实心立即恢复；
// 重新进入收藏页 / 刷新页面时（renderFav 开头）才真正从 favList 移除。
// sessionStorage 保存：页面刷新后标记仍生效（随后被真正移除），关闭标签页自动清空。
let favPendingRemove = new Set(JSON.parse(sessionStorage.getItem("rss_fav_pending") || "[]"));
function saveFavPending(){
    try{ sessionStorage.setItem("rss_fav_pending", JSON.stringify([...favPendingRemove])); }catch(e){}
}

function renderFav(){
    if(scrollObserver) scrollObserver.disconnect();
    renderPageNum = 1;
    loadLock = false;
    // 防误触机制：上一轮标记为「待取消」的收藏，在重新进入收藏页/刷新时才真正移除
    if(favPendingRemove.size > 0){
        favList = favList.filter(x => !favPendingRemove.has(x.link));
        localStorage.setItem(FAV_KEY, JSON.stringify(favList));
        favPendingRemove.clear();
        saveFavPending();
    }
    if(favList.length === 0) {
        favPanel.innerHTML = `<div class="empty-tip" style="min-height:70vh;display:flex;align-items:center;justify-content:center;flex-direction:column;">暂无收藏内容<br>浏览主页卡片点击收藏按钮添加</div>`;
        return;
    }
    const sortedFavList = [...favList].sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime());
    // 九宫格数据源：cells 通过 data-fav-idx 引用（2026-11-18 改版）
    window.favGridItems = sortedFavList;
    const slice = sortedFavList.slice(0, PAGE_SIZE);
    let html = `<div class="fav-grid">` + slice.map((it,i)=>buildFavGridCell(it, i)).join("") + `</div>`;
    const remain = sortedFavList.length - slice.length;
    if(remain > 0){
        html += `<div class="load-more-tip" id="favLoadMore">滚动加载更多...</div>`;
    }else{
        html += `<div class="bottom-tip">全部收藏加载完毕</div>`;
    }
    favPanel.innerHTML = html;
    // 九宫格点击：媒体区 → 全屏播放层；分享 → 复制链接；收藏 → 取消收藏
    favPanel.onclick = async (e)=>{
        const shareBtn = e.target.closest(".cell-share");
        if(shareBtn){
            e.stopPropagation();
            const link = shareBtn.dataset.shareUrl || "";
            if(!link){ showToast("无可分享的链接"); return; }
            try{
                await navigator.clipboard.writeText(link);
                showToast("链接已复制");
            }catch(err){
                const input = document.createElement("input");
                input.value = link;
                document.body.appendChild(input);
                input.select();
                document.execCommand("copy");
                input.remove();
                showToast("链接已复制");
            }
            return;
        }
        const unfavBtn = e.target.closest(".cell-unfav");
        if(unfavBtn){
            e.stopPropagation();
            const it = window.favGridItems && window.favGridItems[Number(unfavBtn.dataset.cellIdx)];
            if(it && it.link){
                if(favPendingRemove.has(it.link)){
                    // 空心 → 实心：马上恢复收藏
                    favPendingRemove.delete(it.link);
                    saveFavPending();
                    unfavBtn.classList.remove("pending");
                    unfavBtn.innerHTML = favIconSvg(true);
                    unfavBtn.title = "取消收藏";
                    showToast("已恢复收藏");
                }else{
                    // 实心 → 空心：仅标记待取消，离开收藏页后才真正移除
                    favPendingRemove.add(it.link);
                    saveFavPending();
                    unfavBtn.classList.add("pending");
                    unfavBtn.innerHTML = favIconSvg(false);
                    unfavBtn.title = "恢复收藏";
                    showToast("将在离开收藏页后取消（再点一次可恢复）");
                }
            }
            return;
        }
        const media = e.target.closest(".fav-cell-media");
        if(media && window.favGridItems){
            const cell = media.closest(".fav-grid-cell");
            const it = window.favGridItems[Number(cell.dataset.favIdx)];
            if(it) openFavPlayer(it);
        }
    };
    const favLoad = document.getElementById("favLoadMore");
    if(favLoad){
        const favObserver = new IntersectionObserver(async (e)=>{
            if(e[0].isIntersecting && !loadLock){
                loadLock = true;
                renderPageNum += 1;
                const favSlice = sortedFavList.slice(0, renderPageNum * PAGE_SIZE);
                let favHtml = `<div class="fav-grid">` + favSlice.map((it,i)=>buildFavGridCell(it, i)).join("") + `</div>`;
                const rem = sortedFavList.length - favSlice.length;
                if(rem>0) favHtml += `<div class="load-more-tip" id="favLoadMore">滚动加载更多...</div>`;
                else favHtml += `<div class="bottom-tip">全部收藏加载完毕</div>`;
                favPanel.innerHTML = favHtml;
                favObserver.disconnect();
                setTimeout(()=>{
                    const newFavLoad = document.getElementById("favLoadMore");
                    if(newFavLoad) favObserver.observe(newFavLoad);
                },30);
                loadLock = false;
            }
        },{rootMargin:"150px 0"});
        favObserver.observe(favLoad);
    }
}

// ─── 收藏九宫格单元格：头像+标题（顶） / 正方形媒体区（中） / 时间+分享+收藏（底） ──
const FAV_PLAY_SVG = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M6 3.5v17l14-8.5z"/></svg>`;
function buildFavGridCell(item, idx){
    const imgs = [...new Set((item.media && item.media.imgs) || [])];
    const isVideo = item.isM3u8Video === true || !!item.videoUrl;
    // 预览图：视频用封面（videoPoster 优先），图片用第一张
    const previewImg = isVideo ? (item.videoPoster || imgs[0] || "") : (imgs[0] || "");
    let mediaInner;
    if(previewImg){
        const src = getProxyUrl(previewImg, true, "large") || twimgSizedDirect(cleanMediaUrl(previewImg), "large") || previewImg;
        mediaInner = `<img src="${escapeAttr(src)}" loading="lazy" alt="">`;
    }else{
        // 无媒体：纯文字占位
        mediaInner = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:8px;font-size:11px;color:#888;text-align:center;overflow:hidden;">${escapeHtml((item.title||"").slice(0,60))}</div>`;
    }
    const playBadge = isVideo ? `<span class="fav-play-badge">${FAV_PLAY_SVG}</span>` : "";
    // 头部：订阅头像 + 标题（Twitter 订阅显示订阅用户本人的真头像，无头像回退彩色字母图标）
    const avatarKey = (item.sourceUrl || "") + "|" + (item.sourceName || "");
    const head = `
        <div class="fav-cell-head">
            <div class="fav-cell-avatar" style="background:${escapeAttr(getAvatarStyle(avatarKey))};">${feedAvatarInnerHtml(item.sourceUrl, avatarIconSvg(hashText(avatarKey)))}</div>
            <div class="fav-cell-title">${escapeHtml(item.sourceName || "未知来源")}</div>
        </div>`;
    // 底部：更新时间（月-日）+ 分享 / 收藏（防误触：点击只切换实心/空心，离开收藏页后才真正取消）
    let dateText = "";
    try{
        const d = new Date(item.date);
        if(!Number.isNaN(d.getTime())){
            dateText = `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")}`;
        }
    }catch(e){}
    // 分享链接：与主页卡片同规则——优先原始媒体 URL，无媒体用文章链接
    const shareUrl = item.videoUrl ? cleanMediaUrl(item.videoUrl) : (imgs.length ? cleanMediaUrl(imgs[0]) : (item.link || ""));
    const pending = favPendingRemove.has(item.link);
    const foot = `
        <div class="fav-cell-foot">
            <span class="fav-cell-date">${dateText}</span>
            <span class="fav-cell-ops">
                <button class="cell-share" data-share-url="${escapeAttr(shareUrl)}" title="分享">${shareIconSvg()}</button>
                <button class="cell-unfav${pending ? " pending" : ""}" data-cell-idx="${idx}" title="${pending ? "恢复收藏" : "取消收藏"}">${favIconSvg(!pending)}</button>
            </span>
        </div>`;
    return `<div class="fav-grid-cell" data-fav-idx="${idx}">
        ${head}
        <div class="fav-cell-media">${mediaInner}${playBadge}</div>
        ${foot}
    </div>`;
}

// ─── 收藏九宫格 → 全屏播放层（视频复用主页 HLS 播放机制，图片直接放大）──
function openFavPlayer(item){
    const layer = document.getElementById("favPlayerLayer");
    const box = document.getElementById("favPlayerContent");
    const isTwRss = !!item.isTwitterRss;
    const twRssAttr = isTwRss ? ' data-twitter-rss="1"' : "";
    let inner = "";
    if(item.isM3u8Video === true && item.videoUrl){
        const imgs = [...new Set((item.media && item.media.imgs) || [])];
        const posterImg = item.videoPoster || imgs[0] || "";
        const posterAttr = posterImg ? `poster="${escapeAttr(getProxyUrl(posterImg, true, "large"))}"` : "";
        const posterDirectAttr = posterImg ? `data-poster-direct="${escapeAttr(twimgSizedDirect(cleanMediaUrl(posterImg), "large"))}"` : "";
        const preferProxy = hostMatched(item.videoUrl);
        let videoProxy = preferProxy ? getProxyUrl(item.videoUrl, true) : "";
        if(isTwRss && videoProxy) videoProxy += "&src=twrss";
        const firstSrc = preferProxy ? videoProxy : cleanMediaUrl(item.videoUrl);
        const proxyVideoAttr = preferProxy ? 'data-proxy-video="1"' : "";
        const fbs = preferProxy ? getMediaProxyCandidates(item.videoUrl, true).slice(1).map(u => isTwRss ? u + "&src=twrss" : u) : [];
        const fbAttr = fbs.length ? `data-proxy-fallbacks="${escapeAttr(JSON.stringify(fbs))}"` : "";
        inner = `<div class="video-single-wrap" style="width:100%;background:#000;">
            <video class="media-video" data-m3u8="1" ${proxyVideoAttr}${twRssAttr} preload="none" playsinline ${posterAttr} ${posterDirectAttr} ${fbAttr} data-src="${escapeAttr(firstSrc)}" data-alt-src="">
</video>${mediaControlsHtml()}</div>`;
    }else if(item.videoUrl){
        const imgs = [...new Set((item.media && item.media.imgs) || [])];
        const posterImg = item.videoPoster || imgs[0] || "";
        const posterAttr = posterImg ? `poster="${escapeAttr(getProxyUrl(posterImg, true, "large"))}"` : "";
        const useProxy = hostMatched(item.videoUrl);
        const videoSrc = useProxy ? getProxyUrl(item.videoUrl, true) : cleanMediaUrl(item.videoUrl);
        const proxyVideoAttr = useProxy ? 'data-proxy-video="1"' : "";
        const fbAttr = useProxy ? getProxyFallbacksAttr(item.videoUrl, true) : "";
        inner = `<div class="video-single-wrap" style="width:100%;background:#000;">
            <video class="media-video-mp4"${twRssAttr} ${proxyVideoAttr} preload="none" playsinline ${posterAttr} src="${escapeAttr(videoSrc)}" ${fbAttr}>
</video>${mediaControlsHtml()}</div>`;
    }else{
        const imgs = [...new Set((item.media && item.media.imgs) || [])];
        if(imgs.length === 0){
            showToast("该内容没有可播放的媒体");
            return;
        }
        inner = `<img src="${escapeAttr(getProxyUrl(imgs[0], true, "large"))}" alt="">`;
    }
    box.innerHTML = inner;
    layer.classList.add("show");
    // 视频走主页同一套 HLS 机制并自动起播
    if(inner.indexOf("<video") !== -1){
        initHlsVideo();
        const v = box.querySelector("video");
        if(v) toggleVideoPlay(v);
    }
}

function closeFavPlayer(){
    const layer = document.getElementById("favPlayerLayer");
    const box = document.getElementById("favPlayerContent");
    box.querySelectorAll("video").forEach(v=>{
        try{ v.pause(); }catch(e){}
        try{ if(v.hlsInstance) v.hlsInstance.destroy(); }catch(e){}
        try{ v.removeAttribute("src"); v.load(); }catch(e){}
    });
    box.innerHTML = "";
    layer.classList.remove("show");
}

// 点 ✕ 或黑色空白处关闭全屏播放层
document.getElementById("favPlayerClose").onclick = closeFavPlayer;
document.getElementById("favPlayerLayer").addEventListener("click", (e)=>{
    if(e.target.id === "favPlayerLayer") closeFavPlayer();
});

function bindAllCardEvent(){
    // 主页卡片头像点击：跳转查看该订阅源所有内容
    document.querySelectorAll("#pageHome .card-avatar, #pageSingle .card-avatar").forEach(avatar=>{
        avatar.style.cursor = "pointer";
        avatar.title = "点击查看该订阅源";
        avatar.onclick = async function(e){
            e.stopPropagation();
            const card = this.closest(".tweet-card");
            if(!card) return;
            const sourceUrl = card.dataset.sourceUrl;
            if(!sourceUrl) return;
            await openSingleSource(sourceUrl);
        }
    })

    document.querySelectorAll(".grid-img").forEach((img)=>{
        img.onclick = function(){
            let imgs;
            try {
                imgs = JSON.parse(this.dataset.imggroup || "[]");
                if(!Array.isArray(imgs) || imgs.length === 0) throw new Error("empty");
            } catch(e) {
                // 属性损坏/缺失时退化为单图预览（用当前已加载或直连地址），保证放大功能不崩
                imgs = [ this.currentSrc || this.src || this.dataset.directSrc ].filter(Boolean);
            }
            currentPreviewImgs = imgs;
            const box = this.closest(".grid-img-box");
            const allBoxes = box ? box.parentElement.querySelectorAll(".grid-img-box") : [];
            const clickIndex = box ? Array.from(allBoxes).indexOf(box) : 0;
            renderPreviewSlider(imgs, clickIndex);
            if(imgPreviewMask) imgPreviewMask.style.display = "flex";
        }
    })

    document.querySelectorAll(".card-title-wrap").forEach(wrap=>{
        const titleEl = wrap.querySelector(".card-title");
        const toggleBtn = wrap.querySelector(".title-toggle-btn");
        setTimeout(()=>{
            const lineHeight = parseFloat(getComputedStyle(titleEl).lineHeight) || 22;
            const needToggle = titleEl.scrollHeight > lineHeight * 2 + 2;
            if(needToggle){
                toggleBtn.style.display = "block";
                toggleBtn.innerText = "展开";
            }else{
                toggleBtn.style.display = "none";
            }
        }, 80);
        toggleBtn.onclick = function(){
            if(titleEl.classList.contains("expand")){
                titleEl.classList.remove("expand");
                this.innerText = "展开";
            }else{
                titleEl.classList.add("expand");
                this.innerText = "收起";
            }
        }
    })

    document.querySelectorAll(".btn-share").forEach(btn=>{
        btn.onclick = async function(e){
            e.stopPropagation();
            const cardDom = this.closest(".tweet-card");
            // 优先使用原始媒体链接（不带代理），方便分享、查看和下载
            const link = cardDom.dataset.shareUrl || cardDom.dataset.link;
            try{
                await navigator.clipboard.writeText(link);
                showToast("链接已复制");
            }catch(err){
                const input = document.createElement("input");
                input.value = link;
                document.body.appendChild(input);
                input.select();
                document.execCommand("copy");
                input.remove();
                showToast("链接已复制");
            }
        }
    })
    document.querySelectorAll(".btn-fav").forEach(btn=>{
        btn.onclick = function(e){
            e.stopPropagation();
            const link = this.dataset.link;
            if(!link) return;
            // 在多个可能的列表里查找目标条目：主页(allArticles)、本地缓存(localCacheArticles)、单源(currentArticles)
            // 修复：原先只搜 allArticles，单源浏览/搜索结果里的卡片不在其中，
            // 导致点击收藏时 target 为 undefined、被 if(!target) return 静默吞掉 → 表现为"按钮偶尔点不动"。
            let target = allArticles.find(i=>i.link === link);
            if(!target && typeof localCacheArticles !== "undefined") target = localCacheArticles.find(i=>i.link === link);
            if(!target && typeof currentArticles !== "undefined") target = currentArticles.find(i=>i.link === link);
            if(!target){
                // 兜底：用卡片现有信息构造最小对象，保证收藏切换始终有反馈（不再静默无反应）
                const card = this.closest(".tweet-card");
                const title = card ? (card.querySelector(".card-title")?.textContent || card.dataset.link || link) : link;
                target = { link, title };
            }
            if(!favList.some(f=>f.link === link)){
                favList.push(target);
                localStorage.setItem(FAV_KEY, JSON.stringify(favList));
                this.innerHTML = favIconSvg(true);
                this.setAttribute("aria-label", "已收藏");
                this.setAttribute("title", "已收藏");
                this.classList.add("collected");
                showToast("已添加到收藏");
            }else{
                favList = favList.filter(f=>f.link !== link);
                localStorage.setItem(FAV_KEY, JSON.stringify(favList));
                this.innerHTML = favIconSvg(false);
                this.setAttribute("aria-label", "收藏");
                this.setAttribute("title", "收藏");
                this.classList.remove("collected");
                showToast("已取消收藏");
            }
        }
    })
    document.querySelectorAll(".del-fav").forEach(btn=>{
        btn.onclick = function(e){
            e.stopPropagation();
            const link = this.dataset.link;
            favList = favList.filter(f=>f.link !== link);
            localStorage.setItem(FAV_KEY, JSON.stringify(favList));
            this.closest(".tweet-card").remove();
            showToast("已取消收藏");
        }
    })

    if (!readObserver) {
        readObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!entry.isIntersecting) {
                    const card = entry.target;
                    if(currentPage !== pageHome || !articleBox.contains(card)) return;
                    if(card.getBoundingClientRect().bottom > 90) return;
                    const link = card.dataset.link;
                    if(!link) return;
                    markCardRead(card);
                }
            });
        }, { rootMargin: "-90% 0px 0px 0px" });
    }
    // 已读观察器只观察【主页容器】内的卡片：单源模式(articleBoxSingle)、收藏(favPanel)的卡片
    // 完全不被 observe，从根本上保证「单源/收藏界面不标记已读」（readObserver 回调另有守卫双保险）。
    articleBox.querySelectorAll(".tweet-card").forEach(card => {
        readObserver.observe(card);
    });
}

let previewSwipeIndex = 0;
let previewSwipeStartX = 0;
let previewSwipeDx = 0;
let previewSwipeLock = false;
let previewSwipeBound = false;

function renderPreviewSlider(imgs, startIndex = 0){
    previewWrap.innerHTML = "";
    previewSwipeIndex = startIndex;
    previewSwipeLock = false;
    imgs.forEach((src, i)=>{
        const slide = document.createElement("div");
        slide.className = "preview-slide";
        const imgUrl = getProxyUrl(src);
        const imgDirect = cleanMediaUrl(src);
        const imgFallbacksAttr = hostMatched(src) ? getProxyFallbacksAttr(src) : "";
        slide.innerHTML = `<img class="preview-img" src="${escapeAttr(imgUrl)}" referrerpolicy="no-referrer" decoding="async" data-direct-src="${escapeAttr(imgDirect)}" ${imgFallbacksAttr} onerror="if(!fallbackMediaProxy(this) && this.dataset.directSrc && this.src!==this.dataset.directSrc){this.src=this.dataset.directSrc;}">`;
        slide.style.transform = `translateX(${(i - startIndex) * 100}%)`;
        previewWrap.appendChild(slide);
    });
    // 预加载当前及相邻图片，确保滑动流畅
    const preloadIndexes = [startIndex];
    if(startIndex > 0) preloadIndexes.push(startIndex - 1);
    if(startIndex < imgs.length - 1) preloadIndexes.push(startIndex + 1);
    preloadIndexes.forEach(idx => {
        const pre = new Image();
        pre.referrerPolicy = "no-referrer";
        pre.decoding = "async";
        pre.src = getProxyUrl(imgs[idx]);
    });
    updatePreviewTip();

    if(previewSwipeBound) return;
    previewSwipeBound = true;

    previewWrap.addEventListener("touchstart", function(e){
        if(previewSwipeLock) return;
        previewSwipeStartX = e.touches[0].clientX;
        previewSwipeDx = 0;
    }, {passive: true});
    previewWrap.addEventListener("touchmove", function(e){
        if(previewSwipeLock) return;
        previewSwipeDx = e.touches[0].clientX - previewSwipeStartX;
        const slides = this.querySelectorAll(".preview-slide");
        const dxPercent = (previewSwipeDx / this.clientWidth * 100);
        slides.forEach((s, i)=>{
            s.style.transition = "none";
            s.style.transform = `translateX(${(i - previewSwipeIndex) * 100 + dxPercent}%)`;
        });
    }, {passive: true});
    function endSwipe(){
        if(previewSwipeLock) return;
        previewSwipeLock = true;
        const slides = previewWrap.querySelectorAll(".preview-slide");
        const total = slides.length;
        const threshold = previewWrap.clientWidth * 0.12;
        if(previewSwipeDx < -threshold && previewSwipeIndex < total - 1){
            previewSwipeIndex++;
        }else if(previewSwipeDx > threshold && previewSwipeIndex > 0){
            previewSwipeIndex--;
        }
        slides.forEach((s, i)=>{
            s.style.transition = "transform 0.25s cubic-bezier(0.25,0.1,0.25,1)";
            s.style.transform = `translateX(${(i - previewSwipeIndex) * 100}%)`;
        });
        updatePreviewTip();
        // 预加载下一张图片
        const nextIdx = previewSwipeIndex + 1;
        if(nextIdx < currentPreviewImgs.length){
            const pre = new Image();
            pre.referrerPolicy = "no-referrer";
            pre.decoding = "async";
            pre.src = getProxyUrl(currentPreviewImgs[nextIdx]);
        }
        setTimeout(()=>{ previewSwipeLock = false; }, 260);
    }
    previewWrap.addEventListener("touchend", endSwipe, {passive: true});
    previewWrap.addEventListener("touchcancel", endSwipe, {passive: true});
}

function updatePreviewTip(){
    const slides = previewWrap.querySelectorAll(".preview-slide");
    const total = slides.length;
    if(previewSwipeIndex === total - 1){
        previewTip.innerText = "这是最后一张啦";
    }else{
        previewTip.innerText = `${previewSwipeIndex + 1} / ${total}`;
    }
}

previewClose.onclick = ()=> imgPreviewMask.style.display = "none";
imgPreviewMask.addEventListener("click", function(e){
    if(e.target === this){
        imgPreviewMask.style.display = "none";
    }
});

// RSS 本地缓存：成功加载时保存，失败时回退到缓存
const RSS_CACHE_PREFIX = "rss_cache_";
const RSS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24小时

// 单个订阅源的本地缓存条数上限（5.0.1 新增）。
// 为什么需要：RSS 源缓存与「文章缓存」是两份**独立副本** —— 同一批条目会被存两遍。
// 源缓存原本保存该源的全部条目且 parseRSS 不限条数，体积往往与文章缓存相当，
// 是 localStorage 配额最主要的浪费来源。
// 源缓存只用于「该源拉取失败时的回退展示」，保留最新 N 条已完全够用。
const RSS_CACHE_ITEMS_PER_FEED = 120;

function saveRssCache(url, items){
    // 统一裁到上限，两处 setItem 都遵守
    const slimItems = (items || []).slice(0, RSS_CACHE_ITEMS_PER_FEED);
    try{
        const key = RSS_CACHE_PREFIX + url;
        localStorage.setItem(key, JSON.stringify({
            items: slimItems,
            time: Date.now()
        }));
    }catch(e){
        // 容量不足时清理旧的源缓存后重试一次
        cleanExpiredRssCache();
        try{
            const key = RSS_CACHE_PREFIX + url;
            localStorage.setItem(key, JSON.stringify({
                items: slimItems,
                time: Date.now()
            }));
        }catch(e2){
            console.warn("RSS缓存保存失败:", e2.message);
        }
    }
}

function getRssCache(url){
    try{
        const key = RSS_CACHE_PREFIX + url;
        const raw = localStorage.getItem(key);
        if(!raw) return null;
        const data = JSON.parse(raw);
        if(!data || !data.items) return null;
        // 超过 TTL 的缓存仍然返回，但标记为过期
        const age = Date.now() - (data.time || 0);
        return { items: data.items, age: age, expired: age > RSS_CACHE_TTL };
    }catch(e){
        return null;
    }
}

// 根据 HTTP 状态码和错误信息生成友好的错误提示
function describeRssError(error){
    const msg = String(error.message || error || "");
    if(/520/.test(msg)) return "源站不可用(520)，服务可能已宕机";
    if(/502/.test(msg)) return "代理请求失败(502)";
    if(/403/.test(msg)) return "代理被拒绝(403)，域名不在白名单";
    if(/代理返回了无效内容|非 RSS/.test(msg)) return "返回了网页而非RSS内容(可能被反爬拦截)";
    if(/timeout|超时|abort/i.test(msg)) return "请求超时，网络较慢或源站无响应";
    if(/fetch|network|ERR_/i.test(msg)) return "网络连接失败";
    if(/格式不正确/.test(msg)) return "RSS链接格式不正确";
    return msg;
}

async function loadAllRSS(){
    const queue = [...feedList];
    const allGroups = [];
    const failedFeeds = [];
    const cachedFeeds = [];
    async function worker(){
        while(queue.length){
            const f = queue.shift();
            try{
                let xmlText = await fetchRSSFeed(f.url);
                if(!xmlText) {
                    allGroups.push([]);
                }else{
                    const items = parseRSS(xmlText, f.name, f.url, f.category);
                    // 提取订阅用户头像（twitter-rss 在 channel 输出 <image><url>），有变化时持久化到 feed
                    try{
                        const av = extractChannelAvatar(xmlText);
                        if(av && f.avatar !== av){
                            f.avatar = av;
                            localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
                        }
                    }catch(e){}
                    // 成功加载，保存缓存
                    if(items && items.length > 0){
                        saveRssCache(f.url, items);
                    }else{
                        // 后端返回了"空结果"RSS：很可能是所有 Nitter 实例失效，
                        // 诊断原因写在 <channel><description> 里（例如"所有 Nitter 实例均不可用…"）。
                        // 透传给失败提示，避免"前端提示失败、但看不出原因"。
                        let diag = "";
                        try { if (typeof extractChannelDesc === "function") diag = extractChannelDesc(xmlText); } catch(e) {}
                        if(diag && /实例|失效|不可用|失败|超时|未识别|验证页/.test(diag)){
                            failedFeeds.push({name: f.name, url: f.url, error: diag});
                        }
                    }
                    allGroups.push(items || []);
                }
            }catch(e){
                console.warn(`订阅【${f.name}】拉取失败：`, e.message);
                const errDesc = describeRssError(e);
                failedFeeds.push({name: f.name, url: f.url, error: errDesc});
                // 尝试使用本地缓存
                const cache = getRssCache(f.url);
                if(cache && cache.items && cache.items.length > 0){
                    cachedFeeds.push({name: f.name, cached: true, expired: cache.expired});
                    allGroups.push(cache.items);
                }else{
                    allGroups.push([]);
                }
            }
        }
    }
    const workerCount = Math.min(RSS_CONCURRENCY, queue.length);
    await Promise.all(Array.from({length: workerCount}, worker));
    let res = [];
    allGroups.forEach(group=>res = res.concat(group));
    res.sort((a,b)=> new Date(b.date).getTime() - new Date(a.date).getTime());
    // 提示加载失败的订阅
    if(failedFeeds.length > 0){
        const failedMsgs = failedFeeds.map(f => `【${f.name}】${f.error}`).join("\n");
        if(cachedFeeds.length > 0){
            const cachedNames = cachedFeeds.map(f => f.name).join("、");
            console.warn("以下订阅加载失败(已使用缓存)：", cachedNames);
        }else{
            showToast(`以下订阅加载失败：${failedFeeds.map(f=>f.name).join("、")}`);
        }
        console.warn("RSS加载失败详情：\n" + failedMsgs);
    }
    return res;
}

// 从 RSS 文本提取 channel 级订阅头像 URL（twitter-rss 输出的 <image><url>）。
// 仅信任 pbs.twimg.com/profile_images 地址，非 Twitter 源返回空字符串。
function extractChannelAvatar(xml){
    const m = String(xml || '').match(/<image>\s*<url>([^<]+)<\/url>/i);
    if(!m) return "";
    const u = fullDecodeXml(m[1]).trim();
    return /^https?:\/\/pbs\.twimg\.com\/profile_images\//i.test(u) ? u : "";
}

function parseRSS(xml, sourceName, sourceUrl, cat){
    let list = [];
    const itemReg = /<(item|entry)>([\s\S]*?)<\/(item|entry)>/gi;
    let m;
    while((m = itemReg.exec(xml)) !== null){
        let txt = m[2];
        let titleRaw = (txt.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "无标题";
        titleRaw = fullDecodeXml(titleRaw);

        // 过滤掉"暂无内容"等占位条目，不显示无更新的订阅
        if(titleRaw === "暂无内容") continue;

        let link = "";
        const linkHref = txt.match(/<link[^>]*href="([^"]+)"/);
        if(linkHref) link = linkHref[1];
        if(!link) link = (txt.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
        if(!link) link = (txt.match(/<guid>([\s\S]*?)<\/guid>/) || [])[1] || "#";
        link = fullDecodeXml(link);

        let date = (txt.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
        if(!date) date = (txt.match(/<updated>([\s\S]*?)<\/updated>/) || [])[1] || "未知时间";
        date = fullDecodeXml(date);

        let desc = (txt.match(/<description>([\s\S]*?)<\/description>/) || [])[1] || "";
        if(!desc) desc = (txt.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || "";
        desc = fullDecodeXml(desc);

        let iframeCode = "";
        const iframeMatch = desc.match(/<iframe[\s\S]*?<\/iframe>/i);
        if(iframeMatch){
            iframeCode = iframeMatch[0];
            iframeCode = iframeCode.replace(/""/g, '"');
        }

        let mp4List = [];
        let m3u8List = [];
        const fullText = txt + desc;
        const addMp4 = url => {
            const cleaned = cleanMediaUrl(url);
            if(cleaned) mp4List.push(cleaned);
        };
        const addM3u8 = url => {
            const cleaned = cleanMediaUrl(url);
            if(cleaned) m3u8List.push(cleaned);
        };
        const addImg = (arr, url) => {
            let cleaned = cleanMediaUrl(url);
            if(!cleaned) return;
            // 归一化：去掉 Twitter 图片尺寸后缀(:large/:orig 等)与尺寸查询参数，
            // 让同一张图的不同尺寸变体去重为一张，避免单图条目显示成「两张一样的图」。
            cleaned = cleaned
                .replace(/:(large|orig|small|medium|thumb|mini|900x900|4096x4096)(?=$|[?&])/i, '')
                .replace(/[?&](format|name|width|height)=[^&]*/gi, '')
                .replace(/\?$/, '');
            if(cleaned) arr.push(cleaned);
        };

        const playerUrlReg = /url=(https?:\/\/[^&"<>]+\.m3u8(?:\?[^&"<>]*)?)/gi;
        let regMatch;
        while ((regMatch = playerUrlReg.exec(fullText)) !== null) {
            addM3u8(regMatch[1]);
        }
        const m3u8AttrReg = /(?:src|data-src|href|url)=["']([^"']+\.m3u8(?:\?[^"']*)?)["']/gi;
        while((regMatch = m3u8AttrReg.exec(fullText)) !== null){
            addM3u8(regMatch[1]);
        }
        const m3u8RawReg = /https?:\/\/[^<>"'\s]+\.m3u8(?:\?[^<>"'\s]*)?/gi;
        while((regMatch = m3u8RawReg.exec(fullText)) !== null){
            addM3u8(regMatch[0]);
        }
        getUrlCandidates(fullText, ".m3u8").forEach(addM3u8);

        const videoAttrReg = /(?:src|data-src|href|url)=["']([^"']+\.mp4(?:\?[^"']*)?)["']/gi;
        while((regMatch = videoAttrReg.exec(fullText)) !== null){
            addMp4(regMatch[1]);
        }
        const videoRawReg = /https?:\/\/[^<>"'\s]+\.mp4(?:\?[^<>"'\s]*)?/gi;
        while((regMatch = videoRawReg.exec(fullText)) !== null){
            addMp4(regMatch[0]);
        }
        getUrlCandidates(fullText, ".mp4").forEach(addMp4);

        mp4List = [...new Set(mp4List)];
        m3u8List = [...new Set(m3u8List)];

        let finalVideoUrl = "";
        let isM3u8Video = false;

        if(m3u8List.length > 0){
            finalVideoUrl = m3u8List[0];
            isM3u8Video = true;
            iframeCode = "";
        }else if(mp4List.length > 0){
            finalVideoUrl = mp4List[0];
            isM3u8Video = false;
        }

        // 提取视频 poster（预览图）
        // 优先从 <video poster="..."> 属性提取
        // 回退到 imgs[0]（兼容旧格式 RSS，poster 作为 <img> 输出在 <video> 前面）
        let videoPoster = "";
        if(finalVideoUrl){
            const posterReg = /<video[^>]*\sposter="([^"]+)"[^>]*>/i;
            const posterMatch = desc.match(posterReg);
            if(posterMatch){
                videoPoster = cleanMediaUrl(posterMatch[1]);
            }
        }

        const imgAttrReg = /(?:src|data-src|href)=["']([^"']+\.(jpg|jpeg|png|gif|webp)(?:\?[^"']*)?)["']/gi;
        let imgsRaw = [];
        let imgMatch;
        while((imgMatch = imgAttrReg.exec(txt + desc)) !== null){
            addImg(imgsRaw, imgMatch[1]);
        }
        const imgRawReg = /https?:\/\/[^<>"'\s]+\.(jpg|jpeg|png|gif|webp)(?:\?[^<>"'\s]*)?/gi;
        while((imgMatch = imgRawReg.exec(txt + desc)) !== null){
            addImg(imgsRaw, imgMatch[0]);
        }
        const imgs = [...new Set(imgsRaw)];

        list.push({
            title: titleRaw,
            link: link,
            date: date,
            media:{
                imgs: imgs,
                videos: []
            },
            videoUrl: finalVideoUrl,
            videoPoster: videoPoster,
            iframe: iframeCode,
            sourceName,
            sourceUrl,
            isM3u8Video: isM3u8Video,
            // 标记是否来自 twitter-rss.js 推特订阅（用于后端/前端的 720p 码率控制作用域）
            isTwitterRss: /twitter-rss/i.test(sourceUrl || "")
        });
    }
    return list;
}

function escapeReg(str){
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function renderSearchResult(keyword){
    searchResultBox.innerHTML = "";
    if(!keyword.trim()) return;
    const kw = keyword.trim();
    const list = localCacheArticles.filter(item=>{
        const titleRaw = getPureText(item.title);
        return titleRaw.includes(kw) && !hasBlockedKeyword(titleRaw);
    }).sort((a,b)=>new Date(b.date)-new Date(a.date));

    if(list.length===0){
        searchResultBox.innerHTML = `<div class="empty-tip">没有匹配结果</div>`;
        return;
    }

    let html = "";
    list.forEach(item=>{
        let titleRaw = getPureText(item.title);
        const reg = new RegExp(`(${escapeReg(kw)})`,"g");
        titleRaw = titleRaw.replace(reg,`<mark style="background:#34c759;color:#fff;padding:0 2px;">$1</mark>`);

        let cardHtml = buildCard(item,false);
        cardHtml = cardHtml.replace(/<div class="card-title">[\s\S]*?<\/div>/,`<div class="card-title">${titleRaw}</div>`);
        html += cardHtml;
    });
    searchResultBox.innerHTML = html;
    bindAllCardEvent();
    bindVideoPauseObserver();
    initHlsVideo();
}
searchInput.oninput = function(){
    renderSearchResult(this.value);
};

document.getElementById("importFeed").onclick = function(){
    document.getElementById("importFileInput").click();
};
document.getElementById("importFileInput").onchange = function(e){
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onload = ev=>{
        try{
            const data = JSON.parse(ev.target.result);
            let feedAddNum = 0;
            let favAddNum = 0;
            let kwAddNum = 0;

            // 兼容旧格式：纯数组（订阅源列表）
            if(Array.isArray(data)){
                data.forEach(item=>{
                    if(item.url && !feedList.some(f=>f.url === item.url)){
                        feedList.push(item);feedAddNum++;
                    }
                })
            }else{
                // 新格式：对象 {feeds, favorites, blockKeywords}
                if(Array.isArray(data.feeds)){
                    data.feeds.forEach(item=>{
                        if(item.url && !feedList.some(f=>f.url === item.url)){
                            feedList.push(item);feedAddNum++;
                        }
                    })
                }
                if(Array.isArray(data.favorites)){
                    data.favorites.forEach(item=>{
                        if(item.link && !favList.some(f=>f.link === item.link)){
                            favList.push(item);favAddNum++;
                        }
                    })
                }
                if(Array.isArray(data.blockKeywords)){
                    data.blockKeywords.forEach(kw=>{
                        if(kw && !blockKeywordList.some(k=>k === kw)){
                            blockKeywordList.push(kw);kwAddNum++;
                        }
                    })
                }
            }

            if(feedAddNum > 0){
                localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
                lastRefreshTime = 0;
                localStorage.removeItem(LAST_REFRESH_KEY);
            }
            if(favAddNum > 0){
                localStorage.setItem(FAV_KEY, JSON.stringify(favList));
            }
            if(kwAddNum > 0){
                saveBlockKeywords();
            }
            renderManage();
            renderKeywordList();

            let msg = "导入完成：";
            const parts = [];
            if(feedAddNum > 0) parts.push(`订阅源+${feedAddNum}`);
            if(favAddNum > 0) parts.push(`收藏+${favAddNum}`);
            if(kwAddNum > 0) parts.push(`屏蔽词+${kwAddNum}`);
            if(parts.length === 0) parts.push("没有新数据");
            msg += parts.join("，");
            showToast(msg);
        }catch(err){showToast("备份文件格式错误");}
        e.target.value = "";
    }
    reader.readAsText(file);
}
document.getElementById("exportAllBtn").onclick = function(){
    document.getElementById("exportModal").style.display = "flex";
}
document.getElementById("cancelExport").onclick = function(){
    document.getElementById("exportModal").style.display = "none";
}
document.getElementById("confirmExport").onclick = function(){
    const expFeeds = document.getElementById("exportFeeds").checked;
    const expFav = document.getElementById("exportFav").checked;
    const expKeywords = document.getElementById("exportKeywords").checked;

    if(!expFeeds && !expFav && !expKeywords){
        showToast("请至少选择一项要导出的数据");
        return;
    }

    const exportData = {};
    if(expFeeds) exportData.feeds = feedList;
    if(expFav) exportData.favorites = favList;
    if(expKeywords) exportData.blockKeywords = blockKeywordList;
    exportData.exportTime = new Date().toISOString();
    exportData.version = 1;

    const fileName = "rss备份_" + new Date().toISOString().slice(0,10).replace(/-/g,"") + ".json";
    exportJsonFile(exportData, fileName);
    document.getElementById("exportModal").style.display = "none";
}
document.getElementById("delAllFeed").onclick = function(){
    document.getElementById("clearFeeds").checked = true;
    document.getElementById("clearArticles").checked = true;
    document.getElementById("clearFav").checked = true;
    document.getElementById("clearKeywords").checked = true;
    document.getElementById("clearModal").style.display = "flex";
}
document.getElementById("cancelClear").onclick = function(){
    document.getElementById("clearModal").style.display = "none";
}
document.getElementById("confirmClear").onclick = function(){
    const clearFeeds = document.getElementById("clearFeeds").checked;
    const clearArticles = document.getElementById("clearArticles").checked;
    const clearFav = document.getElementById("clearFav").checked;
    const clearKeywords = document.getElementById("clearKeywords").checked;

    if(clearFeeds){
        feedList = [];
        localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
    }
    if(clearArticles){
        allArticles = [];
        localCacheArticles = [];
        localStorage.removeItem(ARTICLE_CACHE_KEY);
        localStorage.removeItem(LAST_REFRESH_KEY);
        lastRefreshTime = 0;
        homeIsCached = false;
        homeArticleHtml = "";
    }
    if(clearFav){
        favList = [];
        localStorage.setItem(FAV_KEY, JSON.stringify(favList));
    }
    if(clearKeywords){
        blockKeywordList = [];
        localStorage.setItem(BLOCK_KEYWORD_KEY, JSON.stringify(blockKeywordList));
    }

    document.getElementById("clearModal").style.display = "none";

    if(clearFeeds && clearArticles && clearFav && clearKeywords){
        readLinkSet = new Set();
        sessionStartReadSet = new Set();
        localStorage.removeItem(READ_KEY);
        currentArticles = [];
        renderedArticleCount = 0;
        renderPageNum = 1;
        articleBox.innerHTML = `<div class="empty-tip">暂无内容，请添加订阅源</div>`;
        showToast("已全部清空，阅读器已重置");
    }else{
        showToast("已清除所选内容");
    }

    if(clearFeeds || clearKeywords) renderManage();
    if(clearFav && pageFav.style.display !== "none") renderFav();
}

document.getElementById("saveEdit").onclick = function(){
    const idx = Number(document.getElementById("editIndex").value);
    const name = document.getElementById("editName").value.trim();
    const url = document.getElementById("editUrl").value.trim();
    const oldUrl = feedList[idx].url;
    if(feedList.some((f,i)=>i!==idx && f.url === url)){alert("该RSS链接已存在");return;}
    feedList[idx].name = name;
    feedList[idx].url = url;
    localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
    lastRefreshTime = 0;
    localStorage.removeItem(LAST_REFRESH_KEY);
    favList.forEach(item=>{if(item.sourceUrl === oldUrl) item.sourceUrl = url;})
    localStorage.setItem(FAV_KEY, JSON.stringify(favList));
    editModal.style.display = "none";
    renderManage();
}
document.getElementById("cancelEdit").onclick = ()=>editModal.style.display = "none";

function renderManage(){
    if(feedList.length === 0){
        feedPanel.innerHTML = `<div class="empty-tip" style="min-height:70vh;display:flex;align-items:center;justify-content:center;flex-direction:column;">暂无订阅源<br>请切换【添加订阅】页面新增RSS链接</div>`;
        return;
    }
    const isTw = (f) => /twitter-rss/i.test(f.url || "");
    const reverseFeed = [...feedList].reverse();
    const normalFeeds = reverseFeed.filter(f => !isTw(f));
    const twFeeds = reverseFeed.filter(isTw);
    // 普通订阅区与 Twitter 订阅区分别渲染，标题用两种颜色填充，标题右侧各带【全部标记】
    let html = "";
    html += renderFeedSection("普通订阅", normalFeeds, false);
    html += renderFeedSection("Twitter订阅", twFeeds, true);
    feedPanel.innerHTML = html;
    // 行内【编辑】【删除】按钮已移除（2026-11-18）：改为长按订阅源区域唤出操作面板
    // （标记已读 / 编辑 / 删除），见 bindFeedLongPress。
    bindFeedLongPress();
    feedPanel.onclick = async function(e){
        const markBtn = e.target.closest(".sec-mark-btn");
        if(markBtn){
            const isTwitter = markBtn.dataset.section === "twitter";
            const count = markSectionFeedsRead(isTwitter);
            if(count === 0){
                showToast(isTwitter ? "Twitter订阅区暂无内容可标记" : "普通订阅区暂无内容可标记");
            }else{
                showToast(`已将${isTwitter ? "Twitter订阅" : "普通订阅"}区的 ${count} 条内容标记为已读`);
            }
            afterMarkReadRefresh();
            return;
        }
        const avatarBtn = e.target.closest(".feed-avatar-btn");
        if(avatarBtn){
            await openSingleSource(avatarBtn.dataset.source);
            return;
        }
    }
}

// 管理页分区渲染：一个标题栏（颜色区分）+ 该区订阅源列表
function renderFeedSection(title, feeds, isTwitter){
    const secClass = isTwitter ? "section-twitter" : "section-normal";
    let html = `
    <div class="feed-section-title ${secClass}">
        <div class="sec-title-left">${title}<span class="sec-count">${feeds.length} 个</span></div>
        <button class="sec-mark-btn" data-section="${isTwitter ? "twitter" : "normal"}">全部标记</button>
    </div>`;
    if(feeds.length === 0){
        return html + `<div class="feed-section-empty">该分类暂无订阅源</div>`;
    }
    feeds.forEach((f, idx)=>{
        const realIndex = idx + 1;
        const avatarKey = (f.url || "") + "|" + (f.name || "");
        const avatarIndex = hashText(avatarKey);
        const avatarSvg = avatarIconSvg(avatarIndex);
        const avatarStyle = escapeAttr(getAvatarStyle(avatarKey));

        // 计算该订阅源的最新更新时间和未读数
        const feedItems = localCacheArticles.filter(item => String(item.sourceUrl || "").trim() === String(f.url || "").trim());
        let latestTime = "暂无数据";
        let unreadCount = 0;
        if(feedItems.length > 0){
            const sorted = feedItems.sort((a,b)=> new Date(b.date) - new Date(a.date));
            const latestDate = new Date(sorted[0].date);
            if(!Number.isNaN(latestDate.getTime())){
                const m = latestDate.getMonth() + 1;
                const d = latestDate.getDate();
                const h = String(latestDate.getHours()).padStart(2, "0");
                const mi = String(latestDate.getMinutes()).padStart(2, "0");
                latestTime = `最近更新于 ${m}/${d} ${h}:${mi}`;
            }
            unreadCount = feedItems.filter(item => !readLinkSet.has(item.link)).length;
        }

        const unreadBadge = unreadCount > 0 ? `<span class="feed-unread-badge-inline">${unreadCount > 99 ? "99+" : unreadCount}</span>` : "";

        html += `
        <div class="feed-item" data-idx="${feedList.indexOf(f)}" data-source-url="${f.url}">
            <div class="feed-left-area">
                <div class="feed-index">${realIndex}</div>
                <div class="card-avatar feed-avatar-btn" data-source="${f.url}" style="background:${avatarStyle};width:28px;height:28px;flex-shrink:0;cursor:pointer;" title="点击查看该订阅源">${feedAvatarInnerHtml(f.url, avatarSvg)}</div>
                <div class="feed-name-block">
                    <div class="feed-title-text">${escapeHtml(f.name||"未命名订阅")}</div>
                    <div class="feed-update-time">${unreadBadge}${latestTime}</div>
                </div>
            </div>
        </div>`;
    });
    return html;
}

// ─── 长按订阅源唤出小气泡操作菜单（标记已读 / 编辑 / 删除）─────
// 触摸端：长按 500ms 触发；桌面端：右键（contextmenu）兜底。
// 气泡为 fixed 定位、由 JS 计算贴近触发条目，非全屏遮罩。
// 注意 feedPanel.innerHTML 每次 renderManage 都会重建，监听器需重新绑定。
let feedActionTimer = null;
let feedActionIdx = -1;
function bindFeedLongPress(){
    const startLongPress = (e) => {
        const item = e.target.closest(".feed-item");
        if (!item) return;
        const idx = Number(item.dataset.idx);
        if (Number.isNaN(idx) || !feedList[idx]) return;
        clearTimeout(feedActionTimer);
        feedActionTimer = setTimeout(() => {
            feedActionTimer = null;
            // 触觉反馈（支持的设备），并抑制长按后残余的系统选择
            try { if (navigator.vibrate) navigator.vibrate(30); } catch(err) {}
            openFeedAction(idx, item);
        }, 500);
    };
    const cancelLongPress = () => {
        if (feedActionTimer) { clearTimeout(feedActionTimer); feedActionTimer = null; }
    };
    feedPanel.addEventListener("touchstart", startLongPress, {passive: true});
    ["touchend", "touchmove", "touchcancel"].forEach(ev =>
        feedPanel.addEventListener(ev, cancelLongPress, {passive: true})
    );
    // 桌面端右键兜底（preventDefault 同时抑制系统右键菜单）
    feedPanel.addEventListener("contextmenu", (e) => {
        const item = e.target.closest(".feed-item");
        if (!item) return;
        e.preventDefault();
        openFeedAction(Number(item.dataset.idx), item);
    });
}

function openFeedAction(idx, anchorEl){
    const f = feedList[idx];
    if (!f || !anchorEl) return;
    feedActionIdx = idx;
    document.getElementById("feedPopoverTitle").textContent = f.name || "未命名订阅";
    feedPopover.style.display = "block";
    // 先隐藏测量，再按触发条目位置贴近放置：默认贴条目右缘、与条目顶对齐，越界自动收回视口内
    feedPopover.style.visibility = "hidden";
    const r = anchorEl.getBoundingClientRect();
    const pop = feedPopover;
    const pw = pop.offsetWidth, ph = pop.offsetHeight;
    const M = 8; // 视口安全边距
    let top = r.top;
    if (top + ph > window.innerHeight - M) top = window.innerHeight - ph - M;
    if (top < M) top = M;
    let left = r.right + 6;                       // 首选：条目右侧
    if (left + pw > window.innerWidth - M) left = r.left - pw - 6; // 右侧放不下改左侧
    if (left < M) left = window.innerWidth - pw - M;               // 两侧都不行则贴右缘
    if (left < M) left = M;
    pop.style.top = Math.round(top) + "px";
    pop.style.left = Math.round(left) + "px";
    pop.style.visibility = "visible";
}

function closeFeedAction(){
    feedPopover.style.display = "none";
    feedActionIdx = -1;
}

document.getElementById("feedActionRead").onclick = function(){
    const idx = feedActionIdx;
    const f = feedList[idx];
    if (!f) return closeFeedAction();
    const count = markFeedItemsRead(f.url);
    closeFeedAction();
    showToast(`已将「${f.name || "该订阅"}」的 ${count} 条内容标记为已读`);
    afterMarkReadRefresh();
};

document.getElementById("feedActionEdit").onclick = function(){
    const idx = feedActionIdx;
    const f = feedList[idx];
    closeFeedAction();
    if (!f) return;
    document.getElementById("editIndex").value = idx;
    document.getElementById("editName").value = f.name || "";
    document.getElementById("editUrl").value = f.url;
    editModal.style.display = "flex";
};

document.getElementById("feedActionDel").onclick = function(){
    const idx = feedActionIdx;
    const f = feedList[idx];
    closeFeedAction();
    if (!f) return;
    feedList.splice(idx, 1);
    localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
    renderManage();
};

// 点气泡外任意位置 / 滚动 / 旋转屏幕时关闭（capture 捕获所有容器的滚动）
document.addEventListener("pointerdown", (e) => {
    if (feedPopover.style.display === "block" && !feedPopover.contains(e.target)) closeFeedAction();
});
window.addEventListener("scroll", closeFeedAction, {capture: true, passive: true});
window.addEventListener("resize", closeFeedAction);

// ─── 管理页顶部【全部标记】按钮（2026-11-18 移除）：已改为分区标题右侧各自的【全部标记】──

function getFeedCategoryByContent(sourceUrl){
    const items = localCacheArticles.filter(item => String(item.sourceUrl || "").trim() === String(sourceUrl || "").trim());
    if(items.length === 0) return "img";
    const hasVideo = items.some(item => item.isM3u8Video || item.videoUrl);
    return hasVideo ? "video" : "img";
}

document.getElementById("confirmAdd").onclick = function(){
    const feedName = document.getElementById("feedName").value.trim();
    const feedUrl = document.getElementById("feedUrl").value.trim();

    if (!feedUrl) {
        showToast("请填写RSS订阅链接");
        return;
    }
    if (feedList.some(item => item.url === feedUrl)) {
        showToast("该订阅源已存在");
        return;
    }

    feedList.push({
        name: feedName || "未命名订阅",
        category: getFeedCategoryByContent(feedUrl),
        url: feedUrl
    });
    localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
    lastRefreshTime = 0;
    localStorage.removeItem(LAST_REFRESH_KEY);

    document.getElementById("feedName").value = "";
    document.getElementById("feedUrl").value = "";
    showToast("订阅添加成功");
    initLoadAllCache();
    showPage(pageManage, "管理订阅");
}

// Twitter 订阅：通过 /twitter-rss?user=用户名 自动生成 RSS
document.getElementById("confirmAddTwitter").onclick = function(){
    let raw = document.getElementById("twitterUserInput").value.trim();
    if (!raw) {
        showToast("请输入 Twitter 用户名");
        return;
    }
    // 去掉 @ 前缀，只保留用户名部分
    let username = raw.replace(/^@+/, "").replace(/^https?:\/\/(x|twitter)\.com\//i, "").replace(/\/.*$/, "").trim();
    // 只允许字母、数字、下划线
    username = username.replace(/[^a-zA-Z0-9_]/g, "");
    if (!username) {
        showToast("用户名格式不正确");
        return;
    }

    // 固定使用官方 Pages 域名（不再依赖 location.origin）。
    // 旧版曾用 location.origin 拼接，导致经自定义域名 mypear.ccwu.cc 访问时，
    // 生成的 Twitter RSS 订阅地址也指向该自定义域名；该域名在手机端失效后订阅全部无法加载。
    // 改为固定官方域名后，无论从哪个域名进入，订阅地址始终可用。
    const twitterRssUrl = "https://rss-twitter-viewer.pages.dev" + "/twitter-rss?user=" + username;

    if (feedList.some(item => item.url === twitterRssUrl)) {
        showToast("该 Twitter 订阅已存在");
        return;
    }

    feedList.push({
        name: "@" + username,
        category: "video",
        url: twitterRssUrl
    });
    localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
    lastRefreshTime = 0;
    localStorage.removeItem(LAST_REFRESH_KEY);

    document.getElementById("twitterUserInput").value = "";
    showToast("Twitter 订阅添加成功：@" + username);
    initLoadAllCache();
    showPage(pageManage, "管理订阅");
}

// 关键字屏蔽管理
function saveBlockKeywords(){
    localStorage.setItem(BLOCK_KEYWORD_KEY, JSON.stringify(blockKeywordList));
}

function renderKeywordList(){
    const listEl = document.getElementById("keywordList");
    if(!listEl) return;
    if(blockKeywordList.length === 0){
        listEl.innerHTML = `<div style="color:#999;font-size:13px;padding:8px 4px;">暂无屏蔽关键字</div>`;
        return;
    }
    let html = "";
    blockKeywordList.forEach((kw, idx)=>{
        html += `<div class="keyword-tag">
            <span class="kw-text">${escapeHtml(kw)}</span>
            <button class="kw-edit" data-idx="${idx}" title="编辑">✎</button>
            <button class="kw-del" data-idx="${idx}" title="删除">×</button>
        </div>`;
    });
    listEl.innerHTML = html;
}

document.getElementById("addKeywordBtn").onclick = function(){
    const input = document.getElementById("blockKeywordInput");
    const kw = input.value.trim();
    if(!kw){
        showToast("请输入关键字");
        return;
    }
    if(blockKeywordList.some(k => k.toLowerCase() === kw.toLowerCase())){
        showToast("该关键字已存在");
        return;
    }
    blockKeywordList.push(kw);
    saveBlockKeywords();
    input.value = "";
    renderKeywordList();
    showToast("屏蔽关键字添加成功");
};

document.getElementById("keywordList").addEventListener("click", function(e){
    const t = e.target;
    const idx = Number(t.dataset.idx);
    if(!Number.isFinite(idx) || idx < 0) return;
    
    if(t.classList.contains("kw-del")){
        const kw = blockKeywordList[idx];
        blockKeywordList.splice(idx, 1);
        saveBlockKeywords();
        renderKeywordList();
        showToast(`已删除屏蔽：${kw}`);
    }
    if(t.classList.contains("kw-edit")){
        const oldKw = blockKeywordList[idx];
        const newKw = prompt("修改屏蔽关键字：", oldKw);
        if(newKw === null) return;
        const trimmed = newKw.trim();
        if(!trimmed){
            showToast("关键字不能为空");
            return;
        }
        if(blockKeywordList.some((k, i) => i !== idx && k.toLowerCase() === trimmed.toLowerCase())){
            showToast("该关键字已存在");
            return;
        }
        blockKeywordList[idx] = trimmed;
        saveBlockKeywords();
        renderKeywordList();
        showToast("关键字修改成功");
    }
});

// 全局 ESC 关闭弹窗
document.addEventListener("keydown", (e)=>{
    if(e.key === "Escape"){
        if(imgPreviewMask.style.display === "flex"){
            imgPreviewMask.style.display = "none";
        }
    }
});

window.onload = async function(){
    initVideoObserver();
    showPage(pageHome, "RSS媒体阅读器");
    initLoadAllCache();
}
