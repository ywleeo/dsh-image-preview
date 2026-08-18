/**
 * dsh-image-preview 客户端模块（极简：无 React、无 slots、无状态）。
 *
 * 职责只有两个：
 *  1. 给图片下方的“本地地址”链接套小字号/弱化样式；
 *  2. 拦截对 /open 路由的点击：preventDefault 后只触发 host 的本地打开
 *     （fetch /open → host spawn 本地图片工具），不导航、不开新 tab。
 *
 * 无客户端模块时降级：链接自带 target="_blank"（markdown 渲染器），点击会在
 * 新标签打开 /open，host 照常本地打开，新标签 302 到图片本身 —— 功能不丢，
 * 只是多一个标签页。
 *
 * dsh 的 client-modules 加载器用普通 <script> 标签（非 type="module"）拉取这个
 * 文件，执行时必须调用 window.__ModuleLoader__.load({ id, factory }) 完成注册
 * （见 @deepseek-ai/dsh 的 packages/client/modules/src/client/system.ts），
 * 所以这里不能用 ESM 的 export/import，改成这个工厂闭包的写法。
 */
window.__ModuleLoader__.load({
  id: 'dsh-image-preview',
  factory: function () {
    var OPEN_HREF = '/plugins/dsh-image-preview/open'

    function apply(ctx) {
      if (typeof document === 'undefined') return

      var style = document.createElement('style')
      style.textContent = [
        // 收紧图片与其下方地址链接的间距：默认 .markdown p 上下各 16px，
        // 两侧段落 margin 都压到 2px（只压一侧效果不明显）。
        'p:has(> img[src*="/plugins/dsh-image-preview/image"]) {',
        '  margin-bottom: 2px !important;',
        '}',
        'p:has(> img[src*="/plugins/dsh-image-preview/image"]) + p {',
        '  margin-top: 2px !important;',
        '}',
        'a[href*="' + OPEN_HREF + '"] {',
        '  font-size: 0.85em;',
        '  opacity: 0.72;',
        '  text-decoration: none;',
        '}',
        'a[href*="' + OPEN_HREF + '"]:hover {',
        '  opacity: 1;',
        '  text-decoration: underline;',
        '}',
      ].join('\n')
      document.head.appendChild(style)

      var onClick = function (event) {
        var target = event.target
        var anchor = target !== null && typeof target.closest === 'function' ? target.closest('a') : null
        if (anchor === null) return
        var href = String(anchor.getAttribute('href') ?? '')
        if (href.indexOf(OPEN_HREF) === -1) return
        event.preventDefault()
        event.stopPropagation()
        // 只触发 host 的 /open 路由（本地图片工具打开）；不关心响应体。
        void fetch(href, { method: 'GET' }).catch(function () {})
      }
      document.addEventListener('click', onClick, true)

      ctx.effect(function () {
        return function () {
          document.removeEventListener('click', onClick, true)
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, 'dsh-image-preview: click interceptor')
    }

    return { name: 'dsh-image-preview', apply: apply }
  },
})
