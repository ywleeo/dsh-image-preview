/**
 * dsh-image-preview 启动壳（boot shell）。
 *
 * 为什么有这个文件：dsh 的 loader 条目一旦激活失败，boot 的激活审计会把整棵
 * 插件树判死、进程非零退出——插件崩了，等于 dsh 起不来。而插件恰恰是最容易
 * 被核心升级打坏的东西。本插件包装 llm/stream、注册三条路由，正是最容易挨刀的
 * 那一类，所以壳把"会坏的部分"赶出启动路径：壳自己只做一件事，运行时动态加载
 * ./host.js 并挂成子插件；加载失败或激活失败都只丢功能，dsh 照常启动。
 *
 * 约定（改这个文件之前先读一遍）：
 *  1. 壳必须极稳：不 import 任何 dsh 核心模块，不读配置，不做 IO。
 *  2. 真正的插件逻辑全在 host.js，随便改、随便升级——它坏了不影响启动。
 *  3. 壳不声明 inject，所以它的 loader 条目永远 ACTIVE；host.js 自己的
 *     inject: ['webServer', 'fs'] 在子 fiber 上照常生效（服务没就绪就先挂起，
 *     就绪后自动激活）。
 *  4. package.json 的 main 仍指向本文件，dsh.client 与 exports["./client"] 也
 *     不动——客户端那一半靠 loader 条目名去找包，路径不能变。
 */

export const name = 'dsh-image-preview'

/** 真实插件模块，相对于本文件。 */
const HOST = './host.js'

/** 报告一次加载失败：插件停用，dsh 继续跑。这个函数自己不许抛。 */
function report(ctx, error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  const line = '[dsh-image-preview] host.js 加载失败，插件功能已停用，dsh 继续运行。原因：' + detail
  try {
    if (typeof ctx?.logger?.error === 'function') {
      ctx.logger.error('%s', line)
      return
    }
  } catch {
    // logger 不可用或自己炸了，退到 stderr
  }
  try {
    console.error(line)
  } catch {
    // 连 stderr 都不可用也不能让壳变成新的启动故障点
  }
}

/**
 * 插件入口。同步返回，真正的加载丢给后台任务：壳的 fiber 立即 ACTIVE，
 * boot 不会等待这次动态导入。
 */
export function apply(ctx) {
  void mount(ctx)
}

/** 动态加载 host.js 并挂成子插件；任何失败只报告，不向外抛。 */
async function mount(ctx) {
  let loaded
  try {
    loaded = await import(HOST)
  } catch (error) {
    report(ctx, error)
    return
  }
  let fiber
  try {
    fiber = ctx.plugin(unwrap(loaded))
  } catch (error) {
    // 同步抛出的注册错误（插件形状不合法等）
    report(ctx, error)
    return
  }
  if (fiber !== undefined && typeof fiber.await === 'function') {
    // cordis 的 apply 在微任务里执行，失败记在子 fiber 上、由 await() 抛出。
    // 这里必须自己吞掉——漏出去会冒泡成父 fiber 的失败，那正是壳要挡的事。
    void fiber.await().catch((error) => report(ctx, error))
  }
}

/** 与 loader 的 unwrapExports 同形：解掉 default 与 esbuild 的 __esModule 包装。 */
function unwrap(exports) {
  if (exports === null || exports === undefined) return exports
  let value = exports.default ?? exports
  if (value.__esModule) value = value.default ?? value
  return value
}
