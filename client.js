/**
 * dsh-image-preview 客户端模块（极简：无 React、无 slots、无状态）。
 *
 * 职责：
 *  1. 给媒体下方的“本地地址”链接套小字号/弱化样式；
 *  2. 拦截对 /open 路由的点击：preventDefault 后只触发 host 的本地打开
 *     （fetch /open → host spawn 本地播放器/图片工具），不导航、不开新 tab；
 *  3. 把 host 改写的「▶ 播放视频」链接替换成 <video controls> 播放器
 *     （MutationObserver 兜底，兼容流式渲染完成后才出现的元素）。
 *
 * 无客户端模块时降级：视频链接点击会在新标签打开 /video 路由 —— host 返回视频
 * 字节，浏览器直接播放；图片链接新标签 302 到图片本身 —— 功能不丢，只是没有
 * 内联播放器。
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
    var VIDEO_HREF = '/plugins/dsh-image-preview/video'
    var VIDEO_LABEL = '▶ 播放视频'

    function apply(ctx) {
      if (typeof document === 'undefined') return

      var style = document.createElement('style')
      style.textContent = [
        // 收紧媒体与其下方地址链接的间距：默认 .markdown p 上下各 16px，
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
        // 视频播放器：宽度铺满、限高、圆角、黑底。
        'video[src*="' + VIDEO_HREF + '"] {',
        '  width: 100%;',
        '  max-height: 480px;',
        '  display: block;',
        '  border-radius: 8px;',
        '  background: #000;',
        '}',
        'p:has(> video[src*="' + VIDEO_HREF + '"]) {',
        '  margin-bottom: 2px !important;',
        '}',
        'p:has(> video[src*="' + VIDEO_HREF + '"]) + p {',
        '  margin-top: 2px !important;',
        '}',
      ].join('\n')
      document.head.appendChild(style)

      // 把「▶ 播放视频」链接替换成 <video controls> 播放器。
      var replaceVideos = function () {
        var anchors = document.querySelectorAll('a[href*="' + VIDEO_HREF + '"]')
        for (var i = 0; i < anchors.length; i++) {
          var anchor = anchors[i]
          if (anchor.getAttribute('data-dsh-video') === '1') continue
          anchor.setAttribute('data-dsh-video', '1')
          var href = anchor.getAttribute('href')
          var video = document.createElement('video')
          video.controls = true
          video.preload = 'metadata'
          video.src = href
          video.addEventListener('error', function () {
            // 加载失败（404/被拦截等）：还原为可点击的播放链接。
            var el = this
            var fallback = document.createElement('a')
            fallback.href = href
            fallback.textContent = VIDEO_LABEL
            if (el.parentNode !== null) el.parentNode.replaceChild(fallback, el)
          })
          anchor.parentNode.replaceChild(video, anchor)
        }
      }

      var observer = null
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(replaceVideos)
        observer.observe(document.body, { childList: true, subtree: true })
      }
      replaceVideos()

      var onClick = function (event) {
        var target = event.target
        var anchor = target !== null && typeof target.closest === 'function' ? target.closest('a') : null
        if (anchor === null) return
        var href = String(anchor.getAttribute('href') ?? '')
        if (href.indexOf(OPEN_HREF) === -1) return
        event.preventDefault()
        event.stopPropagation()
        // 只触发 host 的 /open 路由（本地媒体工具打开）；不关心响应体。
        void fetch(href, { method: 'GET' }).catch(function () {})
      }
      document.addEventListener('click', onClick, true)

      ctx.effect(function () {
        return function () {
          if (observer !== null) observer.disconnect()
          document.removeEventListener('click', onClick, true)
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, 'dsh-image-preview: media interceptors')
    }

    return { name: 'dsh-image-preview', apply: apply }
  },
})
