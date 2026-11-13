# STRM 定制版优化说明 / STRM Fork Optimization Notes

> 基线 / Base: `strm` @ `467e7ce` (upstream v2.37.2 + STRM patches)
> 本次改动 / This change set: **16 files modified, 12 files added**, 44 unit tests
> 四轮 / four passes: STRM 播放链路 · 主题 · 首播 · arm64+海外（含可追溯与瘦身）

---

## 1. 摘要 / Summary

### 1.1 STRM 播放链路 / STRM playback path

| # | 中文 | English |
|---|---|---|
| 1 | 分享链接不再 `302` 到云端签名 URL，改为经 ABS 代理 | Share links proxy through ABS instead of `302`-ing to the signed CDN URL |
| 2 | STRM 本地路径可限制在 `STRM_ALLOWED_LOCAL_ROOTS` 内 | Local targets can be confined to `STRM_ALLOWED_LOCAL_ROOTS` |
| 3 | 签名 URL 缓存改为带上限的 LRU | Signed-URL cache is a bounded LRU |
| 4 | 同一轨道的并发冷请求只解析一次重定向链 | Concurrent cold requests resolve the redirect chain exactly once |
| 5 | 预热加全局并发上限 + 优先级通道 | Pre-warm is globally capped, with a priority lane for user-initiated warms |
| 6 | 上游不支持 Range 时不再谎报 `Accept-Ranges` | No more fake `Accept-Ranges: bytes` |
| 7 | 三处入口合并为单一 `serveStrmStream()` | Three entry points collapse into one `serveStrmStream()` |
| 8 | 会话解析分批并发 + 去重 + 上限 | Session resolution is batched, deduped and capped |
| 9 | 章节按 `start` 排序后再反推时长 | Chapters are sorted before duration inference |
| 10 | 超时 → 504 / 连不上 → 502 / 上游状态透传 | 504 on timeout, 502 on connection failure, upstream status passthrough |
| 11 | 日志脱敏（路径只打文件名、URL 查询串打码） | Log redaction (basename only, query strings masked) |
| 12 | 自动 rebase 加冒烟测试门禁，失败回滚 + 开 issue | Auto-rebase gains a test gate: fail → roll back + open an issue |

### 1.2 主题 / Theme

| # | 中文 | English |
|---|---|---|
| T1 | 主题层从 `app.css` 抽出到 `strm-theme.css`；`app.css` 现在与官方 v2.37.2 **逐字节一致** | Theme layer extracted to `strm-theme.css`; `app.css` is now **byte-identical** to upstream v2.37.2 |
| T2 | 首帧前就把 `data-ui-theme` 写到 `<html>`，深色主题不再白屏闪一下 | `data-ui-theme` lands on `<html>` before first paint; dark themes no longer flash white |
| T3 | 每套主题带 `color-scheme`（5 暗 1 亮），原生滚动条/下拉框/日期选择器跟着变 | `color-scheme` per theme (5 dark, 1 light) so native widgets match |
| T4 | 遵循 `prefers-reduced-motion` | Respects `prefers-reduced-motion` |
| T5 | 主题切换时 `<html>` 与 `<body>` 同步，运行时换肤不再残留旧底色 | `<html>` and `<body>` stay in sync, so runtime theme switches leave no stale background |

### 1.3 首播 / First play

| # | 中文 | English |
|---|---|---|
| F1 | 打开书籍详情页就预热第一轨（`STRM_WARM_ON_ITEM_OPEN`），把「看简介」的几秒变成预热时间 | Opening the item detail page warms the first track (`STRM_WARM_ON_ITEM_OPEN`) |
| F2 | keep-alive 连接池（`STRM_HTTP_MAX_SOCKETS`），省掉每次冷播的 TCP + TLS 握手 | Keep-alive agent pool removes a TCP + TLS handshake from every cold play |
| F3 | 签名 URL 到期前自动续签（`STRM_URL_REFRESH_AHEAD`），过期不再是「重新解析 10 秒」 | Signed URLs refresh ahead of expiry instead of being re-resolved on demand |
| F4 | 可选落盘缓存（`STRM_PERSIST_URL_CACHE`），容器重启/自动升级后免冷启动 | Optional on-disk cache survives restarts and Watchtower image updates |
| F5 | 建会话解析上限（`STRM_SESSION_RESOLVE_LIMIT`），500 集播客不再逐集读文件才响应 | Session resolution is capped, so a 500-episode podcast responds immediately |
| F6 | `getTrack` 去掉每轨一次的数据库用户查询 | `getTrack` drops one DB round trip from the first-byte path |

### 1.4 arm64 + 海外服务器 / ARM64 & overseas server

| # | 中文 | English |
|---|---|---|
| A1 | 跨洲超时可配（拉流/探测/预热三档），默认值不变 | Timeouts are configurable per phase; defaults unchanged |
| A2 | 瞬时失败（5xx / 连接重置）自动重试一次 | Transient failures (5xx / connection reset) get one retry |
| A3 | 可选出口代理 `STRM_UPSTREAM_PROXY`（含 `direct` 用来忽略环境代理） | Optional egress proxy, with `direct` to ignore env proxies |
| A4 | 镜像加 `HEALTHCHECK`，走服务端已有的 `/healthcheck` | Image gains a `HEALTHCHECK` against the existing `/healthcheck` |
| A5 | 前端构建固定跑在构建机架构（`$BUILDPLATFORM`），arm64 不再依赖 QEMU | Client build pinned to `$BUILDPLATFORM`, so arm64 no longer needs QEMU |
| A6 | 新增 `nas/docker-compose.overseas-arm64.yml`：无 FUSE、超时放宽、可选代理 | New overseas ARM64 compose: no FUSE, longer timeouts, optional proxy |
| A7 | 确认 arm64 的 `libnusqlite3` 预编译包存在（`libnusqlite3-linux-musl-arm64.zip`） | Verified the arm64 prebuilt `libnusqlite3` asset exists |

### 1.5 可追溯 + 镜像瘦身 / Traceability & image size

| # | 中文 | English |
|---|---|---|
| B1 | 构建时注入 `upstream tag / git sha / 构建时间`，启动日志与 `/api/status` 的 `strmBuild` 都能看到 | Build metadata is baked into the image and reported in the startup log and `/api/status` |
| B2 | 运行时镜像删掉 npm / yarn / corepack / man / doc（15 MB+） | npm, yarn, corepack, man pages and docs are stripped from the runtime image |
| B3 | 只拷 `dist-server` + `node_modules` + `package.json`，不再拷 `server/` 源码 | Only compiled output, prod deps and the manifest are copied |
| B4 | 删掉 `dist-server/test`（mocha 套件）与 `.tsbuildinfo` | The mocha suites and the tsc cache are removed from the image |
| B5 | `.dockerignore` 排除 `strm-test/ docs/ nas/ .github/ build/` | Build context excludes test suites, docs and templates |
| B6 | 新增文档一致性测试：代码里每个 `STRM_*` 变量必须写进 `nas/README.md` | A test fails when a `STRM_*` env var is undocumented |

---

## 2. 变更清单 / Change list

| 文件 / File | 类型 | 说明 / What & why |
|---|---|---|
| `server/utils/strmUtils.js` | 改 / mod | LRU、记忆化、路径白名单、按 URL 串行化、诚实 Range、错误码映射、日志脱敏、keep-alive、续签、落盘、优先级预热 |
| `server/utils/strmStream.js` | **新增** | `serveStrmStream(req, res, filePath)` 单一入口 |
| `server/controllers/SessionController.js` | 改 / mod | 用单一入口；去掉每轨 DB 查询；预热交给 manager |
| `server/controllers/LibraryItemController.js` | 改 / mod | 单一入口 + 详情页预热 `warmFirstTrackOnOpen()` |
| `server/controllers/ShareController.js` | 改 / mod | `res.redirect()` → 代理（修签名 URL 泄露） |
| `server/managers/PlaybackSessionManager.js` | 改 / mod | 预热定时器随会话销毁；会话解析分批/去重/限额；会话启动预热走优先通道 |
| `server/scanner/BookScanner.js` | 改 / mod | 章节排序 + `STRM_SCAN_PROBE_FALLBACK` |
| `client/assets/app.css` | 改 / mod | 主题层与 `--modern-*` 变量移出，**回到上游原样** |
| `client/assets/strm-theme.css` | **新增** | 全部主题样式（含新增 polish 层） |
| `client/nuxt.config.js` | 改 / mod | 注册 `strm-theme.css`；内联 boot 脚本消除白屏闪 |
| `client/plugins/uiTheme.client.js` | 改 / mod | 同时同步 `<html>` 的 `data-ui-theme` |
| `.github/workflows/auto-update-strm.yml` | 改 / mod | rebase 后跑冒烟测试，失败回滚 + issue |
| `.github/workflows/build-strm-image.yml` | 改 / mod | 注入构建元数据（`GIT_SHA` / `UPSTREAM_TAG` / `BUILD_TIME`）；arm64 runner 说明 |
| `Dockerfile` | 改 / mod | 前端构建固定 `$BUILDPLATFORM`；瘦身（删 npm/corepack/docs、只拷产物）；`HEALTHCHECK`；OCI labels；构建期元数据 ENV |
| `.dockerignore` | 改 / mod | 排除 `strm-test/ docs/ nas/ .github/ build/`，缩小构建上下文 |
| `server/Server.js` | 改 / mod | 启动日志打 `STRM build:`；`/status` 增加 `strmBuild` 字段 |
| `server/utils/strmBuild.js` | **新增** | `getStrmBuildInfo()` / `getStrmBuildLine()` |
| `nas/README.md` / `nas/docker-compose.yml` | 改 / mod | 29 个环境变量、主题说明、首播说明、海外模板指引、排错表 |
| `nas/docker-compose.overseas-arm64.yml` | **新增** | 海外 ARM64 模板：无 FUSE、超时放宽、可选出口代理 |
| `strm-test/*` (7 files) | **新增** | 44 个零依赖用例 |
| `docs/STRM-OPTIMIZATION.md` | **新增** | 本文档 / this document |

---

## 3. 关键设计 / Key design

### 3.1 单一入口 / Single entry point

```
SessionController.getTrack ─┐
LibraryItemController.getLibraryFile ─┼─> serveStrmStream(req, res, path)
ShareController.getMediaItemShareAudioTrack ─┘        │
                                                      ├─ isUrl        → proxyRemoteStream
                                                      ├─ .strm → URL  → proxyRemoteStream
                                                      ├─ .strm → 本地 → { handled:false, filePath }
                                                      ├─ 云映射路径   → proxyRemoteStream
                                                      └─ 其它         → { handled:false, filePath }
```

三处逻辑原本各写一遍，任何语义变化要改三遍，也是 rebase 冲突高发区。
The logic used to be copy-pasted three times; one file now owns it.

### 3.2 冷解析去重 / Cold-resolution dedupe

`runExclusive(remoteUrl, resolveRemote)`：并发请求排队，队内**重读缓存**，一次突发只产生一次 `STRM → OpenList → CDN`。
Concurrent requests queue and re-read the cache inside the critical section, so a burst resolves once.

### 3.3 诚实的 Range / Honest byte ranges

```js
const upstreamSupportsRange = status === 206 || hasContentRange || hasAcceptRanges
if (!hasAcceptRanges && upstreamSupportsRange) res.setHeader('Accept-Ranges', 'bytes')
else if (!upstreamSupportsRange) Logger.warn('upstream does not support byte ranges ... seek may fail')
```

### 3.4 生命周期 / Lifecycle

预热定时器归 `PlaybackSessionManager`（`Map<sessionId, Timeout>`），`removeSession()` 清理并 `unref()`；续签定时器归 `strmUtils`，缓存淘汰时同步清理。
Preload timers live in the manager and die with the session; refresh timers are cleared when a cache entry is evicted.

---

## 4. 主题 / Theme

### 4.1 拆分 / Extraction

```
改前 / before:  client/assets/app.css            48,905 B，其中 43,646 B（89.2%）是主题层
改后 / after:   client/assets/app.css             4,757 B  ← 与官方 v2.37.2 逐字节一致
                client/assets/strm-theme.css     45,855 B  ← 主题层 + polish
```

验证 / verification：

```bash
# app.css 与官方 v2.37.2 完全一致（逐字节）
curl -sL https://raw.githubusercontent.com/advplyr/audiobookshelf/v2.37.2/client/assets/app.css -o /tmp/up.css
diff <(tr -d '\r' < /tmp/up.css) <(tr -d '\r' < client/assets/app.css) && echo IDENTICAL
```

> 意义 / Why it matters：上游只要动 `app.css`（改样式、调 Tailwind 变量），旧结构**每次 rebase 必冲突**；现在这个文件永远不冲突。
> Upstream edits to `app.css` used to conflict on every rebase; now that file can never conflict.

### 4.2 首帧底色 / First-paint background

```js
// nuxt.config.js — head.script
innerHTML: `(function(){try{
  var THEMES=['classic','nebula','obsidian','aurora','ember','porcelain'];
  var stored=localStorage.getItem('abs-ui-theme');
  var theme=THEMES.indexOf(stored)>=0?stored:'nebula';
  document.documentElement.setAttribute('data-ui-theme',theme);
}catch(e){}})();`
```

```css
/* strm-theme.css —— 首帧即主题底色，不等 JS 包加载完 */
html[data-ui-theme='nebula'] {
  background-color: #0d1118;
}
```

`<body>` 的主题 class 仍由 `uiTheme.client.js` 在 hydration 时挂上（此时页面还没有内容），所以用户看到的永远是主题色，不会有白屏闪。
The body class is still applied by the plugin at hydration, before any content paints, so the flash is gone.

### 4.3 原生控件与动效 / Native widgets & motion

- `color-scheme: dark` × 4 主题、`color-scheme: light` × porcelain → 滚动条、`<select>`、日期选择器、自动填充底色自动匹配。
- `@media (prefers-reduced-motion: reduce)` 时把主题过渡压到 0.01ms。

---

## 5. 首播 / First play

### 5.1 时间线 / Timeline

```
用户点开书籍详情页
   │  GET /api/items/:id
   ├─> warmFirstTrackOnOpen()  ── priority 通道 ──> STRM → OpenList → CDN（~10s，后台跑）
   │
用户看简介 / 选章节（2~10 秒）
   │
用户点播放
   └─> GET /api/play/:sessionId/track/0
         cache=hit ──> 直接向 CDN 拉字节，首字节 ≈ 网络 RTT
```

改前：所有解析都发生在「点播放」之后 → 首字节等 10 秒。
改后：解析发生在「看简介」期间 → 首字节基本只剩网络延迟。

### 5.2 六项手段 / Six levers

| 手段 / Lever | 省掉什么 / Saves |
|---|---|
| 详情页预热 / item-open warm | 「看简介」的空白时间（2–10s） |
| keep-alive 池 / agent pool | 每次冷播的 TCP + TLS 握手（WAN 100–500ms） |
| 到期前续签 / refresh-ahead | 签名过期后第一次播放的重新解析（~10s） |
| 落盘缓存 / on-disk cache | 容器重启、Watchtower 自动升级后的全量冷启动 |
| 会话解析上限 / resolve cap | 500 集播客打开会话时逐集读 `.strm` 的等待 |
| 去掉 DB 查询 / no user lookup | `getTrack` 首字节路径上的一次数据库往返 |

### 5.3 可观测 / Observability

```bash
docker logs -f audiobookshelf-strm 2>&1 | grep -E 'STRM-(PLAY|PRELOAD)'
```

```
[STRM-PRELOAD] Warming first track on item open: a.m4b     ← 详情页预热触发
[STRM-PRELOAD] Warmed next track (signed query redacted)   ← 预热成功
[STRM-PRELOAD] Refreshed signed URL ahead of expiry ...    ← 到期前续签
[STRM-PRELOAD] Restored 128 signed URL(s) from disk cache  ← 重启后恢复
[STRM-PLAY] mode=proxy ... cache=hit status=206 range=yes  ← 首播命中缓存
```

---

## 6. 配置 / Configuration（20 个 / 20 knobs）

| 变量 / Var | 默认 / Default | 说明 / Meaning |
|---|---|---|
| `STRM_DIRECT_URL_MAP` | 空 | 云挂载路径 → HTTP 直链映射，逗号分隔多条 |
| `STRM_SCAN_PROBE` | `0` | `1`=扫描时对 STRM 目标跑 ffprobe |
| `STRM_SCAN_PROBE_FALLBACK` | 开 | `0`=无章节表也不兜底探测（彻底零外连） |
| `STRM_SCAN_PROBE_DELAY_MS` | `200` | 探测前 sleep，防限流 |
| `STRM_SCAN_SKIP_PROBE_PATHS` | `/CloudNAS` | 这些前缀跳过探测 |
| `STRM_SCAN_TARGET_SIZE` / `STRM_SCAN_URL_SIZE` | `0` | 读取远端真实大小 |
| `STRM_ALLOWED_LOCAL_ROOTS` | 空 | **安全项**：本地目标必须落在这些根内 |
| `STRM_PRELOAD_NEXT` | 开 | `0`=关闭下一轨预热 |
| `STRM_PRELOAD_DELAY_MS` | `60000` | 下一轨预热延迟 |
| `STRM_PRELOAD_CONCURRENCY` | `2` | 后台预热并发上限 |
| `STRM_WARM_ON_ITEM_OPEN` | 开 | `0`=关闭详情页预热 |
| `STRM_URL_REFRESH_AHEAD` | 开 | `0`=关闭到期前续签 |
| `STRM_URL_REFRESH_AHEAD_MS` | `60000` | 提前多久续签 |
| `STRM_URL_CACHE_MAX` | `500` | 签名 URL 缓存条数（LRU） |
| `STRM_PERSIST_URL_CACHE` | 关 | `1`=落盘 `/metadata/strm-url-cache.json`（0600） |
| `STRM_HTTP_MAX_SOCKETS` | `64` | keep-alive 连接上限 |
| `STRM_SESSION_RESOLVE_CONCURRENCY` | `8` | 建会话时解析并发 |
| `STRM_SESSION_RESOLVE_LIMIT` | `100` | 建会话时最多预解析多少轨（`0`=不限） |
| `STRM_LOG_FULL_PATH` | `0` | `1`=日志打完整本地路径 |
| `STRM_LOG_FULL_REDIRECT_URL` | `0` | `1`=日志打完整签名 URL（有泄露风险） |
| `STRM_STREAM_TIMEOUT_MS` | `15000` | 播放拉流超时；跨洲部署建议 45000 |
| `STRM_PROBE_TIMEOUT_MS` | `10000` | 探测/取大小超时；跨洲建议 20000 |
| `STRM_WARM_TIMEOUT_MS` | `30000` | 预热与续签超时；跨洲建议 60000 |
| `STRM_STREAM_RETRY` | `1` | 瞬时失败（5xx/连接重置）重试次数，`0`=关闭 |
| `STRM_UPSTREAM_PROXY` | 空 | 出口代理 `http://user:pass@host:port`；`direct`=忽略环境代理 |

---

## 7. 验证 / Verification

```bash
# 1) 单元测试（零依赖，无需 npm install） / unit tests, no deps needed
node --test strm-test/
#    → tests 31 / pass 31 / fail 0

# 2) 语法检查 / syntax
for f in server/utils/strmUtils.js server/utils/strmStream.js \
         server/controllers/SessionController.js server/controllers/LibraryItemController.js \
         server/controllers/ShareController.js server/managers/PlaybackSessionManager.js \
         server/scanner/BookScanner.js client/nuxt.config.js; do node --check "$f"; done

# 3) app.css 与上游一致 / app.css identical to upstream → 见 §4.1

# 4) 运行期 / runtime
curl -sI -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-1023" \
  http://NAS:2048/api/play/<sessionId>/track/0 | grep -Ei 'HTTP/|content-range|accept-ranges'
#    期望 206 + content-range + content-type: audio/mp4
```

---

## 8. 应用方式 / How to apply

```bash
cd abs-strm
git checkout strm
git apply --check strm-optimizations.patch
git apply strm-optimizations.patch
node --test strm-test/          # 31 个用例必须全绿

git add -A && git commit -m "strm: harden + dedupe + theme split + first-play prewarm + tests"
git tag strm-v2.37.2.1
git push origin strm --force-with-lease && git push origin strm-v2.37.2.1
```

---

## 9. 兼容性变化 / Behaviour changes

| 变化 / Change | 影响 / Impact |
|---|---|
| 分享播放由 302 改代理 | 流量也过 NAS；签名 URL 不再出现在客户端 |
| 不再谎报 `Accept-Ranges` | 不支持 Range 的 CDN 上，播放器可能显示「不可拖动」而不是卡死 |
| 详情页会发一次预热请求 | 每个被打开的详情页最多 1 次额外上游请求（缓存命中则 0 次）；`STRM_WARM_ON_ITEM_OPEN=0` 可关 |
| 会话只预解析前 100 轨 | 超出部分保留 `.strm` 路径，服务端按需解析，播放功能不受影响 |
| 落盘缓存含签名 URL | 默认关闭；开启后文件权限 0600，视为密钥管理 |
| 日志默认只打文件名 | `STRM_LOG_FULL_PATH=1` 可看全路径 |
| 主题 CSS 换文件 | 自定义样式要改 `strm-theme.css`，不要改 `app.css`（改了会重新引入 rebase 冲突） |

---

## 10. 未做但建议下一步 / Not done — recommended next

| 优先级 | 事项 / Item | 理由 / Why |
|---|---|---|
| P1 | `STRM_BUILD`（upstream tag + sha）注入启动日志与 `/api/status` | 排障时不用猜镜像是哪个补丁 |
| P1 | 主题选择落服务端（`ServerSettings`） | 现在存 localStorage，多设备不同步 |
| P2 | 短期签名直连（ABS 发 302 + 一次性 token，客户端直连 CDN） | NAS 上行归零，代价是暴露短期链 |
| P2 | 扫描期 `STRM_SCAN_TARGET_SIZE` 结果落库 | 大库重扫少一半远程请求 |
| P3 | 主题支持自定义主色（CSS 变量覆盖面板） | 现在只能选 6 套预设 |

---

## 11. 测试覆盖 / Test coverage（44 cases）

| 文件 / File | 数量 | 覆盖 / Covers |
|---|---|---|
| `strm-test/strmUtils.test.js` | 9 | 映射与边界、探测跳过、`readStrmTarget`（注释/相对/白名单/边界）、`parseRemoteFileSize`、LRU 与过期、脱敏、错误码 |
| `strm-test/strmStream.test.js` | 12 | 206 透传 + MIME 纠正 + `Accept-Ranges`、200 不谎报、并发去重、403 重试、504/5xx、六种分发路径 |
| `strm-test/strmPrewarm.test.js` | 6 | keep-alive agent、续签、定时器取舍、优先级预热、并发去重、`STRM_PRELOAD_NEXT=0` |
| `strm-test/strmPersistCache.test.js` | 4 | 落盘/恢复、过期条目丢弃、损坏文件容错、写盘过滤 |
| `strm-test/strmNetwork.test.js` | 9 | 出口代理（direct/带认证/非法值）、可配超时、503/ECONNRESET 重试、`STRM_STREAM_RETRY=0`、403 不重试、瞬时判定表 |
| `strm-test/strmBuild.test.js` | 4 | 构建元数据（默认/注入/空白值）+ **文档一致性**（每个 `STRM_*` 变量必须在 `nas/README.md` 里） |

---

## 12. 部署到 arm64 国外服务器 / Deploying on an overseas ARM64 server

### 12.1 镜像 / Image

```bash
docker pull ghcr.io/zxyxyxx/audiobookshelf-strm:latest
docker image inspect ghcr.io/zxyxyxx/audiobookshelf-strm:latest --format '{{.Os}}/{{.Architecture}}'
# 期望 / expect: linux/arm64
```

镜像由 `build-strm-image.yml` 在 **原生 ARM runner**（`ubuntu-24.04-arm`）上构建后与 amd64 合并成 manifest list，所以 `docker pull` 会自动拿到 arm64 那一份。
Built on a native ARM runner and merged into a multi-arch manifest, so `docker pull` picks arm64 automatically.

> 若你要自己构建：arm64 上**不要**用 QEMU 模拟（`node:24-alpine` 里的 npm 在 QEMU 下会 `exit 139`）。`Dockerfile` 已经把前端构建固定在 `$BUILDPLATFORM`，服务端编译也在构建机上跑，只有原生依赖（`sqlite3`、`libnusqlite3`）在目标架构上装。
> If you build yourself: never emulate arm64 with QEMU here. The Dockerfile pins the client build and the tsc compile to the build platform; only native deps are installed for the target arch.

### 12.2 三件必须改的事 / Three things to change

| 项 | NAS 模板 | 海外 ARM64 模板 |
|---|---|---|
| 超时 | 默认 15s | `STRM_STREAM_TIMEOUT_MS=45000`、`STRM_PROBE_TIMEOUT_MS=20000`、`STRM_WARM_TIMEOUT_MS=60000` |
| 云挂载 | FUSE + `rshared` | 只用 HTTP 直链（OpenList/rclone），`STRM_DIRECT_URL_MAP` 指向 `127.0.0.1:5244` 或内网 |
| 时区 | `Asia/Shanghai` | `UTC`（日志和定时任务对得上） |

### 12.3 典型拓扑 / Typical topology

```
海外 ARM VPS ──────────────────────────────────────────────
  OpenList (:5244)  ←── 挂夸克/115（或反代国内 NAS 的 OpenList）
        ▲
        │ HTTP + Range（本机回环，零跨境）
        │
  ABS (:2048)  ── STRM_DIRECT_URL_MAP=/cloud=http://127.0.0.1:5244/d/books
        ▲
        │ 用户播放（走公网 / 套 Caddy 做 TLS）
   浏览器 / App
```

要点 / key points：

1. **OpenList 与 ABS 同机**时走回环，跨境只发生在 OpenList → 云盘那一段，`keep-alive` 和「到期前续签」正好治它。
2. 若 OpenList 在国内而 ABS 在海外，给 `STRM_UPSTREAM_PROXY` 指一条隧道（例如 `http://10.0.0.2:7890`），ABS 只走代理访问 OpenList，用户侧仍是直连。
3. 只想让部分域名走代理：用环境变量 `NO_PROXY`，或者 `STRM_UPSTREAM_PROXY=direct` 彻底忽略环境代理。

### 12.4 验证 / Verify

```bash
# 1) 健康检查（服务端自带的 /healthcheck，镜像 HEALTHCHECK 也用它）
curl -s http://127.0.0.1:2048/healthcheck
docker inspect --format '{{.State.Health.Status}}' audiobookshelf-strm   # healthy

# 2) 镜像是哪个补丁（构建元数据）
docker logs audiobookshelf-strm 2>&1 | head -5 | grep 'STRM build'
curl -s http://127.0.0.1:2048/status | grep -o '"strmBuild":{[^}]*}'

# 3) 首播是否命中缓存
docker logs audiobookshelf-strm 2>&1 | grep -E 'STRM-(PLAY|PRELOAD)' | tail -20

# 4) Range 是否生效
curl -sI -H "Authorization: Bearer $TOKEN" -H "Range: bytes=0-1023" \
  http://127.0.0.1:2048/api/play/<sessionId>/track/0 | grep -Ei 'HTTP/|content-range'
```

---

## 13. 可追溯 + 镜像瘦身 / Traceability & image size

### 13.1 构建元数据 / Build metadata

```
启动日志 / startup log:
[Server] STRM build: base=v2.37.2 upstream=v2.37.2 sha=467e7ce built=2026-11-13T23:00:00Z

GET /status:
"strmBuild": { "isStrmFork": true, "baseVersion": "2.37.2", "upstreamTag": "v2.37.2",
               "gitSha": "467e7ce…", "shortSha": "467e7ce", "builtAt": "2026-11-13T23:00:00Z" }
```

链路 / how it flows：

```
build-strm-image.yml  ──build-args──>  Dockerfile ARG/ENV  ──>  process.env
   GIT_SHA / UPSTREAM_TAG / BUILD_TIME                            │
                                                                  ▼
                                              server/utils/strmBuild.js
                                                     │            │
                                              启动日志        /api/status
```

`UPSTREAM_TAG` 由 workflow 从 ref 推导：`strm-v2.37.2` / `2.37.2` / `v2.37.2` 都会归一成 `v2.37.2`；手动触发且 ref 不是版本号时，退回 `package.json` 的版本。
The workflow normalises any of `strm-v2.37.2`, `2.37.2`, `v2.37.2` to `v2.37.2`, falling back to `package.json`.

### 13.2 瘦身清单 / What was removed

| 移除项 / Removed | 大致体积 / Rough size |
|---|---|
| `/usr/local/lib/node_modules/npm` + `npx` | ~12–15 MB |
| `corepack` / `yarn` / `pnpm` 垫片 | ~2 MB |
| `/usr/share/man`、`/usr/share/doc`、`apk` 缓存 | ~5–10 MB |
| `dist-server/test`（mocha 套件）、`.tsbuildinfo` | ~1 MB |
| `server/` 源码副本（已编译进 `dist-server`） | ~3 MB |
| 构建上下文里的 `strm-test/ docs/ nas/ .github/ build/` | 构建更快 / faster context |

> `ffmpeg` 仍用 alpine 包（arm64 有现成包）。若还要更小，可换静态 ffmpeg 构建（单文件 ~78 MB，但省掉依赖树），代价是构建期多一次外网下载。
> `ffmpeg` stays on the alpine package (arm64 available). For a smaller image, swap in a static ffmpeg build.

