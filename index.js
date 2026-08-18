/**
 * dsh-image-preview —— 让 dsh Web 对话正文直接显示本地图片。
 *
 * host-only 插件，刻意保持最小：
 *  - 不声明 dsh.bundle（作为普通依赖安装，CLI 不会把它加进 profile bundles 层）；
 *  - 从用户 patch 层（cordis.patch.yml）挂载，单条 insert、id 唯一，支持热加载；
 *  - 无客户端组件、无 Typert 远程服务、无 settings 卡片 —— Web 端 Markdown 渲染器
 *    本身支持 http(s) 图片，host 侧把本地路径改写成同源 URL 即可，表面最小化。
 *
 * 工作方式：
 *  1. 包装 llm/stream：助手回复的文本块结束时，扫描真实存在的本地图片绝对路径
 *     （POSIX /…、Windows 盘符、UNC，带图片扩展名），改写为
 *     http://127.0.0.1:<port>/plugins/dsh-image-preview/image?t=<token>&p=<path>。
 *  2. 在 webServer 上注册同一条精确路由：校验随机 token 后，经 ctx.fs 读取文件字节
 *     并按扩展名返回 Content-Type（上限 20MB，或附件服务的 maxImageBytes）。
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
const OPEN_PATH = '/plugins/dsh-image-preview/open'
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|avif|bmp|ico)$/i
const BARE_STOP = "\\s'\"<>\\[\\]\u3001\uFF0C\u3002\uFF1B;`"
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024

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

/** 只接受本地绝对路径图片：跳过远程协议、非图片扩展名、相对路径。 */
function acceptable(path) {
  if (path.length < 3) return false
  if (/^(https?:|data:|file:|mailto:)/i.test(path)) return false
  if (!IMAGE_EXT_RE.test(path)) return false
  if (!/^([A-Za-z]:[\\/]|\\\\|\/)/.test(path)) return false
  return true
}

/**
 * 扫描文本中的图片路径区间。
 * @returns {Array<{ path: string; rawStart: number; rawEnd: number }>} 按原文位置升序。
 */
function scanImagePathRanges(text) {
  const found = []
  const seen = new Set()
  const push = (raw, start, end) => {
    const path = normalizeCandidate(raw)
    if (!acceptable(path)) return
    if (seen.has(path)) return
    seen.add(path)
    found.push({ path, rawStart: start, rawEnd: end })
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
    found.push({ path, rawStart: start, rawEnd: end })
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

/** 路由处理器：token 校验 + fs 读字节。 */
async function handleImage(req, res, token, fs, attachments) {
  try {
    const query = parseQuery(req.url)
    if (query.t !== token || !query.p) {
      res.writeHead(400); res.end('bad request'); return
    }
    const mediaType = mediaTypeFor(query.p)
    if (mediaType === null) {
      res.writeHead(400); res.end('not an image path'); return
    }
    let maxBytes = DEFAULT_MAX_BYTES
    if (attachments !== undefined) {
      try { maxBytes = attachments.imageLimits.maxImageBytes } catch { /* keep default */ }
    }
    const target = await fs.resolve(query.p)
    const bytes = await fs.readBytes(target, undefined, maxBytes)
    res.writeHead(200, { 'Content-Type': mediaType, 'Cache-Control': 'private, max-age=60' })
    res.end(bytes)
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* dropped */ }
  }
}

/** 用系统默认应用（macOS Preview 等）打开本地图片，detached 不阻塞请求。 */
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
 * /open 路由：校验 token 与图片路径后，用本地图片工具打开文件，
 * 再 302 到图片路由（新标签直接显示图片本身）。
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
    res.writeHead(302, { Location: ROUTE_PATH + '?t=' + token + '&p=' + encodeURIComponent(query.p) })
    res.end()
  } catch {
    try { res.writeHead(404); res.end('not found') } catch { /* dropped */ }
  }
}

/** llm/stream 包装：把文本块里的本地图片路径改写成同源图片 URL。 */
async function* rewriteStream(next, port, token, fs) {
  const seenPaths = new Set()
  for await (const chunk of next()) {
    if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      try {
        const text = chunk.block.text
        const ranges = scanImagePathRanges(text)
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
            const imageUrl = 'http://127.0.0.1:' + port + ROUTE_PATH + '?t=' + token + '&p=' + encodeURIComponent(range.path)
            const openUrl = 'http://127.0.0.1:' + port + OPEN_PATH + '?t=' + token + '&p=' + encodeURIComponent(range.path)
            todo.push({ range, imageUrl, openUrl, path: range.path })
          }
          todo.sort((a, b) => b.range.rawStart - a.range.rawStart)
          for (const { range, imageUrl, openUrl, path } of todo) {
            // 图片 + 下一行本地地址链接（点击由客户端模块拦截，仅触发本地打开）。
            rewritten = rewritten.slice(0, range.rawStart)
              + '![](' + imageUrl + ')\n\n[' + path + '](' + openUrl + ')'
              + rewritten.slice(range.rawEnd)
          }
          if (rewritten !== text) {
            yield { ...chunk, block: { ...chunk.block, text: rewritten } }
            continue
          }
        }
      } catch (error) {
        console.error('[dsh-image-preview] 图片路径改写失败:', error)
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

  // 本地打开路由：点击图片下方的地址行时，用本地图片工具打开文件。
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
