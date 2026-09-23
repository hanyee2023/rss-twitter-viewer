# RSS媒体阅读器

一个轻量级本地 RSS 媒体阅读器，适合个人自用。前端为纯静态页面（浏览器直接运行），后端代理由 Cloudflare Pages Functions 提供。支持添加 RSS 订阅源、聚合展示图文 / 视频内容、收藏、搜索、已读隐藏、订阅导入导出，以及针对部分国外媒体资源的代理播放。

当前版本：`4.9 稳定版`

<img width="390" height="848" alt="1" src="https://github.com/user-attachments/assets/84abcdf1-6814-4861-93ec-5bc7740c3c6f" /><img width="392" height="849" alt="5" src="https://github.com/user-attachments/assets/40bf5151-3aab-48f6-a6df-85b507f4d13f" /><img width="391" height="851" alt="4" src="https://github.com/user-attachments/assets/20ebe23a-acf7-4248-9d51-9beedba66ef1" /><img width="391" height="851" alt="3" src="https://github.com/user-attachments/assets/3aaa09a5-3188-46ca-a041-306540ecd3f9" /><img width="390" height="850" alt="2" src="https://github.com/user-attachments/assets/1ddcacfa-09e9-4693-8487-da8833975343" />

## 功能特点

- 本地添加和管理 RSS 订阅源
- 支持图片类 RSS 和视频类 RSS
- 支持一键导入、导出订阅源 JSON
- 首页聚合展示所有订阅内容，并按发布时间从新到旧排列
- 支持图片宫格展示和大图预览（滑动切换）
- 支持 MP4 视频播放
- 支持 m3u8 视频播放，基于 HLS.js
- MP4 和 m3u8 使用统一的自定义控制栏（播放 / 暂停、进度条、缓冲指示、剩余时长、静音、全屏）
- 支持收藏内容
- 支持关键词搜索标题
- 支持已读隐藏，避免下次打开重复显示已读内容
- 支持本地文章缓存，二次打开可先显示上次内容
- 支持 RSS 分批加载，减少大量订阅源同时请求造成的卡顿
- 支持推特 / X / twimg 等指定域名媒体资源代理
- 视频缓冲自愈：HLS 致命错误自动恢复，显著降低"播放几秒自动暂停 / 有时长不播"的概率

## 使用方式

直接打开 `index.html` 即可使用（需配合部署后的 Functions 代理才能播放被墙的媒体资源）。

如果部署到 Cloudflare Pages、GitHub Pages 或其他静态网页服务，也可以直接访问部署后的页面。本项目使用 Cloudflare Pages Functions 作为 RSS 拉取与媒体代理后端，需绑定 Cloudflare 账号并配置 Pages 项目。

首次使用时，在"添加订阅"页面粘贴 RSS 地址，然后选择订阅类型：

- 图片类 RSS
- 视频类 RSS

添加后切换到主页，阅读器会自动加载订阅内容。

## 数据保存

本项目默认使用浏览器本地存储，不依赖账号系统。

本地保存的数据包括：

- RSS 订阅源
- 收藏内容
- 已读记录
- 最近一次成功加载的文章缓存
- 最近一次刷新时间

这些数据保存在当前浏览器中。如果更换浏览器、清除浏览器数据或换设备，数据不会自动同步。

## 代理说明

项目内将 RSS 拉取代理和媒体资源代理分开处理。

RSS 代理入口：

```js
const RSS_PROXY_ENDPOINTS = [
    "https://rss-twitter-viewer.pages.dev/rss-proxy",
    "https://rss-twitter-viewer.pages.dev/proxy"
];
```

媒体代理入口：

```js
const MEDIA_PROXY_ENDPOINT = "https://rss-twitter-viewer.pages.dev/media-proxy";
```

默认需要代理的域名（内置，代码写死、UI 中只读）包括 twitter/x/twimg 系、xcancel、niter、redgifs、rsshub.app、phe69、htumeng.com 等。

**扩展代理域名不再需要改代码**：在阅读器底部【管理订阅】与【收藏】之间的「代理域名」按钮，打开的是与「收藏 / 添加订阅」一致的全屏管理页（RSS 代理 与 媒体代理 两区之间用绿色分隔线隔开，按钮统一蓝色），可分别给 **RSS 代理** 和 **媒体代理** 增删域名，点「保存并同步」即写入后端 KV（`RSS_CACHE` 命名空间下的 `proxy_rss_user` / `proxy_media_user` 键），前后端自动生效。

> 安全：写入接口 `/proxy-config` 需要管理令牌，令牌在服务端环境变量 `PROXY_ADMIN_TOKEN` 中设置，界面里输入的令牌须与它一致；未设置则拒绝写入，防止被当开放代理滥用。

普通国内图片、MP4、m3u8 链接会优先由浏览器直接加载。匹配到上述域名的媒体链接会通过 `media-proxy` 代理。

Twitter 订阅通过 Nitter 实例（asia.aguea.com）获取推文内容，媒体链接自动替换为 Twitter 官方 CDN 域名（`pbs.twimg.com`、`video.twimg.com`），通过代理加载以获得更快的速度。

## m3u8 播放说明

m3u8 视频使用 HLS.js 播放，已针对代理视频场景优化：

- 关闭低延迟模式（`lowLatencyMode: false`），使用标准点播缓冲策略
- 缓冲长度 `maxBufferLength: 30` 秒，回退缓冲 `backBufferLength: 30` 秒，平衡卡顿与内存占用（旧版为 60 秒，已下调以减少长视频内存压力）
- 自适应码率从低级别开始（`startLevel: -1`），快速起播避免黑屏
- 根据播放器尺寸自动限制最高分辨率（`capLevelToPlayerSize: true`，最高 720p），避免高码率拖垮弱网
- **致命错误自愈**：NETWORK_ERROR 自动 `startLoad()`、MEDIA_ERROR 自动 `recoverMediaError()`，最多重试 3 次，显著降低"播几秒自动暂停 / 有时长不播"的概率
- **缓冲遮罩**：加载等待时显示半透明"缓冲中"提示，区分"正在缓冲"与"真卡死"
- 代理视频采用两次点击模式：第一次加载 manifest，第二次点击播放

## 布局与适配

- 移动端**单列**布局，卡片宽度自适应，无双列瀑布流
- 折叠屏展开态也以单列呈现，避免"左侧优先加载"带来的割裂感与卡片乱跳
- 顶部 / 底部悬浮栏为磨砂玻璃固定栏，普通手机上自动贴合屏幕边缘

> 说明：早期版本曾尝试折叠屏双列瀑布流（横竖屏卡片高度差会导致留白 / 乱跳），经使用验证体验不佳，已在 `4.9` 稳定版中取消，回归简洁稳定的单列。

## 性能优化

当前版本针对较多订阅源做了基础优化：

- 打开页面时优先显示本地文章缓存
- 后台再检查 RSS 更新
- RSS 请求限制为分批并发，默认每批 `5` 个
- 滚动加载更多时只追加新卡片，不重绘已有卡片
- 手动刷新增加刷新锁，避免重复请求
- 自动刷新增加时间间隔，减少短时间重复加载

如需调整 RSS 并发数量，可以修改：

```js
const RSS_CONCURRENCY = 5;
```

如果订阅源较多但手机性能一般，建议保持在 `3` 到 `5` 之间。

## 部署说明（Cloudflare Pages）

1. Fork / 克隆本仓库到 GitHub
2. 在 Cloudflare Pages 新建项目，连接该仓库（构建命令留空，输出目录按 Pages 默认即可）
3. 配置 KV 命名空间 `RSS_CACHE`（用于持久化用户自定义代理域名与备份数据）
4. 设置环境变量 `PROXY_ADMIN_TOKEN`（代理域名管理写入接口的鉴权令牌）
5. 部署后，`functions/` 下的 Pages Functions 自动生效，`_redirects` 负责把 `/media-proxy`、`/rss-proxy`、`/download-backup` 等路径路由到对应 Function

> 注意：`functions/` 为 Cloudflare Pages Functions（非 Workers），共用同一运行时与 CPU 限制；媒体代理为纯流式转发，不做额外转码。

## 当前限制

- 数据只保存在当前浏览器，不支持多设备同步
- RSS 解析主要面向常见 RSS / Atom 结构，复杂源可能解析不完整
- m3u8 播放稳定性依赖源站和代理处理能力
- 自定义播放器为轻量实现，不包含倍速、清晰度切换等高级功能
- 本地缓存受浏览器 `localStorage` 容量限制

## 适合场景

这个项目适合个人自用，尤其适合：

- 聚合多个 RSS 图文源
- 聚合视频类 RSS
- 在手机浏览器中快速浏览订阅内容
- 不想搭建复杂后端或账号系统
- 希望保留本地化、轻量化使用方式

## 文件说明

```text
README.md               项目说明文档
_redirects              Cloudflare Pages 路由规则（将代理路径指向 Functions）
index.html              前端主页面（页面结构 + 样式 + 引入 js/ 下的脚本）
functions/              后端代理（Cloudflare Pages Functions）
    media-proxy.js      媒体资源代理（m3u8 / MP4 / 图片 流式转发 + m3u8 分片改写）
    rss-proxy.js        RSS 拉取代理
    twitter-rss.js      Twitter / X 订阅内容获取（Nitter 实例）
    download-backup.js  数据备份下载
js/                     前端脚本
    core.js             数据层（订阅 / 收藏 / 已读 / localStorage）
    media.js            视频播放（HLS 配置、自定义控制栏、缓冲自愈）
    feed.js             订阅加载与卡片渲染（分批追加、增量前插）
    app.js              页面交互与路由
    scrolller-test.js   Scrolller 测试用脚本（调试）
```

## 后续可优化方向

- 使用 IndexedDB 替代 localStorage，提升大量文章缓存时的稳定性
- 将卡片事件改为事件委托，减少重复绑定
- 增加 Cloudflare KV 缓存 RSS，减少弱网环境下的实时请求
- 支持多设备同步收藏和已读记录
- 视频清晰度手动切换（360 / 480 / 720）
- 自托管 HLS.js，去除对 unpkg CDN 的依赖

## 免责声明

本项目仅供个人学习和自用。RSS 内容、图片、视频等媒体资源归原站点所有。使用代理功能时，请遵守目标网站的访问规则和相关法律法规。
