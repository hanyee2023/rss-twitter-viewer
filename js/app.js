// ===== app.js (从 index.html 拆出) =====
function renderFav(){
    if(scrollObserver) scrollObserver.disconnect();
    renderPageNum = 1;
    loadLock = false;
    if(favList.length === 0) {
        favPanel.innerHTML = `<div class="empty-tip" style="min-height:70vh;display:flex;align-items:center;justify-content:center;flex-direction:column;">暂无收藏内容<br>浏览主页卡片点击收藏按钮添加</div>`;
        return;
    }
    const sortedFavList = [...favList].sort((a,b)=>new Date(b.date).getTime() - new Date(a.date).getTime());
    const slice = sortedFavList.slice(0, PAGE_SIZE);
    let html = "";
    slice.forEach(item => html += buildCard(item, true));
    const remain = sortedFavList.length - slice.length;
    if(remain > 0){
        html += `<div class="load-more-tip" id="favLoadMore">滚动加载更多...</div>`;
    }else{
        html += `<div class="bottom-tip">全部收藏加载完毕</div>`;
    }
    favPanel.innerHTML = html;
    bindAllCardEvent();
    bindVideoPauseObserver();
    initHlsVideo();
    const favLoad = document.getElementById("favLoadMore");
    if(favLoad){
        const favObserver = new IntersectionObserver(async (e)=>{
            if(e[0].isIntersecting && !loadLock){
                loadLock = true;
                renderPageNum += 1;
                const favSlice = sortedFavList.slice(0, renderPageNum * PAGE_SIZE);
                let favHtml = "";
                favSlice.forEach(i=>favHtml += buildCard(i,true));
                const rem = sortedFavList.length - favSlice.length;
                if(rem>0) favHtml += `<div class="load-more-tip" id="favLoadMore">滚动加载更多...</div>`;
                else favHtml += `<div class="bottom-tip">全部收藏加载完毕</div>`;
                favPanel.innerHTML = favHtml;
                bindAllCardEvent();
                bindVideoPauseObserver();
                initHlsVideo();
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
            const imgs = JSON.parse(this.dataset.imggroup);
            currentPreviewImgs = imgs;
            const box = this.closest(".grid-img-box");
            const allBoxes = box.parentElement.querySelectorAll(".grid-img-box");
            const clickIndex = Array.from(allBoxes).indexOf(box);
            renderPreviewSlider(imgs, clickIndex);
            imgPreviewMask.style.display = "flex";
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
            const target = allArticles.find(i=>i.link === link);
            if(!target) return;
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
    document.querySelectorAll(".tweet-card").forEach(card => {
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

function saveRssCache(url, items){
    try{
        const key = RSS_CACHE_PREFIX + url;
        localStorage.setItem(key, JSON.stringify({
            items: items,
            time: Date.now()
        }));
    }catch(e){
        // 容量不足时清理旧的源缓存后重试一次
        cleanExpiredRssCache();
        try{
            const key = RSS_CACHE_PREFIX + url;
            localStorage.setItem(key, JSON.stringify({
                items: items,
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
                    // 成功加载，保存缓存
                    if(items && items.length > 0){
                        saveRssCache(f.url, items);
                    }
                    allGroups.push(items);
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
            const cleaned = cleanMediaUrl(url);
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
    let html = "";
    const reverseFeed = [...feedList].reverse();
    reverseFeed.forEach((f, idx)=>{
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
                <div class="card-avatar feed-avatar-btn" data-source="${f.url}" style="background:${avatarStyle};width:36px;height:36px;flex-shrink:0;cursor:pointer;" title="点击查看该订阅源">${avatarSvg}</div>
                <div class="feed-name-block">
                    <div class="feed-title-text">${escapeHtml(f.name||"未命名订阅")}</div>
                    <div class="feed-update-time">${unreadBadge}${latestTime}</div>
                </div>
            </div>
            <div class="feed-btn-group">
                <button class="edit" data-idx="${feedList.indexOf(f)}" title="编辑">${editIconSvg()}</button>
                <button class="del" data-idx="${feedList.indexOf(f)}" title="删除">${trashIconSvg()}</button>
            </div>
        </div>`;
    })
    feedPanel.innerHTML = html;
    feedPanel.onclick = async function(e){
        const avatarBtn = e.target.closest(".feed-avatar-btn");
        const delBtn = e.target.closest(".del");
        const editBtn = e.target.closest(".edit");
        if(avatarBtn){
            await openSingleSource(avatarBtn.dataset.source);
            return;
        }
        if(delBtn){
            const idx = Number(delBtn.dataset.idx);
            feedList.splice(idx,1);
            localStorage.setItem(FEED_KEY, JSON.stringify(feedList));
            renderManage();
        }
        if(editBtn){
            const idx = Number(editBtn.dataset.idx);
            const f = feedList[idx];
            document.getElementById("editIndex").value = idx;
            document.getElementById("editName").value = f.name||"";
            document.getElementById("editUrl").value = f.url;
            editModal.style.display = "flex";
        }
    }
}

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

    const twitterRssUrl = location.origin + "/twitter-rss?user=" + username;

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
