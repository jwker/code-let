/**
 * 注入到原型页面的标注脚本。
 *
 * **跟传输方式无关**：它只负责「发现了点击 → 调用 post(message)」。
 * `post` 走 `window.postMessage`，由浏览器视图的 preload（`host/browserPreload`）
 * 转成 IPC 送给主进程 —— 换成 iframe 时只要换外壳，这段不用动。
 *
 * 为什么用「主进程 executeJavaScript 注入到主世界」而不是隔离世界：
 * 标注要**抢在原型自己的脚本前面**把点击吃掉（捕获阶段 + stopImmediatePropagation）。
 * 在隔离世界里对主世界监听器的拦截效果不确定，在主世界里自己就是那个世界的第一层。
 *
 * 角标与描边画在一层 `pointer-events: none` 的浮层上，不往原型自己的元素里塞节点 ——
 * 免得改到原型的内容对齐线，也免得被原型的选择器匹配到。
 */
export const ANNOTATION_SCRIPT = String.raw`(function () {
  if (window.__codeletAnnotation) return
  var LAYER_ID = 'codelet-annotation-layer'
  var OUTLINE = 'codelet-annotation-outline'
  var BADGE = 'codelet-annotation-badge'

  var style = document.createElement('style')
  style.setAttribute('data-codelet-annotation', 'style')
  style.textContent = [
    '#' + LAYER_ID + '{position:fixed;inset:0;pointer-events:none;z-index:2147483646}',
    '.' + OUTLINE + '{position:absolute;box-sizing:border-box;border:2px dashed #356A9A;border-radius:2px;background:rgba(53,106,154,.06)}',
    '.' + OUTLINE + '.solid{border-style:solid;background:transparent}',
    '.' + BADGE + '{position:absolute;box-sizing:border-box;min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#356A9A;color:#fff;font:600 10.5px/18px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.28)}',
    '.' + BADGE + '.temp{background:#B4761D}',
    '.' + BADGE + '.hover{opacity:.7}',
    'html[data-codelet-annotating] [data-block]{cursor:crosshair}'
  ].join('\n')
  document.documentElement.appendChild(style)

  var state = { enabled: false, badges: [], hover: null }
  var frame = 0
  var layer = null

  /** 说出去了。具体是 ipcRenderer.send 还是 window.parent.postMessage 由外壳决定 */
  function post(message) {
    window.postMessage({ __codeletAnnotation: true, message: message }, '*')
  }

  function blockOf(el) {
    return el && el.closest ? el.closest('[data-block]') : null
  }

  function blockNumberOf(el) {
    var raw = el.getAttribute('data-block')
    if (!raw) return null
    var number = Number(raw)
    return Number.isInteger(number) && number > 0 ? number : null
  }

  function textOf(el) {
    var raw = el.innerText || el.textContent || ''
    return raw.replace(/\s+/g, ' ').trim().slice(0, 160)
  }

  function cssEscape(value) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(String(value))
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (char) { return '\\' + char })
  }

  /** 在页面里能唯一定位这一块的选择器：id 优先，否则从根往下数 */
  function selectorOf(el) {
    if (el.id) return '#' + cssEscape(el.id)
    var parts = []
    var node = el
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var part = node.tagName.toLowerCase()
      var classes = node.classList ? Array.prototype.slice.call(node.classList, 0, 2) : []
      for (var i = 0; i < classes.length; i += 1) part += '.' + cssEscape(classes[i])
      var parent = node.parentElement
      if (parent) {
        var same = 0
        var index = 0
        for (var j = 0; j < parent.children.length; j += 1) {
          var child = parent.children[j]
          if (child.tagName !== node.tagName) continue
          same += 1
          if (child === node) index = same
        }
        if (same > 1) part += ':nth-of-type(' + index + ')'
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }

  function describe(el) {
    var block = blockNumberOf(el)
    if (block === null) return null
    return {
      block: block,
      temp: null,
      anchor: 'data-block="' + el.getAttribute('data-block') + '"',
      selector: selectorOf(el),
      text: textOf(el)
    }
  }

  /** 页面上所有的块（只读 data-block，不自己分配号） */
  function blocks() {
    var all = document.querySelectorAll('[data-block]')
    var out = []
    for (var i = 0; i < all.length; i += 1) {
      var described = describe(all[i])
      if (described) out.push(described)
    }
    return out
  }

  function schedule() {
    if (frame) return
    frame = window.requestAnimationFrame(render)
  }

  function outlineNode(rect, solid) {
    var node = document.createElement('div')
    node.className = OUTLINE + (solid ? ' solid' : '')
    node.style.left = rect.left + 'px'
    node.style.top = rect.top + 'px'
    node.style.width = rect.width + 'px'
    node.style.height = rect.height + 'px'
    return node
  }

  function badgeNode(rect, key, translucent) {
    var node = document.createElement('div')
    node.className = BADGE + (translucent ? ' hover' : '')
    node.textContent = key
    node.style.left = Math.round(rect.left + 4) + 'px'
    node.style.top = Math.round(rect.top + 4) + 'px'
    return node
  }

  function findBlock(key) {
    var all = document.querySelectorAll('[data-block]')
    for (var i = 0; i < all.length; i += 1) {
      if (String(blockNumberOf(all[i])) === key) return all[i]
    }
    return null
  }

  /** 重画浮层：常驻角标 + 悬停候选 */
  function render() {
    frame = 0
    if (!document.documentElement) return
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div')
      layer.id = LAYER_ID
      document.documentElement.appendChild(layer)
    }
    layer.textContent = ''
    if (!state.enabled && state.badges.length === 0) return

    var annotated = {}
    for (var i = 0; i < state.badges.length; i += 1) annotated[state.badges[i]] = true

    for (var key in annotated) {
      if (!Object.prototype.hasOwnProperty.call(annotated, key)) continue
      if (state.enabled && state.hover && state.hover.key === key) continue
      var el = findBlock(key)
      if (!el) continue
      var rect = el.getBoundingClientRect()
      if (rect.width < 1 && rect.height < 1) continue
      layer.appendChild(outlineNode(rect, true))
      layer.appendChild(badgeNode(rect, key, false))
    }

    if (state.enabled && state.hover && state.hover.el && state.hover.el.isConnected) {
      var hoverRect = state.hover.el.getBoundingClientRect()
      layer.appendChild(outlineNode(hoverRect, Boolean(annotated[state.hover.key])))
      layer.appendChild(badgeNode(hoverRect, state.hover.key, !annotated[state.hover.key]))
    }
  }

  function updateHover(event) {
    if (!state.enabled) {
      if (state.hover) {
        state.hover = null
        schedule()
      }
      return
    }
    var el = blockOf(event.target)
    var block = el ? blockNumberOf(el) : null
    if (el && block === null) el = null
    var next = el ? { el: el, key: String(block) } : null
    if (next && state.hover && state.hover.el === next.el) return
    if (!next && !state.hover) return
    state.hover = next
    schedule()
  }

  function onClick(event) {
    if (!state.enabled) return
    var el = blockOf(event.target)
    if (!el) return
    var described = describe(el)
    if (!described) return
    // 标注模式下点击归标注：拦掉原型自己的交互（捕获阶段，先于页面自己的监听器）
    event.preventDefault()
    event.stopImmediatePropagation()
    event.stopPropagation()
    var key = String(described.block)
    if (state.badges.indexOf(key) < 0) state.badges = state.badges.concat(key)
    state.hover = { el: el, key: key }
    schedule()
    post({ type: 'pick', block: described })
  }

  window.__codeletAnnotation = {
    setMode: function (enabled) {
      state.enabled = Boolean(enabled)
      state.hover = null
      if (state.enabled) document.documentElement.setAttribute('data-codelet-annotating', '')
      else document.documentElement.removeAttribute('data-codelet-annotating')
      schedule()
    },
    setBadges: function (keys) {
      state.badges = (keys || []).map(String)
      schedule()
    },
    blocks: blocks,
    /** 给端到端测试读回页面状态：模式、悬停的是哪一块、哪些块带着角标 */
    state: function () {
      return {
        enabled: state.enabled,
        hover: state.hover ? state.hover.key : null,
        badges: state.badges.slice()
      }
    }
  }

  /** Esc 退出标注模式 —— 焦点在页面里的时候也能走，不用回去点工具栏 */
  function onKeyDown(event) {
    if (!state.enabled || event.key !== 'Escape') return
    post({ type: 'exit' })
  }

  document.addEventListener('mousemove', updateHover, true)
  document.addEventListener('click', onClick, true)
  document.addEventListener('keydown', onKeyDown, true)
  document.addEventListener('scroll', schedule, true)
  window.addEventListener('resize', schedule)
})()`
