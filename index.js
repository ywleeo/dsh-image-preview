/**
 * dsh-image-preview —— 让 dsh Web 对话正文直接显示本地图片与视频。
 *
 * host-only 插件，刻意保持最小：
 *  - 不声明 dsh.bundle（作为普通依赖安装，CLI 不会把它加进 profile bundles 层）；
 *  - 从用户 patch 层（cordis.patch.yml）挂载，单条 insert、id 唯一，支持热加载；
 *  - 无客户端组件、无 Typert 远程服务、无 settings 卡片 —— Web 端 Markdown 渲染器
 *    本身支持 http(s) 图片，host 侧把本地路径改写成同源 URL 即可，表面最小化。
 *    视频没有原生 Markdown 语法，host 改写成链接、由 client.js 替换成 <video> 播放器。
 *
 * 工作方式：
 *  1. 包装 llm/stream：助手回复的文本块结束时，扫描真实存在的本地媒体绝对路径
 *     （POSIX /…、Windows 盘符、UNC，带图片/视频扩展名），改写为
 *     http://127.0.0.1:<port>/plugins/dsh-image-preview/image|video?t=<token>&p=<path>。
 *  2. 在 webServer 上注册同一条精确路由：校验随机 token 后，经 ctx.fs 读取文件字节
 *     并按扩展名返回 Content-Type。图片上限 20MB（或附件服务的 maxImageBytes）；
 *     视频走 HTTP Range（206 分段响应），支持播放器拖动进度条。
 *
 * 只处理助手回复文本（llm/stream），工具结果卡片里的路径文本不改写 —— 这是设计边界。
 */

export const name = 'dsh-image-preview'

/**
 * 硬依赖：webServer 与 fs 是路由/读图的前提，声明 inject 让 loader 按依赖
 * 顺序挂载（否则冷启动时本条目可能抢在服务提供之前 apply，导致静默跳过）。
 * llm 保持可选（ctx.get 探测）：它只决定流式改写是否启用。
 */
export const inject = ['webServer', 'fs']

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const ROUTE_PATH = '/plugins/dsh-image-preview/image'
const VIDEO_PATH = '/plugins/dsh-image-preview/video'
const OPEN_PATH = '/plugins/dsh-image-preview/open'
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i
const VIDEO_EXT_RE = /\.(mp4|m4v|webm|mov|ogv)$/i
const BARE_STOP = "\\s'\"<>\\[\\]\u3001\uFF0C\u3002\uFF1B;`"
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024
const DEFAULT_VIDEO_MAX_BYTES = 512 * 1024 * 1024
const VIDEO_LABEL = '▶ 播放视频'

/**
 * 持久化 token：写入 $DSH_HOME/plugins/dsh-image-preview.token（600 权限）。
 * 会话里存的图片 URL 带 token，若每次激活随机生成，重启后旧消息图片全部 404 ——
 * 持久化后跨重启有效。文件读不到/写不了时退化为每次激活随机（仅新消息有效）。
 */
function loadOrCreateToken() {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  const file = join(home, 'plugins', 'dsh-image-preview.token')
  try {
    if (existsSync(file)) {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing.length >= 16) return existing
    }
    const fresh = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
    mkdirSync(join(home, 'plugins'), { recursive: true })
    writeFileSync(file, fresh, { mode: 0o600 })
    return fresh
  } catch {
    return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  }
}

/** 扩展名 -> Content-Type。 */
function mediaTypeFor(path) {
  const lower = path.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  if (lower.endsWith('.bmp')) return 'image/bmp'
  if (lower.endsWith('.ico')) return 'image/x-icon'
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4'
  if (lower.endsWith('.webm')) return 'video/webm'
  if (lower.endsWith('.mov')) return 'video/quicktime'
  if (lower.endsWith('.ogv')) return 'video/ogg'
  return null
}

/** 去掉包裹的引号/反引号/括号/尾随标点。 */
function normalizeCandidate(raw) {
  let value = raw.trim()
  value = value.replace(/^['"`[(\s]+/, '')
  value = value.replace(/['"`]+$/, '')
  value = value.replace(/[\]}>]+$/, '')
  value = value.replace(/[;,，。、.]+$/, '')
  return value.trim()
}

/** 只接受本地绝对路径媒体：跳过远程协议、非媒体扩展名、相对路径。 */
function acceptable(path) {
  if (path.length < 3) return false
  if (/^(https?:|data:|file:|mailto:)/i.test(path)) return false
  if (!IMAGE_EXT_RE.test(path) && !VIDEO_EXT_RE.test(path)) return false
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return false
  return true
}

function mediaKind(path) {
  if (IMAGE_EXT_RE.test(path)) return 'image'
  if (VIDEO_EXT_RE.test(path)) return 'video'
  return null
}

/**
 * 扫描文本中的媒体路径区间。
 * @returns {Array<{ path: string; kind: 'image'|'video'; rawStart: number; rawEnd: number }>} 按原文位置升序。
 */
function scanMediaPathRanges(text) {
  const found = []
  const seen = new Set()
  const push = (raw, start, end) => {
    const path = normalizeCandidate(raw)
    const kind = acceptable(path) ? mediaKind(path) : null
    if (kind === null) return
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, kind, rawStart: start, rawEnd: end })
  }

  // 1) Markdown 图片 ![](path)
  const mdRe = /!\[[^\]]*\]\(\s*([^)\s][^)]*?)\s*\)/g
  let match
  while ((match = mdRe.exec(text)) !== null) {
    const inner = match[1].trim()
    const quote = inner[0]
    const path = quote === '"' || quote === "'"
      ? (inner.indexOf(quote, 1) !== -1 ? inner.slice(1, inner.indexOf(quote, 1)) : inner)
      : inner
    push(path, match.index, match.index + match[0].length)
  }

  // 2) 裸绝对路径（盘符 / UNC / POSIX）
  const bareRe = new RegExp('(?:[A-Za-z]:[\\\\/][^' + BARE_STOP + ']+|\\\\[^\\\\\\s]+[\\\\/][^' + BARE_STOP + ']+|\\/[^' + BARE_STOP + ']+)', 'g')
  while ((match = bareRe.exec(text)) !== null) {
    const path = normalizeCandidate(match[0])
    if (!acceptable(path)) continue
    let start = match.index
    let end = match.index + match[0].length
    if (text[start - 1] === '`' && text[end] === '`') {
      start -= 1
      end += 1
    }
    if (seen.has(path)) continue
    seen.add(path)
    found.push({ path, kind: mediaKind(path), rawStart: start, rawEnd: end })
  }
  return found
}

/** 解析 query 字符串（兼容 + 号与 percent-encoding）。 */
function parseQuery(rawUrl) {
  const query = {}
  const at = String(rawUrl ?? '').indexOf('?')
  if (at === -1) return query
  for (const pair of String(rawUrl).slice(at + 1).split('&')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    try { query[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, ' ')) } catch { /* skip */ }
  }
  return query
}

/** 路由处理器：token 校验 + fs 读字节（图片整读）。 */
async function handleImage(req, res, token, fs, attachments) {
  try {
    const query = parseQuery(req.url)
    if (query.t !== token || !query.p) {
      res.writeHead(400); res.end('bad request'); return
    }
    if (mediaKind(query.p) !== 'image') {
      res.writeHead(400); res.end('not an image path'); return
    }
    let maxBytes = DEFAULT_MAX_BYTES
    if (attachments !== undefined) {
      try { maxBytes = attachments.imageLimits.maxImageBytes } catch { /* keep default */ }
    }
    const target = await fs.resolve(query.p)
    const bytes = await fs.readBytes(target, undefined, maxBytes)
    res.writeHead(200, { 'Content-Type': mediaTypeFor(query.p), 'Cache-Control': 'private, max-age=60' })
    res.end(bytes)
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* dropped */ }
  }
}

/** 解析单个 Range 头（bytes=a-b / bytes=a- / bytes=-n），返回 [start, end] 闭区间。 */
function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? '').trim())
  if (!match) return null
  const startRaw = match[1]
  const endRaw = match[2]
  let start
  let end
  if (startRaw === '') {
    // 后缀范围 bytes=-n：取末尾 n 字节。
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    if (!Number.isFinite(start)) return null
    end = endRaw === '' ? size - 1 : Number(endRaw)
    if (!Number.isFinite(end)) return null
  }
  if (start > end || start >= size) return null
  end = Math.min(end, size - 1)
  return [start, end]
}

/** 路由处理器：token 校验 + fs 读字节（视频支持 HTTP Range 分段响应）。 */
async function handleVideo(req, res, token, fs) {
  try {
    const query = parseQuery(req.url)
    if (query.t !== token || !query.p) {
      res.writeHead(400); res.end('bad request'); return
    }
    if (mediaKind(query.p) !== 'video') {
      res.writeHead(400); res.end('not a video path'); return
    }
    const target = await fs.resolve(query.p)
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file' || info.size === undefined) {
      res.writeHead(404); res.end('not found'); return
    }
    const size = info.size
    if (size > DEFAULT_VIDEO_MAX_BYTES) {
      res.writeHead(413); res.end('video too large'); return
    }
    const bytes = await fs.readBytes(target, undefined, DEFAULT_VIDEO_MAX_BYTES)
    const range = parseByteRange(req.headers?.range, size)
    const baseHeaders = {
      'Content-Type': mediaTypeFor(query.p),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
    }
    if (range !== null) {
      const [start, end] = range
      const slice = bytes.subarray(start, end + 1)
      res.writeHead(206, {
        ...baseHeaders,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Content-Length': slice.length,
      })
      res.end(slice)
      return
    }
    res.writeHead(200, { ...baseHeaders, 'Content-Length': bytes.length })
    res.end(bytes)
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* dropped */ }
  }
}

/** 用系统默认应用（macOS QuickTime 等）打开本地媒体文件，detached 不阻塞请求。 */
function openWithLocalApp(absPath) {
  const platform = process.platform
  let command
  let args
  if (platform === 'darwin') {
    command = 'open'; args = [absPath]
  } else if (platform === 'win32') {
    command = process.env.COMSPEC || 'cmd.exe'; args = ['/c', 'start', '', absPath]
  } else {
    command = 'xdg-open'; args = [absPath]
  }
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.unref()
  } catch (error) {
    console.error('[dsh-image-preview] 本地打开失败:', error)
  }
}

/**
 * /open 路由：校验 token 与媒体路径后，用本地工具打开文件，
 * 再 302 到图片路由（新标签直接显示媒体本身）。
 */
async function handleOpen(req, res, token, fs) {
  try {
    const query = parseQuery(req.url)
    if (query.t !== token || !query.p || !acceptable(query.p)) {
      res.writeHead(400); res.end('bad request'); return
    }
    const target = await fs.resolve(query.p)
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') {
      res.writeHead(404); res.end('not found'); return
    }
    openWithLocalApp(fs.processPath(target))
    const route = mediaKind(query.p) === 'video' ? VIDEO_PATH : ROUTE_PATH
    res.writeHead(302, { Location: route + '?t=' + token + '&p=' + encodeURIComponent(query.p) })
    res.end()
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* dropped */ }
  }
}

/** llm/stream 包装：把文本块里的本地媒体路径改写成同源 URL。 */
async function* rewriteStream(next, port, token, fs) {
  const seenPaths = new Set()
  for await (const chunk of next()) {
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      try {
        const text = chunk.block.text
        const ranges = scanMediaPathRanges(text)
        if (ranges.length > 0 && fs !== undefined) {
          let rewritten = text
          const todo = []
          for (const range of ranges) {
            if (seenPaths.has(range.path)) continue
            seenPaths.add(range.path)
            try {
              const target = await fs.resolve(range.path)
              const info = await fs.stat(target)
              if (info === undefined || info.type !== 'file') continue
            } catch {
              continue
            }
            const route = range.kind === 'video' ? VIDEO_PATH : ROUTE_PATH
            const mediaUrl = 'http://127.0.0.1:' + port + route + '?t=' + token + '&p=' + encodeURIComponent(range.path)
            const openUrl = 'http://127.0.0.1:' + port + OPEN_PATH + '?t=' + token + '&p=' + encodeURIComponent(range.path)
            todo.push({ range, mediaUrl, openUrl, path: range.path })
          }
          todo.sort((a, b) => b.range.rawStart - a.range.rawStart)
          for (const { range, mediaUrl, openUrl, path } of todo) {
            // 图片：内联图 + 下一行本地地址链接；视频：播放器链接（client.js 替换为 <video>）+ 地址行。
            const media = range.kind === 'video'
              ? '[' + VIDEO_LABEL + '](' + mediaUrl + ')'
              : '![](' + mediaUrl + ')'
            rewritten = rewritten.slice(0, range.rawStart)
              + media + '\n\n[' + path + '](' + openUrl + ')'
              + rewritten.slice(range.rawEnd)
          }
          if (rewritten !== text) {
            yield { ...chunk, block: { ...chunk.block, text: rewritten } }
            continue
          }
        }
      } catch (error) {
        console.error('[dsh-image-preview] 媒体路径改写失败:', error)
      }
    }
    yield chunk
  }
}

/**
 * 插件入口。所有依赖服务都经 ctx.get 探测（可选），缺失时静默跳过对应能力，
 * 绝不阻塞挂载 —— 与社区插件双挂载崩溃不同，本插件只注册一次、无硬依赖。
 */
export function apply(ctx) {
  const fs = ctx.get('fs')
  const webServer = ctx.get('webServer')
  if (fs === undefined || webServer === undefined) {
    console.warn('[dsh-image-preview] fs/webServer 服务不可用，跳过挂载')
    return
  }
  const attachments = ctx.get('attachments')
  // 持久化 token：会话里的 URL 跨重启有效。
  const token = loadOrCreateToken()

  // 图片回环路由（每次激活生成新 token；卸载时自动注销）。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: (req, res) => void handleImage(req, res, token, fs, attachments),
  }), 'dsh-image-preview: image route')

  // 视频回环路由：支持 HTTP Range，浏览器播放器可拖动进度条。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: VIDEO_PATH,
    handler: (req, res) => void handleVideo(req, res, token, fs),
  }), 'dsh-image-preview: video route')

  // 本地打开路由：点击媒体下方的地址行时，用本地工具打开文件。
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: OPEN_PATH,
    handler: (req, res) => void handleOpen(req, res, token, fs),
  }), 'dsh-image-preview: open route')

  // llm/stream 包装：仅在无 purpose 的用户可见流上改写。
  const llm = ctx.get('llm')
  if (llm !== undefined) {
    ctx.on('llm/stream', (options, next) => {
      if (options?.purpose) return next()
      return rewriteStream(next, webServer.port, token, fs)
    })
  }
}
