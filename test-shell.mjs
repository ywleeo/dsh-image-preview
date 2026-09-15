/**
 * dsh-image-preview 启动壳验证（无外部依赖，不碰真实 ~/.dsh）。
 *
 * 启动壳存在的唯一理由：host.js 坏掉时不能把 dsh 的启动拖死。所以这里验五条：
 *  1. 壳同步返回，host.js 在后台挂载；
 *  2. host.js 正常时挂成子插件，且子插件的 inject 原样传给 cordis；
 *  3. host.js 导入失败（缺文件）→ 不抛，只报告；
 *  4. ctx.plugin 同步抛错 → 不抛，只报告；
 *  5. 子 fiber 的 await 异步 reject → 不抛，只报告。
 *
 * 真实 cordis + boot 审计下的同名验证另有集成探针，这里只锁壳自身的契约。
 */
import { mkdtempSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const root = mkdtempSync(join(tmpdir(), 'dsh-image-preview-shell-'))

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log('  ✓ ' + name)
  else { failed++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')) }
}
const tick = () => new Promise(r => setTimeout(r, 40))

/** 每个用例一个独立目录：拷壳，再放不同的 host.js。 */
function fixture(name, hostSource) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  cpSync(join(here, 'index.js'), join(dir, 'index.js'))
  if (hostSource !== undefined) writeFileSync(join(dir, 'host.js'), hostSource)
  return dir
}

/** 记录壳报告了什么，并模拟 cordis 的 ctx.plugin / fiber 语义（含执行 apply）。 */
function stubCtx(mounts, reports, { failOnMount } = {}) {
  const ctx = {
    logger: { error: (...args) => reports.push(args.join(' ')) },
    plugin(mod) {
      mounts.push(mod)
      if (failOnMount !== undefined) {
        failOnMount(mod)
        return { await: async () => {} }
      }
      const target = typeof mod === 'function' ? { apply: mod } : mod
      const result = target?.apply?.(ctx)
      return { await: async () => { await result } }
    },
  }
  return ctx
}

// 1 + 2：host.js 正常
{
  const dir = fixture('ok', `
export const name = 'probe'
export const inject = ['webServer', 'fs']
export function apply(ctx) { globalThis.__shellProbeOk = true }
`)
  const mounts = []
  const reports = []
  const mod = await import('file://' + join(dir, 'index.js'))
  const returned = mod.apply(stubCtx(mounts, reports))
  check('壳的 apply 同步返回（不阻塞启动）', returned === undefined)
  await tick()
  check('host.js 已被挂成子插件', mounts.length === 1)
  check('子插件仍是 host.js 导出的那个模块', mounts[0]?.apply !== undefined && mounts[0]?.name === 'probe')
  check('host.js 的 inject 原样传给 cordis', JSON.stringify(mounts[0]?.inject) === '["webServer","fs"]', JSON.stringify(mounts[0]?.inject))
  check('正常路径没有产生报告', reports.length === 0)
  check('host.js 确实执行了', globalThis.__shellProbeOk === true)
}

// 3：host.js 缺失（导入失败）
{
  const dir = fixture('no-host', undefined)
  const mounts = []
  const reports = []
  const mod = await import('file://' + join(dir, 'index.js'))
  let threw
  try { mod.apply(stubCtx(mounts, reports)) } catch (error) { threw = error }
  await tick()
  check('导入失败时壳不抛', threw === undefined, String(threw))
  check('导入失败时没有挂载', mounts.length === 0)
  check('导入失败时报告了原因', reports.some(r => r.includes('加载失败')))
}

// 4：ctx.plugin 同步抛错
{
  const dir = fixture('mount-fail', 'export function apply() {}')
  const mounts = []
  const reports = []
  const mod = await import('file://' + join(dir, 'index.js'))
  let threw
  try {
    mod.apply(stubCtx(mounts, reports, { failOnMount: () => { throw new Error('ctx.plugin boom') } }))
  } catch (error) { threw = error }
  await tick()
  check('ctx.plugin 同步抛错时壳不抛', threw === undefined, String(threw))
  check('ctx.plugin 失败时报告了原因', reports.some(r => r.includes('加载失败')))
}

// 5：fiber.await 异步 reject（cordis 里 apply 在微任务中执行，失败由 await 抛出）
{
  const dir = fixture('await-reject', 'export function apply() {}')
  const mounts = []
  const reports = []
  const mod = await import('file://' + join(dir, 'index.js'))
  const ctx = stubCtx(mounts, reports)
  ctx.plugin = (m) => { mounts.push(m); return { await: async () => { throw new Error('fiber boom') } } }
  mod.apply(ctx)
  await tick()
  check('子 fiber 异步失败时壳不抛', true)
  check('子 fiber 异步失败时报告了原因', reports.some(r => r.includes('加载失败')))
}

rmSync(root, { recursive: true, force: true })

if (failed > 0) {
  console.error('\n共 ' + failed + ' 项失败')
  process.exit(1)
}
console.log('\n启动壳校验全部通过')
