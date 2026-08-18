// ===== media.js (从 index.html 拆出) =====

// 封面回退：原生 <video poster> 加载失败没有 onerror 事件，这里主动探测候选图，
// 第一张能加载的设为封面。候选顺序：主图（代理/直连）→ data-poster-direct（直连）→ 备用代理。
// 解决「少部分封面不显示但能播」：代理封面偶发失败回退直连、直连封面失败回退代理。
function ensurePosterFallback(video){
    if(video.dataset.posterFixed === "1") return;
    video.dataset.posterFixed = "1"; // 标记已处理，避免重复探测
    const candidates = [];
    const push = u => { if(u && candidates.indexOf(u) === -1) candidates.push(u); };
    if(video.poster) push(video.poster);                 // 主图（可能代理或直连）
    if(video.dataset.posterDirect) push(video.dataset.posterDirect);
    try {
        const fb = JSON.parse(video.dataset.posterProxyFallbacks || "[]");
        fb.forEach(push);
    } catch(e){}
    if(candidates.length <= 1) return; // 无回退余地
    let idx = 0;
    const tryNext = () => {
        if(idx >= candidates.length) return;
        const url = candidates[idx++];
        const img = new Image();
        img.onload = () => { if(video.poster !== url) video.poster = url; };
        img.onerror = () => { tryNext(); };
        img.src = url;
    };
    tryNext();
}

function initVideoObserver(){
    if(videoObserver) return;
    videoObserver = new IntersectionObserver((entries)=>{
        entries.forEach(item=>{
            const video = item.target;
            if(item.isIntersecting){
                _visibleVideos.add(video);
                // 取消待执行的内存释放（视频重新进入视口）
                cancelPendingRelease(video);
                // 优化1：智能预加载 - 进入视口时加载元数据（封面+时长，很小）
                if(video.preload !== "auto" && !video.dataset.userAttempted){
                    video.preload = "metadata";
                }
                // 封面回退：主图加载失败时自动切到直连/备用代理（原生 poster 无 onerror）
                ensurePosterFallback(video);
                // 注：m3u8 不做预加载（与老版本一致）。
                // 之前的「视口即预热整条短视频/前30s」会在视口含多个视频时产生大量并发
                // media-proxy 请求，挤占 Cloudflare Function + 拖慢整体加载/播放速度。
                // 点击播放时由 hls.js 实时拉取即可（老版本实测 1 秒开播，无需预热）。
                // 优化5：内存优化恢复 - 滑回视口时恢复之前释放的视频
                if(video.dataset.savedTime && !video.src){
                    restoreVideoFromMem(video);
                }
            }else{
                _visibleVideos.delete(video);
                video.pause();
                if(video.hlsInstance){
                    video.hlsInstance.stopLoad();
                }
                // 预加载中的视频滑出视口：取消预加载
                if(video.dataset.preloading === "1"){
                    cancelHlsPreload(video);
                }
                // ③ 离屏即停缓冲：未播放的视频彻底停掉后台下载，省流量/降 CPU
                if(video.dataset.userAttempted !== "1"){
                    video.preload = "none";
                    // MP4：摘掉 src 真正终止后台下载（HLS 已 stopLoad/销毁）
                    if(video.classList.contains("media-video-mp4") && video.src && !video.dataset.savedSrc){
                        video.dataset.savedSrc = video.src;
                        video.dataset.savedTime = String(video.currentTime || 0);
                        video.removeAttribute("src");
                        video.load();
                    }
                }
                // 优化5：内存优化 - 长视频滑出视口且播放较多时释放内存
                tryReleaseVideoMemory(video);
            }
        })
    }, {threshold:0.01, rootMargin: "100px 0px 250px 0px"});
}

// 注：m3u8 预加载（preloadHlsFirstFrag）已移除，与老版本行为一致。
// 原因：视口含多个 m3u8 视频时并发预热会瞬间产生大量 media-proxy 请求，
// 挤占 Cloudflare Function 配额并拖累整体加载/播放速度（实测从 1s 开播退化为 25s+）。
// 点击播放时由 hls.js 实时拉取清单+分片即可，无需预热。

// 取消预加载（滑出视口或超时时调用）
function cancelHlsPreload(video){
    if(video.dataset.preloading === "1"){
        preloadCount = Math.max(0, preloadCount - 1);
        video.dataset.preloading = "0";
    }
    delete video.dataset.preloadMode;
    // 用户还没点击过，销毁 HLS 实例省资源
    if(video.hlsInstance && video.dataset.userAttempted !== "1"){
        try{ video.hlsInstance.destroy(); }catch(e){}
        video.hlsInstance = null;
        delete video.dataset.hlsLoaded;
    }
}

// 优化5：尝试释放视频内存（长视频+播放较多时）
// 带 2 秒防抖：滑出视口后延迟 2 秒再释放，避免快速来回滑动时频繁释放/恢复导致黑屏
const _videoReleaseTimers = new Map();
function tryReleaseVideoMemory(video){
    // 只对 MP4 视频做，HLS 已经 stopLoad 了
    if(!video.classList.contains("media-video-mp4")) return;
    // 播放超过 30 秒才释放（短视频没必要）
    if(!video.currentTime || video.currentTime < 30) return;
    // 没有 src 就不用释放了
    if(!video.src) return;

    // 用 video 元素作为 key，2 秒后执行释放
    // 如果 2 秒内视频重新进入视口，clearTimeout 会取消释放
    if(_videoReleaseTimers.has(video)){
        clearTimeout(_videoReleaseTimers.get(video));
    }
    _videoReleaseTimers.set(video, setTimeout(()=>{
        _videoReleaseTimers.delete(video);
        // 二次检查：如果视频已经恢复 src 或被用户点击过，不释放
        if(!video.src || video.dataset.userAttempted === "1" && !video.paused) return;
        video.dataset.savedTime = String(video.currentTime);
        video.dataset.savedSrc = video.src;
        video.removeAttribute("src");
        video.load();
    }, 2000));
}

// 取消待执行的释放（视频重新进入视口时调用）
function cancelPendingRelease(video){
    if(_videoReleaseTimers.has(video)){
        clearTimeout(_videoReleaseTimers.get(video));
        _videoReleaseTimers.delete(video);
    }
}

// 优化5：从内存恢复视频
function restoreVideoFromMem(video){
    const savedSrc = video.dataset.savedSrc;
    const savedTime = parseFloat(video.dataset.savedTime || "0");
    if(!savedSrc) return;

    video.src = savedSrc;
    if(savedTime > 0){
        const onLoaded = () => {
            try { video.currentTime = savedTime; } catch(e){}
            video.removeEventListener("loadedmetadata", onLoaded);
        };
        video.addEventListener("loadedmetadata", onLoaded);
    }
    delete video.dataset.savedTime;
    delete video.dataset.savedSrc;
}

function pauseOtherVideos(currentVideo){
    document.querySelectorAll(".media-video, .media-video-mp4").forEach(v=>{
        if(v !== currentVideo && !v.paused){
            v.pause();
            if(v.hlsInstance) v.hlsInstance.stopLoad();
        }
    });
    // ② 播放时集中带宽：停掉其他未播放视频的预加载/后台缓冲，把流量让给正在播放的视频
    document.querySelectorAll(".media-video, .media-video-mp4").forEach(v=>{
        if(v === currentVideo) return;
        if(v.dataset.userAttempted !== "1"){
            if(v.hlsInstance){ try{ v.hlsInstance.stopLoad(); }catch(e){} }
            if(v.dataset.preloading === "1") cancelHlsPreload(v);
            v.preload = "none";
        }
    });
}

// ② 播放停止后，恢复当前在视口内视频的预加载，保证继续滑动依然流畅（不抢带宽时再预载）
function resumeNearbyPreload(){
    _visibleVideos.forEach(v=>{
        if(v.dataset.userAttempted === "1") return;
        if(v.preload !== "auto"){
            v.preload = "metadata";
        }
        // 注：m3u8 预加载已移除（与老版本一致），原因见 videoObserver 处注释
    });
}

function getVideoErrorMessage(video, fallback = "视频播放失败"){
    const err = video && video.error;
    if(!err) return fallback;
    const isProxy = video.dataset.proxyVideo === "1";
    switch(err.code){
        case 1:
            return "视频播放已中断";
        case 2:
            return "视频加载失败，请检查网络或稍后重试";
        case 3:
            return "视频解码失败：当前浏览器不支持该视频格式";
        case 4:
            // 源错误：区分代理和直连
            if(isProxy) return "视频地址不可播放：代理返回的内容无效或链接已失效";
            return "视频地址不可播放：链接失效或资源类型不支持";
        default:
            return fallback;
    }
}

// 加载圈已移除：点击播放后主按钮图标即切换为“暂停”，已是足够反馈，不需要转圈
function setVideoLoading(video, on){ /* no-op */ }

function getPlayErrorMessage(err, video, fallback = "视频播放失败"){
    if(err && err.name === "NotAllowedError") return "请再点一次播放";
    if(err && err.name === "AbortError") return "";
    return getVideoErrorMessage(video, fallback);
}

// 提取 HLS 致命错误的诊断信息：失败分片的真实 URL（解开 media-proxy 包裹）、代理返回的状态码、错误类型
function _unwrapProxyUrl(u){
    try{
        const m = String(u).match(/[?&]url=([^&]+)/);
        if(m) return decodeURIComponent(m[1]);
    }catch(e){}
    return u;
}

function getHlsFailInfo(data){
    let rawUrl = "";
    if(data && data.frag){
        if(data.frag.url) rawUrl = data.frag.url;
        else if(data.frag.baseurl) rawUrl = data.frag.baseurl + (data.frag.relurl || "");
    }else if(data && data.response && data.response.url){
        rawUrl = data.response.url;
    }
    const code = (data && data.response && data.response.code) || "";
    const type = data ? data.type : "";
    const details = data ? data.details : "";
    // 优先给“解开代理包裹后的真实分片地址”，方便一眼看出是哪个 host / 哪条分片失败
    const url = _unwrapProxyUrl(rawUrl);
    return {rawUrl, url, code, type, details};
}

function getHlsErrorMessage(data, streamUrl, info){
    // 错误细分对用户无意义，统一为简洁提示；但网络类错误带上代理返回的状态码，便于定位
    // （403=域名未进白名单被代理拒绝；502=源站拉取失败/超时；其它=解码或格式问题）
    info = info || {};
    if(info.type === Hls.ErrorTypes.NETWORK_ERROR){
        const code = info.code ? `（代理返回${info.code}）` : "";
        return `视频加载失败${code}，请稍后重试`;
    }
    if(info.type === Hls.ErrorTypes.MEDIA_ERROR){
        return "视频解码失败，请稍后重试";
    }
    return "视频加载失败，请稍后重试";
}

function toggleVideoPlay(video){
    const wrapEl = video.closest(".video-single-wrap");
    // 点击即给出反馈：按钮切到“暂停”图标 + 显示加载圈，让用户确认点击已生效
    const showImmediateFeedback = () => {
        // 仅切换主播放按钮图标为“暂停”作为点击反馈，不再显示加载圈
        if(wrapEl){
            const pb = wrapEl.querySelector(".media-play-btn");
            if(pb) pb.innerHTML = pauseIconSvg();
        }
        video.dataset.userAttempted = "1";
    };
    if(video.classList.contains("media-video") && !video.dataset.hlsLoaded){
        showImmediateFeedback();
        startHlsVideo(video);
        return;
    }
    if(video.paused){
        showImmediateFeedback();
        pauseOtherVideos(video);
        // 已预加载的视频（HLS 已 stopLoad）重新拉起缓冲，避免点了却一直黑屏
        if(video.hlsInstance) video.hlsInstance.startLoad();
        video.play().catch(err => {
            setVideoLoading(video, false);
            console.warn("视频播放失败：", err);
            // 仅在用户主动点击播放后才提示错误
            if(video.dataset.userAttempted === "1"){
                const msg = getPlayErrorMessage(err, video, "视频播放失败");
                if(msg) showToast(msg);
            }
        });
    }else{
        delete video.dataset.pendingPlay;
        setVideoLoading(video, false);
        video.pause();
        if(video.hlsInstance) video.hlsInstance.stopLoad();
        // 播放停止：恢复附近视频预加载，继续滑动不卡
        resumeNearbyPreload();
    }
}

// 优化4：MP4 视频加载错误自动重试（切换 fallback 源）
// 仅在用户主动点击播放后才提示错误
function bindVideoErrorRetry(video){
    if(video.dataset.errorRetryBound) return;
    video.dataset.errorRetryBound = "1";
    video.addEventListener("error", () => {
        // 只对 MP4 做自动 fallback 重试
        if(!video.classList.contains("media-video-mp4")) return;
        if(video.dataset.errorRetried) {
            // 仅在用户主动播放后才提示
            if(video.dataset.userAttempted === "1"){
                const msg = getVideoErrorMessage(video, "视频加载失败");
                if(msg && !video.dataset.errorShown){
                    video.dataset.errorShown = "1";
                    showToast(msg);
                }
            }
            return;
        }
        video.dataset.errorRetried = "1";
        console.log("视频加载失败，尝试切换备用源...");
        // 尝试 fallback 到下一个代理或直连
        if(fallbackMediaProxy(video)){
            // 切换成功，重新加载
            video.load();
        }
    });
}
// 优化6：低网速检测 - waiting 频繁触发时提示
// 仅在用户主动播放后才提示
function bindSlowNetworkDetect(video){
    if(video.dataset.slowNetBound) return;
    video.dataset.slowNetBound = "1";

    let waitingTimes = [];
    let slowWarned = false;

    video.addEventListener("waiting", () => {
        if(slowWarned) return;
        // 仅在用户主动播放后检测
        if(video.dataset.userAttempted !== "1") return;
        const now = Date.now();
        // 只保留最近 10 秒内的 waiting 记录
        waitingTimes = waitingTimes.filter(t => now - t < 10000);
        waitingTimes.push(now);
        // 10 秒内出现 3 次以上 waiting，认为网络较慢
        if(waitingTimes.length >= 3 && !video.dataset.slowWarnShown){
            video.dataset.slowWarnShown = "1";
            slowWarned = true;
            // 网络慢由播放器自身缓冲体现，不再弹 toast 打扰用户
        }
    });

    // 播放顺畅一段时间后重置计数（用户可能切换到了好网络）
    video.addEventListener("playing", () => {
        if(slowWarned) return;
        const now = Date.now();
        waitingTimes = waitingTimes.filter(t => now - t < 10000);
    });
}


function formatMediaTime(seconds){
    if(!Number.isFinite(seconds) || seconds < 0) return "00:00";
    const total = Math.ceil(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mm = String(m).padStart(2, "0");
    const ss = String(s).padStart(2, "0");
    if(h > 0) return `${String(h).padStart(2, "0")}:${mm}:${ss}`;
    return `${mm}:${ss}`;
}

function getBufferedPercent(video){
    if(!Number.isFinite(video.duration) || video.duration <= 0 || !video.buffered || video.buffered.length === 0){
        return 0;
    }
    let end = 0;
    for(let i = 0; i < video.buffered.length; i++){
        if(video.currentTime >= video.buffered.start(i) && video.currentTime <= video.buffered.end(i)){
            end = video.buffered.end(i);
            break;
        }
        end = Math.max(end, video.buffered.end(i));
    }
    return Math.min(100, Math.max(0, (end / video.duration) * 100));
}

function updateMediaControls(video){
    const wrap = video.closest(".video-single-wrap");
    if(!wrap) return;
    const playBtn = wrap.querySelector(".media-play-btn");
    const muteBtn = wrap.querySelector(".media-mute-btn");
    const progress = wrap.querySelector(".media-progress");
    const timeText = wrap.querySelector(".media-time");
    if(playBtn){
        playBtn.innerHTML = video.paused ? playIconSvg() : pauseIconSvg();
        playBtn.setAttribute("aria-label", video.paused ? "播放" : "暂停");
    }
    if(muteBtn){
        const muted = video.muted || video.volume === 0;
        muteBtn.innerHTML = muted ? muteIconSvg() : volumeIconSvg();
        muteBtn.setAttribute("aria-label", muted ? "取消静音" : "静音");
    }
    if(progress){
        const canSeek = Number.isFinite(video.duration) && video.duration > 0;
        progress.disabled = !canSeek;
        let playedPercent = 0;
        let bufferedPercent = 0;
        if(canSeek){
            playedPercent = Math.min(100, Math.max(0, (video.currentTime / video.duration) * 100));
            bufferedPercent = Math.max(playedPercent, getBufferedPercent(video));
        }
        progress.style.setProperty("--played", `${playedPercent}%`);
        progress.style.setProperty("--buffered", `${bufferedPercent}%`);
        if(canSeek && !progress.dataset.dragging){
            progress.value = Math.round((video.currentTime / video.duration) * 1000) || 0;
        }
    }
    if(timeText){
        const canShowTime = !video.paused && Number.isFinite(video.duration) && video.duration > 0;
        if(canShowTime){
            const remain = Math.max(video.duration - video.currentTime, 0);
            timeText.textContent = formatMediaTime(remain);
            timeText.classList.add("show");
        }else{
            timeText.textContent = "00:00";
            timeText.classList.remove("show");
        }
    }
    video.classList.toggle("is-playing", !video.paused);
}

function isMediaFullscreen(wrap, video){
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    if(fsEl === wrap || fsEl === video) return true;
    // iOS native video fullscreen
    if(video.webkitDisplayingFullscreen) return true;
    return false;
}

function exitMediaFullscreen(wrap, video){
    if(document.exitFullscreen) {
        document.exitFullscreen().catch(()=>{});
    } else if(document.webkitExitFullscreen) {
        document.webkitExitFullscreen();
    } else if(video.webkitExitFullscreen) {
        video.webkitExitFullscreen();
    }
}

function requestMediaFullscreen(wrap, video){
    const target = wrap || video;
    if(isMediaFullscreen(wrap, video)){
        exitMediaFullscreen(wrap, video);
        return;
    }
    if(target.requestFullscreen) {
        target.requestFullscreen().catch(()=>{});
    } else if(target.webkitRequestFullscreen) {
        target.webkitRequestFullscreen();
    } else if(video.webkitEnterFullscreen) {
        video.webkitEnterFullscreen();
    } else {
        showToast("当前浏览器不支持全屏");
    }
}

function updateFullscreenBtnIcon(video){
    const wrap = video.closest(".video-single-wrap");
    if(!wrap) return;
    const btn = wrap.querySelector(".media-fullscreen-btn");
    if(!btn) return;
    if(isMediaFullscreen(wrap, video)){
        btn.innerHTML = exitFullscreenIconSvg();
        btn.setAttribute("aria-label", "退出全屏");
    }else{
        btn.innerHTML = fullscreenIconSvg();
        btn.setAttribute("aria-label", "全屏");
    }
}

function bindCustomMediaControls(video){
    const wrap = video.closest(".video-single-wrap");
    if(!wrap || video.dataset.controlBind) return;
    video.dataset.controlBind = "1";
    const controls = wrap.querySelector(".custom-media-controls");
    if(!controls) return;
    const playBtn = controls.querySelector(".media-play-btn");
    const progress = controls.querySelector(".media-progress");
    const muteBtn = controls.querySelector(".media-mute-btn");
    const fullscreenBtn = controls.querySelector(".media-fullscreen-btn");

    controls.addEventListener("click", e => e.stopPropagation());
    if(playBtn){
        playBtn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            toggleVideoPlay(video);
        };
    }
    if(muteBtn){
        muteBtn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            video.muted = !video.muted;
            updateMediaControls(video);
        };
    }
    if(fullscreenBtn){
        fullscreenBtn.onclick = e => {
            e.preventDefault();
            e.stopPropagation();
            requestMediaFullscreen(wrap, video);
        };
    }
    // 监听全屏状态变化，更新按钮图标（用单次全局监听替代每个视频单独监听，避免内存泄漏）
    if(!window._fullscreenMediaBound){
        window._fullscreenMediaBound = true;
        ["fullscreenchange","webkitfullscreenchange"].forEach(evt=>{
            document.addEventListener(evt, ()=>{
                document.querySelectorAll(".media-video, .media-video-mp4").forEach(v=>updateFullscreenBtnIcon(v));
            });
        });
    }
    if(video.webkitSupportsFullscreen){
        video.addEventListener("webkitbeginfullscreen", ()=>updateFullscreenBtnIcon(video));
        video.addEventListener("webkitendfullscreen", ()=>updateFullscreenBtnIcon(video));
    }
    if(progress){
        progress.addEventListener("pointerdown", e => {
            e.stopPropagation();
            progress.dataset.dragging = "1";
        });
        progress.addEventListener("input", e => {
            e.stopPropagation();
            if(Number.isFinite(video.duration) && video.duration > 0){
                video.currentTime = (Number(progress.value) / 1000) * video.duration;
            }
        });
        progress.addEventListener("pointerup", e => {
            e.stopPropagation();
            delete progress.dataset.dragging;
            updateMediaControls(video);
        });
    }

    ["play","pause","timeupdate","durationchange","loadedmetadata","volumechange","ended"].forEach(evt=>{
        video.addEventListener(evt, ()=>updateMediaControls(video));
    });
    // 优化3：progress 事件节流（100ms 最多一次，减少 DOM 操作）
    let _progressTimer = null;
    video.addEventListener("progress", ()=>{
        if(_progressTimer) return;
        _progressTimer = setTimeout(()=>{
            _progressTimer = null;
            updateMediaControls(video);
        }, 100);
    });
    updateMediaControls(video);
}

function startHlsVideo(video){
    const sources = [fullDecodeXml(video.dataset.src), fullDecodeXml(video.dataset.altSrc)].filter(Boolean);
    const uniqueSources = [...new Set(sources)];
    let sourceIndex = Number(video.dataset.hlsAttempt || 0);
    const streamUrl = uniqueSources[sourceIndex] || uniqueSources[0];
    if(!streamUrl) return;

    pauseOtherVideos(video);

    // 缓冲超时保护：用户主动点击后若 12 秒仍无元数据（时长），说明代理卡死/源失效，
    // 明确报错并收起加载圈，避免“按钮变了却一直黑屏、也不提示”的困惑。
    if(video.dataset.userAttempted === "1"){
        if(video._loadTimeout) clearTimeout(video._loadTimeout);
        video._loadTimeout = setTimeout(() => {
            if(video.dataset.userAttempted === "1" && !video.dataset.loadedMeta){
                setVideoLoading(video, false);
                showToast("视频缓冲超时，请稍后重试");
            }
        }, 12000);
    }

    const playNow = (retry = true) => {
        video.play().catch(err => {
            console.warn("m3u8播放失败：", err);
            if(retry && err && err.name !== "NotAllowedError"){
                // 缓冲不足时自动重试：等待 canplay/loadeddata 或超时后重试
                const retryPlay = ()=>{
                    video.removeEventListener("canplay", retryPlay);
                    video.removeEventListener("loadeddata", retryPlay);
                    playNow(false);
                };
                video.addEventListener("canplay", retryPlay, {once:true});
                video.addEventListener("loadeddata", retryPlay, {once:true});
                setTimeout(()=>playNow(false), 450);
            }else{
                // 仅在用户主动点击播放后才提示错误
                if(video.dataset.userAttempted === "1"){
                    const msg = getPlayErrorMessage(err, video, "m3u8播放失败");
                    if(msg) showToast(msg);
                }
            }
        });
    };

    if (video.dataset.hlsLoaded) {
        if(video.hlsInstance) video.hlsInstance.startLoad();
        playNow();
        return;
    }

    // Hls.js 优先（非 Safari 或 Safari 未声明原生支持时）
    if (window.Hls && Hls.isSupported()) {
        if(video.hlsInstance){
            try{ video.hlsInstance.destroy(); }catch(e){}
            video.hlsInstance = null;
        }
        // hls.js 配置：对齐老版本简洁配置（老版本在 Cloudflare Function 代理下
        // 实测 1 秒开播，无需手动降初始带宽估计/强制 720p 封顶等保守 ABR 设置）。
        // 保留：enableWorker / capLevelToPlayerSize / storage=null 等无副作用项。
        const hls = new Hls({
            enableWorker: true,
            lowLatencyMode: true,         // 短片段起播更快（老版本即此值）
            maxBufferLength: 30,
            capLevelToPlayerSize: true,
            storage: null,
            autoStartLoad: true
        });
        video.hlsInstance = hls;
        // 拿到元数据即清除加载圈（已能播放）；同时设定缓冲超时保护，避免“点了不播也不报错”
        if(!video._metaBound){
            video._metaBound = true;
            video.addEventListener("loadedmetadata", () => {
                video.dataset.loadedMeta = "1";
                if(video._loadTimeout){ clearTimeout(video._loadTimeout); video._loadTimeout = null; }
                setVideoLoading(video, false);
            });
        }
        hls.attachMedia(video);
        hls.on(Hls.Events.MEDIA_ATTACHED, () => {
            hls.loadSource(streamUrl);
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // 清单解析成功：直接开始缓冲并播放。
            // 720p 封顶/强制起始档由代理层 filterMasterPlaylist 完成（带 src=twrss 时自动剔除 >720p），
            // 客户端不再二次限制，避免与代理层重复叠加导致起播被压到过低码率。
            hls.startLoad();
            video.dataset.hlsLoaded = "1";
            // 成功解析清单 → 重置致命重试计数（只有「连续」致命才重试，自愈成功即清零）
            delete video.dataset.hlsFatalRetry;
            // 预加载模式不自动播放，仅加载数据；正常模式点击一次即播放
            if(video.dataset.preloadMode !== "1"){
                playNow();
            }
        });
        hls.on(Hls.Events.ERROR, (event, data) => {
            if(data && data.fatal){
                const info = getHlsFailInfo(data);
                console.warn("[HLS致命错误诊断] type=", info.type, "code=", info.code, "details=", info.details, "失败分片=", info.url);
                const nextIndex = sourceIndex + 1;
                if(nextIndex < uniqueSources.length){
                    // 有备用源，自动切换（静默重试，不打扰用户）
                    if(video.dataset.userAttempted === "1"){
                        console.warn("m3u8 致命错误，自动切换备用源：", getHlsErrorMessage(data, streamUrl, info));
                    }
                    video.dataset.hlsAttempt = String(nextIndex);
                    delete video.dataset.hlsLoaded;
                    try{ hls.destroy(); }catch(e){}
                    video.hlsInstance = null;
                    startHlsVideo(video);
                }else{
                    // 无备用源（推特 m3u8 常态）：先清理损坏实例，避免被复用为“死实例”
                    // 仅 NETWORK 类错误、且用户主动播放时，做有限次数“销毁+重建”自愈（救回瞬态失败）
                    const isNetwork = info.type === Hls.ErrorTypes.NETWORK_ERROR;
                    const tried = Number(video.dataset.hlsFatalRetry || 0);
                    const MAX_FATAL_RETRY = 2;
                    if(video.dataset.userAttempted === "1" && isNetwork && tried < MAX_FATAL_RETRY){
                        video.dataset.hlsFatalRetry = String(tried + 1);
                        delete video.dataset.hlsLoaded;
                        try{ hls.destroy(); }catch(e){}
                        video.hlsInstance = null;
                        startHlsVideo(video);   // 从头重建，重试这次致命加载
                        return;
                    }
                    // 重试耗尽或无需重试：清理损坏实例（含预加载阶段）→ 下次点击能从头重建，不会复用死实例
                    delete video.dataset.hlsLoaded;
                    if(video.dataset.preloading === "1"){
                        video.dataset.preloading = "0";
                        preloadCount = Math.max(0, preloadCount - 1);
                    }
                    try{ hls.destroy(); }catch(e){}
                    video.hlsInstance = null;
                    setVideoLoading(video, false);
                    if(video.dataset.userAttempted === "1"){
                        showToast(getHlsErrorMessage(data, streamUrl, info));
                    }
                }
            }
        });
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        // Safari 原生 HLS
        video.src = streamUrl;
        const markNativeLoaded = ()=>{
            video.dataset.hlsLoaded = "1";
            video.removeEventListener("loadedmetadata", markNativeLoaded);
            video.removeEventListener("canplay", markNativeLoaded);
        };
        video.addEventListener("loadedmetadata", markNativeLoaded, {once:true});
        video.addEventListener("canplay", markNativeLoaded, {once:true});
        playNow();
    } else {
        if(video.dataset.userAttempted === "1"){
            showToast("当前浏览器不支持m3u8播放");
        }
    }
}




function initHlsVideo(){
    document.querySelectorAll(".media-video[data-m3u8], .media-video-mp4").forEach(video=>{
        if (video.dataset.playerBind) return;
        video.dataset.playerBind = "1";
        const wrap = video.closest(".video-single-wrap") || video;
        if(!wrap.dataset.mediaClickBind){
            wrap.dataset.mediaClickBind = "1";
            wrap.addEventListener("click", (e)=>{
                e.preventDefault();
                e.stopPropagation();
                toggleVideoPlay(video);
            });
        }
        if(video.classList.contains("media-video")){
            video.addEventListener("play", ()=>{
            if(!video.dataset.hlsLoaded) {
                video.pause();
                startHlsVideo(video);
            } else if(video.hlsInstance) {
                video.hlsInstance.startLoad();
            }
        });
        }
        bindCustomMediaControls(video);
        // 优化4：绑定错误自动重试
        bindVideoErrorRetry(video);
        // 优化6：绑定低网速检测
        bindSlowNetworkDetect(video);
        // 播放开始：原生 poster 会自动让位于视频画面；清除缓冲超时计时器
        video.addEventListener("playing", () => {
            if(video._loadTimeout){ clearTimeout(video._loadTimeout); video._loadTimeout = null; }
        });
    });
}

function bindVideoPauseObserver(){
    if(!videoObserver) initVideoObserver();

    // 清除旧绑定，防止重复监听
    document.querySelectorAll(".media-video, .media-video-mp4").forEach(v=>{
        videoObserver.unobserve(v);
        delete v.dataset.observeBind;
    });

    // 监听M3U8视频
    document.querySelectorAll(".media-video").forEach(v=>{
        if(!v.dataset.observeBind){
            videoObserver.observe(v);
            v.dataset.observeBind = "1";
        }
    });

    // 额外监听MP4视频，滑出屏幕自动暂停
    document.querySelectorAll(".media-video-mp4").forEach(v=>{
        if(!v.dataset.observeBind){
            videoObserver.observe(v);
            v.dataset.observeBind = "1";
        }
    });
}

