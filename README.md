# dsh-image-preview

让 DeepSeek Harness（dsh）Web 对话正文**直接显示本地图片**的插件：助手回复里写出的本地图片绝对路径会自动变成内联图片，图片下方附一行可点击的本地地址（点击用系统图片工具打开）。

- **host 侧**（`index.js`）：包装 `llm/stream`，把助手文本中的本地图片路径改写为同源回环 URL；注册 `/image`（读图）与 `/open`（本地打开）两条路由。
- **客户端**（`client.js`）：极简模块（`__ModuleLoader__.load` 工厂格式），负责链接小字号样式、收紧间距、拦截点击（只触发本地打开，不开新 tab）。

支持格式：`png / jpg / jpeg / webp / gif / svg / avif / bmp / ico`（单张上限 20MB，或附件服务的 `maxImageBytes`）。

## 特性

- ✅ 本地图片路径 → 对话内联显示
- ✅ 跨重启图片不消失（持久 token 存于 `$DSH_HOME/plugins/dsh-image-preview.token`）
- ✅ 点击地址行 → 系统图片工具打开（macOS `open` / Windows `start` / Linux `xdg-open`）
- ✅ 点击不开新 tab（客户端拦截；无客户端模块时降级为新 tab 显示原图）
- ✅ 图片下方地址行：小字号、紧贴图片（两侧 margin 2px）
- ✅ 零构建、纯 ESM；只处理助手回复文本，工具结果卡片不改写（设计边界）

## 安装

在 dsh 的 profile 目录安装为普通依赖（**不声明 `dsh.bundle`，不会进入 bundles 层**）：

```bash
cd ~/.dsh/profiles/web
pnpm add github:ywleeo/dsh-image-preview
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml`（用户 patch 层）追加：

```yaml
- insert:
    - id: dsh-image-preview
      name: dsh-image-preview
```

重启 `dsh web` 后刷新页面即可。

## 工作原理

1. **改写**：`llm/stream` 文本块结束时，扫描真实存在的本地图片绝对路径（POSIX `/…`、Windows 盘符、UNC），验证文件存在后改写为：

   ```
   ![preview](http://127.0.0.1:<port>/plugins/dsh-image-preview/image?t=<token>&p=<path>)

   [<path>](http://127.0.0.1:<port>/plugins/dsh-image-preview/open?t=<token>&p=<path>)
   ```

2. **读图**：`/image` 路由校验 token 后经 `ctx.fs` 读取文件字节，按扩展名返回 Content-Type。
3. **打开**：`/open` 路由校验 token 后 spawn 系统默认图片工具，302 到图片本身（无客户端时的降级展示）。
4. **客户端**：`client.js` 注入 CSS（小字号 + 间距）并拦截对 `/open` 链接的点击（preventDefault → fetch 触发本地打开）。

## 设计边界

- 只处理**助手回复的流式文本**（`llm/stream`），工具结果卡片里的路径文本不改写。
- 只处理**真实存在的本地绝对路径**；远程 http(s)/data:/file: 链接、相对路径不改写。
- token 持久化在 `$DSH_HOME/plugins/dsh-image-preview.token`（600 权限）：任何能读该文件的本地进程都可访问两条路由 —— 仅限本机使用，勿暴露到公网。

## 开发与维护

改动后需同步到 profile 的 node_modules 拷贝（`file:` 依赖是拷贝/硬链接，编辑工具原子写入会断开硬链接）：

```bash
cp index.js client.js ~/.dsh/profiles/web/node_modules/dsh-image-preview/
```

生效方式：
- `index.js`（host 逻辑）→ **重启 dsh web**
- `client.js`（样式/点击）→ **刷新浏览器页面**

## 卸载

```bash
cd ~/.dsh/profiles/web
pnpm remove dsh-image-preview
```

并删除 `cordis.patch.yml` 里对应 insert。

## 已知边界

- 路径含 `(` `)` `[` `]` 等特殊字符时 markdown 链接语法可能破损（日常路径不受影响）。
- Windows/Linux 打开命令已实现但仅在 macOS 实测。

## License

MIT
