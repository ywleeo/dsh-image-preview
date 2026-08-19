# Changelog

## v0.2.0（2026-08-19）

- **新增：本地视频内联预览**。助手回复中的本地视频绝对路径（`mp4 / m4v / webm / mov / ogv`，上限 512MB）自动改写成播放器链接，客户端渲染为 `<video controls>` 播放器。
- **新增 `/video` 路由**：支持 HTTP Range（206 分段响应、`Content-Range`、`Accept-Ranges: bytes`），播放器可拖动进度条。
- **`/open` 路由扩展**：视频用系统默认播放器打开（macOS `open` 等）。
- 客户端新增 MutationObserver：把「▶ 播放视频」链接替换成播放器，加载失败自动还原为链接。
- 支持格式说明、特性、截图（`preview-video.png`）等文档同步更新。

## v0.1.5（2026-08-18）

- 客户端样式/间距微调（图片与其下方地址行紧贴）。
- 持久 token 逻辑完善（写入 `$DSH_HOME/plugins/dsh-image-preview.token`，600 权限）。

## v0.1.4（2026-08-18）

- 增加 `/open` 本地打开路由与客户端点击拦截（不导航、不开新 tab）。

## v0.1.0（2026-08-18）

- 首个版本：助手回复中的本地图片绝对路径 → 对话内联显示。
- host 侧包装 `llm/stream` 改写路径为同源回环 URL；`/image` 路由读图。
- 零构建、纯 ESM；只处理助手回复文本，工具结果卡片不改写。
