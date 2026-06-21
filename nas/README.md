# Audiobookshelf STRM 定制版

基于官方 [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf) 的定制分支，增加了 STRM 云直链播放、自定义 UI 主题等功能，并通过 GitHub Actions **自动跟随官方版本更新**。

## 镜像地址

```
ghcr.io/2222221029/audiobookshelf-strm:latest     # 始终是最新版
ghcr.io/2222221029/audiobookshelf-strm:2.35.1     # 锁定具体版本
```

镜像为 **linux/amd64**，仓库与镜像均公开，NAS 可直接 `docker pull`，无需登录。

## 在 NAS 上部署

1. 把 [`nas/docker-compose.yml`](docker-compose.yml) 复制到 NAS 任意目录；
2. 按文件里的注释改好端口、卷挂载路径、`STRM_DIRECT_URL_MAP` 的 IP；
3. 启动：

```bash
docker compose pull && docker compose up -d
```

4. 浏览器访问 `http://NAS_IP:2048`。

> 容器内部监听 **80** 端口；`ports` 左侧（示例 2048）是你映射到 NAS 的外部端口，可自行更改。

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
git tag strm-vX.Y.Z
git push origin strm --force-with-lease && git push origin strm-vX.Y.Z
```
