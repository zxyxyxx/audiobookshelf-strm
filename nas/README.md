# Audiobookshelf STRM 定制版

基于官方 [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf) 的定制分支，增加了 STRM 云直链播放、自定义 UI 主题等功能，并通过 GitHub Actions **自动跟随官方版本更新**。

## 镜像地址

```
ghcr.io/zxyxyxx/audiobookshelf-strm:latest     # 始终是最新版
ghcr.io/zxyxyxx/audiobookshelf-strm:2.37.2     # 锁定具体版本
```

> 镜像地址里的 owner 来自 `github.repository_owner`，即**本仓库的所有者**。若仓库改名/转移，请同步改这里。

镜像为 **linux/amd64 + linux/arm64** 多架构（原生 runner 分别构建后合并 manifest），仓库与镜像均公开，NAS 可直接 `docker pull`，无需登录。

## 在 NAS 上部署

1. 把 [`nas/docker-compose.yml`](docker-compose.yml) 复制到 NAS 任意目录；
2. 按文件里的注释改好端口、卷挂载路径、`STRM_DIRECT_URL_MAP` 的 IP；
3. 启动：

```bash
docker compose pull && docker compose up -d
```

4. 浏览器访问 `http://NAS_IP:2048`。

> 容器内部监听 **80** 端口；`ports` 左侧（示例 2048）是你映射到 NAS 的外部端口，可自行更改。

## 在海外 ARM64 服务器上部署

镜像同时提供 `linux/amd64` 与 `linux/arm64`（原生 ARM runner 构建，不靠 QEMU 模拟），ARM VPS 直接 `docker pull` 即可。

```bash
cp nas/docker-compose.overseas-arm64.yml docker-compose.yml
# 改 STRM_DIRECT_URL_MAP 与卷路径，然后：
docker compose pull && docker compose up -d
curl -s http://127.0.0.1:2048/public/healthcheck
```

与 NAS 模板的三处关键差别：**超时放宽**（跨洲 15s 常不够）、**不依赖 FUSE**（只走 OpenList/rclone 的 HTTP 直链）、**可选出口代理**（`STRM_UPSTREAM_PROXY`）。详见 [优化说明](../docs/STRM-OPTIMIZATION.md) 第 12 节。

## 自动更新机制

仓库内两个工作流协作，实现**官方发新版后自动产出新镜像，无需手动操作**：

| 工作流 | 作用 |
|---|---|
| [`auto-update-strm.yml`](../.github/workflows/auto-update-strm.yml) | 每 2 小时轮询官方最新 release。有新版且无冲突时，自动把定制改动 rebase 到新版、打 `strm-vX.Y.Z` tag，并调用下面的构建工作流。|
| [`build-strm-image.yml`](../.github/workflows/build-strm-image.yml) | 构建 amd64 镜像并推送到 GHCR，打上 `X.Y.Z` 和 `latest` 两个 tag。|

```
官方发布新版本
      │  (≤2 小时, 自动)
      ▼
auto-update 轮询发现新版
      ├─ rebase 无冲突 → 自动更新 strm + 打 tag → 构建推送镜像(:X.Y.Z + :latest)
      └─ rebase 有冲突 → 自动中止(不破坏代码) + 开 Issue 提醒人工处理
```

- **NAS 端全自动**：用 `:latest` 标签，并启用 compose 里可选的 Watchtower（或定期 `docker compose pull && up -d`），即可跟随上游自动升级。
- **调整检查频率**：改 `auto-update-strm.yml` 里的 cron `0 */2 * * *`（如 `0 * * * *` 为每小时）。公开仓库的 Actions 免费。
- **手动触发**：在仓库 Actions 页运行 “Auto Update STRM from Upstream” 或 “Build STRM Docker Image”。

## 遇到冲突时（少数情况）

当官方改动与定制改动碰到同一处代码，自动 rebase 会冲突。此时工作流会**自动中止并开一个 Issue**，里面附好解决命令。本地解决一次即可：

```bash
git fetch upstream --tags
git checkout strm
git rebase vX.Y.Z          # 换成 Issue 里的官方版本号
# 手动解决冲突后：
git add <冲突文件>
git rebase --continue
git tag strm-vX.Y.Z
git push origin strm --force-with-lease
git push origin strm-vX.Y.Z   # 推送后自动构建新镜像
```

## 分支与标签说明

- `strm`（默认分支，滚动）= 最新官方 + 定制改动。
- `strm-vX.Y.Z`（tag）= 各历史版本的固定快照。
- `master` = 官方原版镜像跟踪。

## 维护者：手动同步官方更新

平时改功能就在 `strm` 分支上提交。也可手动同步官方新版（一般交给自动化即可）：

```bash
git fetch upstream --tags
git checkout strm
git rebase vX.Y.Z
node --test strm-test/          # STRM 冒烟测试，必须通过
git tag strm-vX.Y.Z
git push origin strm --force-with-lease && git push origin strm-vX.Y.Z
```

> `node --test strm-test/` 是零依赖的 STRM 单元测试（axios/Logger/fsExtra 全部 stub），不需要 `npm install`。
> `auto-update-strm.yml` 在 rebase 成功后也会跑它：**测试不过就回滚并开 issue，绝不推坏镜像**。

## 环境变量参考

| 变量 | 默认 | 作用 | 备注 |
|---|---|---|---|
| `STRM_DIRECT_URL_MAP` | 空 | `/CloudNAS=http://IP:19798/dav`，逗号分隔多条 | 把云挂载路径映射成 HTTP 直链，绕开 FUSE 读取 |
| `STRM_SCAN_PROBE` | `0` | `1`=扫描时对 STRM 目标跑 ffprobe | 开了会在扫描期把整本从云盘拉下来，不建议 |
| `STRM_SCAN_PROBE_FALLBACK` | 开 | `0`=没有章节表时**也不**兜底探测（duration 保持 0） | 想彻底零外连就设 0 |
| `STRM_SCAN_PROBE_DELAY_MS` | `200` | 每次探测前 sleep，防限流 | 大库扫描会明显变慢 |
| `STRM_SCAN_SKIP_PROBE_PATHS` | `/CloudNAS` | 这些前缀的本地文件跳过探测 | 逗号分隔，前缀匹配 |
| `STRM_SCAN_TARGET_SIZE` / `STRM_SCAN_URL_SIZE` | `0` | `1`=读取远端真实大小 | 两个名字等价；每文件最多 2 次远程请求 |
| `STRM_ALLOWED_LOCAL_ROOTS` | 空 | STRM 文件里本地路径必须落在这些根目录内 | **安全项**：不设=允许任意绝对路径 |
| `STRM_PRELOAD_NEXT` | 开 | `0`=关闭下一轨预热 | 关了换集就是 10 秒冷启动 |
| `STRM_PRELOAD_DELAY_MS` | `60000` | 预热延迟 | 调太小会和首播抢 OpenList |
| `STRM_PRELOAD_CONCURRENCY` | `2` | 预热并发上限 | 多用户同时播放时保护云盘 API |
| `STRM_SESSION_RESOLVE_CONCURRENCY` | `8` | 打开会话时解析 STRM 路径的并发 | 大播客/大书库响应更快 |
| `STRM_URL_CACHE_MAX` | `500` | 签名 URL 缓存条数上限（LRU） | 长期运行防内存增长 |
| `STRM_LOG_FULL_PATH` | `0` | `1`=日志打印完整本地路径 | 默认只打文件名 |
| `STRM_LOG_FULL_REDIRECT_URL` | `0` | `1`=日志打印完整签名 URL | **等于把云盘 token 写进日志**，别开 |
| `STRM_WARM_ON_ITEM_OPEN` | 开 | 打开书籍详情页即预热第一轨 | 首播最快的一招；`0` 关闭 |
| `STRM_URL_REFRESH_AHEAD` | 开 | 签名 URL 到期前自动续签 | `0` 关闭 |
| `STRM_URL_REFRESH_AHEAD_MS` | `60000` | 提前多久续签 | 太小会频繁打 OpenList |
| `STRM_SESSION_RESOLVE_LIMIT` | `100` | 建会话时最多预解析多少轨 | `0`=不限；大播客调小可加快响应 |
| `STRM_STREAM_TIMEOUT_MS` | `15000` | 播放拉流超时 | 跨洲部署建议 `45000` |
| `STRM_PROBE_TIMEOUT_MS` | `10000` | 探测/取大小超时 | 跨洲建议 `20000` |
| `STRM_WARM_TIMEOUT_MS` | `30000` | 预热与续签超时 | 跨洲建议 `60000` |
| `STRM_STREAM_RETRY` | `1` | 瞬时失败（5xx/连接重置）重试次数 | `0`=关闭；403/404 永不重试 |
| `STRM_RETRY_FAST_FAIL_MS` | `5000` | 只有「快失败」才重试 | 15s 超时后再等一轮纯属折磨用户；调大＝更爱重试 |
| `STRM_PRELOAD_SESSION_DELAY_MS` | `8000` | 会话启动预热的延迟 | **别调小**：预热和首播请求同时打 OpenList 会 500/超时 |
| `STRM_WAIT_WARM_MS` | `20000` | 播放请求等待「同轨预热」完成的上限 | 冷解析要 15s 左右，比它小会让播放请求重复解析 |
| `STRM_UPSTREAM_PROXY` | 空 | 出口代理 `http://user:pass@host:port` | `direct`=忽略环境里的 `HTTP(S)_PROXY` |
| `STRM_GIT_SHA` / `STRM_UPSTREAM_TAG` / `STRM_BUILD_TIME` | 构建注入 | 镜像构建时由 CI 自动写入，`/api/status` 的 `strmBuild` 与启动日志会显示 | **不用手动设置**；排障时用它确认镜像是哪个补丁 |
| `STRM_HTTP_MAX_SOCKETS` | `64` | 到 OpenList/CDN 的 keep-alive 连接上限 | 首播少一次 TCP/TLS 握手 |
| `STRM_PERSIST_URL_CACHE` | 关 | `1`=签名 URL 缓存落盘 `/metadata/strm-url-cache.json` | 重启/自动升级后免冷启动；文件含签名，权限 0600 |

## 主题与外观

- 6 套主题（原初/星潮/极夜/晨雾/余烬/雪境）+ 6 套 logo，选择存 `localStorage`，**不落服务端**，多设备不同步。
- 主题 CSS 在 `client/assets/strm-theme.css`，**不碰上游 `client/assets/app.css`**（该文件与官方 v2.37.2 逐字节一致），rebase 时不会冲突。
- 首次打开不会白屏闪一下：`nuxt.config.js` 里的内联脚本在首帧前把 `data-ui-theme` 写到 `<html>`，`strm-theme.css` 用 `html[data-ui-theme=...]` 给出底色。
- 每套主题带 `color-scheme`（5 暗 1 亮），原生滚动条/下拉框/日期选择器会跟着变亮变暗。
- 遵循系统「减少动态效果」：`prefers-reduced-motion: reduce` 时关闭主题的过渡动画。

## 首播（第一次播放）为什么能更快

```
点开书籍详情页 ──> GET /api/items/:id ──> 立刻预热第一轨签名 URL（priority，绕过后台队列）
        │                                          │
        └── 用户看简介、点播放（通常 2~10 秒）───────┘
                                    ↓
                     点播放时缓存已命中，首字节不再等 10 秒
```

| 手段 | 省掉什么 |
|---|---|
| 详情页预热（`STRM_WARM_ON_ITEM_OPEN`） | 用户「看简介 → 点播放」这段时间本来白白浪费，现在拿来跑 `STRM → OpenList → CDN` 解析链 |
| keep-alive 连接池（`STRM_HTTP_MAX_SOCKETS`） | 每次冷播都要重做 TCP + TLS 握手（WAN 上 100–500ms） |
| 到期前自动续签（`STRM_URL_REFRESH_AHEAD`） | 签名过期后第一次播放要重新解析（~10s） |
| 落盘缓存（`STRM_PERSIST_URL_CACHE`） | 容器重启/自动升级后全部变冷；落盘后直接复用未过期链接 |
| 建会话解析上限（`STRM_SESSION_RESOLVE_LIMIT`） | 500 集播客打开会话时逐集读 `.strm` 的等待（服务端按需解析，功能不受影响） |
| 去掉每轨一次 DB 查询 | `getTrack` 首字节路径上的一次数据库往返 |

## 排错

| 现象 | 看什么 |
|---|---|
| 换集要等 ~10 秒 | `[STRM-PRELOAD] Warmed next track` 有没有出现；没有就检查 `STRM_PRELOAD_NEXT` / `STRM_PRELOAD_DELAY_MS` |
| 播放报 403/404 | `[STRM-PLAY] redirect=...` 与 `cache=hit/miss`；签名过期会自动重试一次，仍失败说明 STRM 目标本身失效 |
| 拖动进度条卡住 | `[STRM-PLAY] upstream does not support byte ranges` 告警 = 该 CDN 不支持 Range，只能顺序播放 |
| 播放 30 秒后跳转/整本下载 | 说明进了转码兜底；检查 `checkCanDirectPlay` 是否被绕过、`PlayerHandler` 是否抑制了 HLS |
| 502 / 504 | `[STRM-PLAY] Upstream request failed: status=... code=...`；504=超时（云盘慢），502=连不上 |
| 扫描把云盘拖死 | `STRM_SCAN_PROBE=0`、`STRM_SCAN_PROBE_FALLBACK=0`、`STRM_SCAN_TARGET_SIZE=0` 三个一起关 |
