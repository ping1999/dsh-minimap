// Browser half of dsh-minimap. Loaded through the web plugin loader
// (window.__ModuleLoader__). Overlays a VS Code-style minimap — a wide text
// thumbnail with a draggable viewport box — onto every CodeMirror 6 editor
// that appears inside the side file viewer (dsh-better-sidebar).
//
// The file is layered for resilience:
//   1. Pure DOM core (createMinimapManager and helpers) — no dsh/cordis
//      references; every browser primitive is injected through `env`, so the
//      core can be re-homed under any host/module ABI unchanged.
//   2. Thin dsh glue at the bottom — ModuleLoader registration plus a cordis
//      `apply` that starts the manager inside `ctx.effect`.
//
// The editor document is read through CM6's DOM back-reference (the same path
// as the public `EditorView.findFromDOM`: `dom.cmTile`, walk `.parent` to the
// root tile, read `.view`). If a future CodeMirror/sidebar update removes
// that chain, `viewFromDOM` returns null and the minimap simply does not
// render — the editor itself is never affected.
//
// Scroll mapping is fraction-based: the editor's true scroll range
// (scroller.scrollHeight - clientHeight, including any bottom padding and
// CM's live height re-estimates) and the minimap's own scroll range share one
// fraction, so dragging the box to the very bottom always lands the editor at
// its real maximum scrollTop, and the box stays glued to both ends.
//
// Syntax colors: CM6 virtualizes its DOM, so token colors exist only for the
// lines currently rendered. The minimap captures per-line color segments from
// that live DOM into a cache (keyed by line number, validated by line text)
// and draws colored text where a capture exists, falling back to the editor's
// base text color elsewhere. Lines therefore pick up their syntax colors
// progressively as they are scrolled into view at least once.

;(function () {
  'use strict'

  // ---------------------------------------------------------------------
  // Pure DOM core
  // ---------------------------------------------------------------------

  const CONFIG = {
    widthRatio: 0.22,        // minimap width as a fraction of the editor width
    widthMin: 56,            // CSS px floor for the thumbnail
    widthMax: 110,           // CSS px ceiling for the thumbnail (the classic fixed width)
    gap: 5,                  // fixed CSS px gap between text and thumbnail
    lineHeight: 3,           // minimap CSS px per document line
    maxCanvasFactor: 8,      // cap minimap height at containerH * this
    textAlpha: 0.55,         // thumbnail text opacity
    maxLineChars: 300,       // per-line draw cap (canvas clips anyway)
    colorCacheMax: 4000,     // cap on cached per-line color segments (FIFO-evicted)
    scanDebounceMs: 100,     // editor discovery debounce
    contentDebounceMs: 150,  // document-change debounce
    colorCaptureDebounceMs: 150, // token-color capture debounce (after scroll settles)
    editorSelector: '[data-dsh-better-sidebar] .cm-editor',
    styleId: 'dsh-minimap-style',
  }

  // Geometry adapts to the editor width: a narrow sidebar gets a narrow
  // thumbnail (and a proportionally slim reserved gutter), a wide one gets
  // the full VS Code-like width. Width/padding are applied per instance
  // (inline style + CSS var), so editors of different sizes coexist.
  function minimapWidthFor(containerW) {
    if (!(containerW > 0)) return CONFIG.widthMin
    return Math.min(CONFIG.widthMax, Math.max(CONFIG.widthMin, Math.round(containerW * CONFIG.widthRatio)))
  }

  // Total room reserved for the thumbnail: its width plus a fixed 5px gap.
  // Any right-side chrome the editor already has (cm-scroller padding, …)
  // counts toward this total — see applySize.
  function reservedPadFor(width) {
    return width + CONFIG.gap
  }

  const CSS = `
.dsh-minimap{position:absolute;top:0;right:0;z-index:5;cursor:pointer;touch-action:none}
[data-dsh-minimap] .cm-content{padding-right:var(--dsh-minimap-pad,115px) !important}
`

  // CM6 keeps a back-reference from the editor DOM to the EditorView:
  // `EditorView.findFromDOM(dom)` reads `dom.cmTile` (on `.cm-content` or the
  // editor root), walks `.parent` to the root tile and returns `.view`.
  // Duck-typed copy — no @codemirror imports available in this realm.
  function viewFromDOM(cmEditor) {
    try {
      const content = cmEditor.querySelector('.cm-content')
      let tile = (content && content.cmTile) || cmEditor.cmTile
      while (tile && tile.parent) tile = tile.parent
      return (tile && tile.view) || null
    } catch (e) {
      return null
    }
  }

  // Minimap line height: fixed unless the document is too tall for the
  // canvas budget, in which case lines are scaled down uniformly.
  function computeLineHeight(lines, containerH) {
    const base = CONFIG.lineHeight
    const maxH = containerH * CONFIG.maxCanvasFactor
    if (!(lines > 0) || !(containerH > 0)) return base
    return lines * base > maxH ? maxH / lines : base
  }

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v
  }

  // The one fraction both scroll ranges share: 0 = top, 1 = bottom. Uses the
  // editor's TRUE scroll range (scroller.scrollHeight), so bottom padding and
  // CM's height re-estimates never leave the editor short of its real end.
  function scrollFraction(scrollTop, docScrollRange) {
    if (!(docScrollRange > 0)) return 0
    return clamp01(scrollTop / docScrollRange)
  }

  // Proportional scroll mapping: both scroll ranges share one fraction so the
  // minimap and the editor hit their top/bottom ends together.
  function minimapOffsetFor(scrollTop, docScrollRange, miniScrollRange) {
    if (!(miniScrollRange > 0)) return 0
    return scrollFraction(scrollTop, docScrollRange) * miniScrollRange
  }

  // Pixels the viewport box can travel inside the canvas. When the document's
  // minimap is shorter than the canvas, travel is limited to the document
  // thumbnail so the box never slides into empty canvas below the text.
  function boxSpan(containerH, totalMiniH, boxH) {
    return Math.max(0, Math.min(containerH, totalMiniH) - boxH)
  }

  // Canvas-space top of the viewport box: 0 at scroll top, span at bottom.
  function viewportBoxTop(scrollTop, docScrollRange, containerH, totalMiniH, boxH) {
    return scrollFraction(scrollTop, docScrollRange) * boxSpan(containerH, totalMiniH, boxH)
  }

  // 1-based inclusive line range [from, to] visible in the minimap viewport.
  function visibleLineRange(offset, containerH, lineH, lines) {
    const from = Math.max(1, Math.floor(offset / lineH) + 1)
    const to = Math.min(lines, Math.ceil((offset + containerH) / lineH))
    return { from, to }
  }

  // Editor scrollTop for a drag/click at canvas-space y `y`, grabbed
  // `grabOffset` px below the box top (half the box height for a plain click =
  // jump-and-center). `span` is boxSpan(); fraction-based, so dragging the
  // box to the minimap's bottom edge yields exactly the editor's max scroll.
  function scrollTopForMiniY(y, grabOffset, span, docScrollRange) {
    if (!(span > 0) || !(docScrollRange > 0)) return 0
    return Math.round(clamp01((y - grabOffset) / span) * docScrollRange)
  }

  // Walk a rendered `.cm-line` element and collect colored text segments:
  // [{ from: <column>, color: <css color> }], adjacent same-color runs merged.
  // `getStyle(el)` is getComputedStyle injected for testability.
  function collectLineSegments(lineEl, baseColor, getStyle) {
    const segs = []
    let col = 0
    const rec = (node, color) => {
      const children = node.childNodes || node.children || []
      for (const child of children) {
        if (child.nodeType === 3) {
          const len = (child.nodeValue || '').length
          if (len > 0) {
            const last = segs[segs.length - 1]
            if (!last || last.color !== color) segs.push({ from: col, color })
            col += len
          }
        } else if (child.nodeType === 1) {
          let c = color
          try {
            c = (getStyle(child) || {}).color || color
          } catch (e) { /* keep parent color */ }
          rec(child, c)
        }
      }
    }
    rec(lineEl, baseColor)
    return segs
  }

  // Snapshot of everything render/drag need. Returns null when the editor is
  // not readable yet (still mounting, CM internals moved, zero-size host).
  function computeMetrics(view, editorEl, wrapper) {
    if (!view || !view.state || !view.state.doc) return null
    const doc = view.state.doc
    if (typeof doc.lines !== 'number' || typeof doc.line !== 'function') return null
    const scroller = view.scrollDOM || editorEl.querySelector('.cm-scroller')
    if (!scroller) return null
    const containerH = wrapper.clientHeight
    if (!(containerH > 0)) return null
    const clientH = scroller.clientHeight || containerH
    // The scroller is the ground truth for how far the editor can scroll —
    // view.contentHeight is an estimate CM revises while measuring and it
    // excludes bottom padding (e.g. scrollPastEnd).
    const scrollH = scroller.scrollHeight || 0
    let contentH = view.contentHeight
    if (!(contentH > 0)) contentH = scrollH
    if (!(contentH > 0) && !(scrollH > 0)) return null
    const lines = doc.lines
    const lineH = computeLineHeight(lines, containerH)
    const totalMiniH = lines * lineH
    const ratio = contentH > 0 ? totalMiniH / contentH : 0
    const docScrollRange = Math.max(0, (scrollH || contentH) - clientH)
    const miniScrollRange = Math.max(0, totalMiniH - containerH)
    return {
      view, doc, scroller, lines, lineH, totalMiniH, ratio, clientH, contentH,
      containerH, docScrollRange, miniScrollRange,
    }
  }

  // Viewport box height: the fraction of the document that is visible,
  // expressed in minimap pixels — floored so it stays grabbable, and clamped
  // to the thumbnail itself so a document that fits the viewport gets a box
  // covering exactly its thumbnail instead of overflowing into empty canvas.
  function boxHeightFor(m) {
    return Math.min(m.containerH, m.totalMiniH, Math.max(8, m.clientH * m.ratio))
  }

  function createMinimapInstance(env, editorEl) {
    const doc0 = env.document
    const win = env.window
    const wrapper = editorEl.parentElement
    if (!wrapper) return null

    let disposed = false
    let rafId = null
    let contentTimer = null
    let captureTimer = null
    let retryTimer = null
    let retryCount = 0
    let boundScroller = null
    let boundContent = null
    let dragging = false
    let dragPointerId = null
    let grabOffset = 0
    let hasCaptured = false
    let changedWrapperPosition = false
    // lineNumber -> { text, segs } — syntax-color segments captured from CM's
    // live (virtualized) DOM; validated against the line text at draw time.
    const colorCache = new Map()

    if (win.getComputedStyle(wrapper).position === 'static') {
      wrapper.style.position = 'relative'
      changedWrapperPosition = true
    }

    const canvas = doc0.createElement('canvas')
    canvas.className = 'dsh-minimap'
    wrapper.appendChild(canvas)
    // Reserve room for the thumbnail: the attribute enables a CSS rule that
    // pads .cm-content on the right so text never flows under the canvas.
    // Both the canvas width and the reserved padding track the editor width.
    wrapper.setAttribute('data-dsh-minimap', '')
    let cssWidth = 0
    const applySize = () => {
      const w = minimapWidthFor(wrapper.clientWidth)
      if (w === cssWidth) return
      cssWidth = w
      canvas.style.width = w + 'px'
      // The editor's own right-side chrome (e.g. cm-scroller's padding-right)
      // already keeps text away from the edge; only pad .cm-content by what
      // remains, so the visible text↔thumbnail gap lands exactly at the
      // configured gap and the total reservation stays width + gap.
      let pad = reservedPadFor(w)
      const content = wrapper.querySelector('.cm-content')
      if (content && content.getBoundingClientRect && wrapper.getBoundingClientRect) {
        const chrome = Math.round(wrapper.getBoundingClientRect().right - content.getBoundingClientRect().right)
        if (chrome > 0) pad = Math.max(0, pad - Math.min(chrome, pad))
      }
      wrapper.style.setProperty('--dsh-minimap-pad', pad + 'px')
    }
    applySize()

    const requestFrame = (cb) => {
      if (typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(cb)
      return win.setTimeout(cb, 16)
    }
    const cancelFrame = (id) => {
      if (typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(id)
      else win.clearTimeout(id)
    }

    const scheduleRender = () => {
      if (disposed || rafId !== null) return
      rafId = requestFrame(() => {
        rafId = null
        render()
      })
    }

    const scheduleContentRender = () => {
      if (disposed) return
      if (contentTimer !== null) win.clearTimeout(contentTimer)
      contentTimer = win.setTimeout(() => {
        contentTimer = null
        scheduleRender()
        scheduleColorCapture()
      }, CONFIG.contentDebounceMs)
    }

    const contentObserver = typeof win.MutationObserver === 'function'
      ? new win.MutationObserver(scheduleContentRender)
      : null
    const resizeObserver = typeof win.ResizeObserver === 'function'
      ? new win.ResizeObserver(() => {
        applySize()
        scheduleRender()
      })
      : null
    resizeObserver && resizeObserver.observe(wrapper)

    const metrics = () => computeMetrics(viewFromDOM(editorEl), editorEl, wrapper)

    // Token colors live only in CM's rendered (virtualized) lines. Capture
    // them into colorCache; debounced so it runs after scrolling settles,
    // not on every scroll frame.
    const captureColors = (m) => {
      if (disposed || !m || !m.view || typeof m.view.posAtDOM !== 'function') return
      const content = boundContent || editorEl.querySelector('.cm-content')
      if (!content) return
      let base = ''
      try {
        base = (win.getComputedStyle(content) || {}).color || ''
      } catch (e) { /* fall through to default */ }
      base = base || '#888888'
      const getStyle = (el) => win.getComputedStyle(el)
      for (const el of Array.from(content.children || [])) {
        if (!el.classList || !el.classList.contains('cm-line')) continue
        let line = null
        try {
          line = m.doc.lineAt(m.view.posAtDOM(el, 0))
        } catch (e) {
          continue
        }
        if (!line || line.number < 1 || line.number > m.lines) continue
        // delete+set refreshes the insertion position, so eviction below
        // drops the stalest captures first (insertion order = recency).
        colorCache.delete(line.number)
        colorCache.set(line.number, { text: line.text, segs: collectLineSegments(el, base, getStyle) })
      }
      // Bound the cache: without a cap it grows with every distinct line ever
      // scrolled into view (and with orphaned entries left behind by edits).
      while (colorCache.size > CONFIG.colorCacheMax) {
        colorCache.delete(colorCache.keys().next().value)
      }
    }

    const scheduleColorCapture = () => {
      if (disposed || captureTimer !== null) return
      captureTimer = win.setTimeout(() => {
        captureTimer = null
        const m = metrics()
        if (m) {
          captureColors(m)
          scheduleRender()
        }
      }, CONFIG.colorCaptureDebounceMs)
    }

    const onScroll = () => {
      scheduleRender()
      scheduleColorCapture()
    }

    // Scroll/content listeners bind lazily on the first readable render: the
    // CM view may not be reachable at attach time while the editor mounts.
    const ensureBound = (m) => {
      if (m.scroller !== boundScroller) {
        if (boundScroller) boundScroller.removeEventListener('scroll', onScroll)
        boundScroller = m.scroller
        boundScroller.addEventListener('scroll', onScroll, { passive: true })
      }
      const content = editorEl.querySelector('.cm-content')
      if (contentObserver && content && content !== boundContent) {
        if (boundContent) contentObserver.disconnect()
        boundContent = content
        contentObserver.observe(content, { childList: true, subtree: true, characterData: true })
      }
    }

    const render = () => {
      if (disposed) return
      const m = metrics()
      if (!m) {
        // Editor still mounting (CM view not reachable yet): bounded retry —
        // the scroll/content listeners bind on the first successful render,
        // so without a retry a slow mount would leave the overlay inert.
        if (retryCount++ < 40 && retryTimer === null) {
          retryTimer = win.setTimeout(() => {
            retryTimer = null
            scheduleRender()
          }, 250)
        }
        return
      }
      retryCount = 0
      ensureBound(m)
      if (!hasCaptured) {
        // Capture once up front so the first paint already has colors for
        // the lines CM has rendered.
        hasCaptured = true
        captureColors(m)
      }

      const cssW = cssWidth || minimapWidthFor(wrapper.clientWidth)
      const cssH = m.containerH
      const dpr = win.devicePixelRatio || 1
      const pixelW = Math.round(cssW * dpr)
      const pixelH = Math.round(cssH * dpr)
      if (canvas.width !== pixelW) canvas.width = pixelW
      if (canvas.height !== pixelH) canvas.height = pixelH
      const heightCss = cssH + 'px'
      if (canvas.style.height !== heightCss) canvas.style.height = heightCss

      const ctx = canvas.getContext && canvas.getContext('2d')
      if (!ctx) return
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, cssW, cssH)

      const scrollTop = m.scroller.scrollTop || 0
      const offset = minimapOffsetFor(scrollTop, m.docScrollRange, m.miniScrollRange)

      const content = boundContent || editorEl.querySelector('.cm-content')
      const color = content ? win.getComputedStyle(content).color : ''
      ctx.font = Math.max(1, m.lineH * 0.8) + 'px monospace'
      ctx.textBaseline = 'top'
      const baseColor = color || '#888888'
      ctx.fillStyle = baseColor
      ctx.globalAlpha = CONFIG.textAlpha
      // Monospace advance per character — segment x offsets are column-based.
      const charW = (ctx.measureText && ctx.measureText('M').width) || 1
      const { from, to } = visibleLineRange(offset, cssH, m.lineH, m.lines)
      for (let n = from; n <= to; n++) {
        const raw = String(m.doc.line(n).text || '')
        const y = (n - 1) * m.lineH - offset
        const entry = colorCache.get(n)
        if (entry && entry.text === raw && entry.segs.length > 0) {
          for (let i = 0; i < entry.segs.length; i++) {
            const seg = entry.segs[i]
            if (seg.from >= CONFIG.maxLineChars) break
            const segEnd = i + 1 < entry.segs.length ? entry.segs[i + 1].from : raw.length
            const chunk = raw.slice(seg.from, Math.min(segEnd, CONFIG.maxLineChars)).replace(/\s+$/, '')
            if (!chunk) continue
            ctx.fillStyle = seg.color
            ctx.fillText(chunk, seg.from * charW, y)
          }
          ctx.fillStyle = baseColor
        } else {
          const text = raw.replace(/\s+$/, '')
          if (text) ctx.fillText(text.slice(0, CONFIG.maxLineChars), 0, y)
        }
      }
      ctx.globalAlpha = 1

      const boxH = boxHeightFor(m)
      const boxTop = viewportBoxTop(scrollTop, m.docScrollRange, cssH, m.totalMiniH, boxH)
      ctx.fillStyle = 'rgba(128,128,128,0.20)'
      ctx.fillRect(0, boxTop, cssW, boxH)
      ctx.strokeStyle = 'rgba(128,128,128,0.35)'
      ctx.lineWidth = 1
      ctx.strokeRect(0.5, boxTop + 0.5, cssW - 1, boxH - 1)
    }

    // Drag/click math lives in canvas (screen) space. Never mix in the
    // minimap's content offset here: offset is derived from scrollTop, so
    // using it mid-drag feeds each step's output back into the next step's
    // input and the box outruns the pointer (runs to the bottom early).
    const pointerY = (e) => e.clientY - canvas.getBoundingClientRect().top

    const applyDrag = (e, m) => {
      const span = boxSpan(m.containerH, m.totalMiniH, boxHeightFor(m))
      m.scroller.scrollTop = scrollTopForMiniY(pointerY(e), grabOffset, span, m.docScrollRange)
    }

    // Pointer events unify mouse/touch/pen. The pointer id pins the drag to
    // the finger or button that started it, so extra touches can neither move
    // nor cancel an active drag.
    const onPointerMove = (e) => {
      if (!dragging || e.pointerId !== dragPointerId) return
      const m = metrics()
      if (m) applyDrag(e, m)
    }

    const stopDrag = () => {
      if (!dragging) return
      dragging = false
      dragPointerId = null
      doc0.removeEventListener('pointermove', onPointerMove)
      doc0.removeEventListener('pointerup', onPointerEnd)
      doc0.removeEventListener('pointercancel', onPointerEnd)
      if (doc0.body) doc0.body.style.userSelect = ''
      canvas.style.cursor = ''
    }

    const onPointerEnd = (e) => {
      if (e.pointerId !== dragPointerId) return
      stopDrag()
    }

    const onPointerDown = (e) => {
      if (e.button !== 0 || dragging) return
      const m = metrics()
      if (!m) return
      e.preventDefault()
      const y = pointerY(e)
      const boxH = boxHeightFor(m)
      const boxTop = viewportBoxTop(m.scroller.scrollTop || 0, m.docScrollRange, m.containerH, m.totalMiniH, boxH)
      // Grab inside the box keeps the relative position (no jump); a click
      // outside jumps so the box centers on the pointer.
      grabOffset = y >= boxTop && y <= boxTop + boxH ? y - boxTop : boxH / 2
      dragging = true
      dragPointerId = e.pointerId
      if (doc0.body) doc0.body.style.userSelect = 'none'
      canvas.style.cursor = 'grabbing'
      doc0.addEventListener('pointermove', onPointerMove)
      doc0.addEventListener('pointerup', onPointerEnd)
      doc0.addEventListener('pointercancel', onPointerEnd)
      applyDrag(e, m)
    }

    // Wheel forwarding: the canvas overlays the scroller's right edge, so
    // wheel gestures on it would otherwise be dead. deltaMode 1 (lines,
    // e.g. Firefox) and 2 (pages) are scaled to pixels, horizontal deltas
    // pan the scroller, and ctrl+wheel (pinch zoom) is left to the browser.
    const onWheel = (e) => {
      if (e.ctrlKey) return
      const m = metrics()
      if (!m) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? (m.contentH / m.lines) || 16
        : e.deltaMode === 2 ? m.clientH : 1
      if (e.deltaY) m.scroller.scrollTop += e.deltaY * unit
      if (e.deltaX) m.scroller.scrollLeft += e.deltaX * unit
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('wheel', onWheel, { passive: false })

    scheduleRender()

    return {
      editorEl,
      canvas,
      render,
      dispose() {
        if (disposed) return
        disposed = true
        stopDrag()
        if (rafId !== null) cancelFrame(rafId)
        if (contentTimer !== null) win.clearTimeout(contentTimer)
        if (captureTimer !== null) win.clearTimeout(captureTimer)
        if (retryTimer !== null) win.clearTimeout(retryTimer)
        if (boundScroller) boundScroller.removeEventListener('scroll', onScroll)
        contentObserver && contentObserver.disconnect()
        resizeObserver && resizeObserver.disconnect()
        canvas.removeEventListener('pointerdown', onPointerDown)
        canvas.removeEventListener('wheel', onWheel)
        if (canvas.parentElement) canvas.parentElement.removeChild(canvas)
        if (changedWrapperPosition) wrapper.style.position = ''
        wrapper.removeAttribute('data-dsh-minimap')
        if (wrapper.style.removeProperty) wrapper.style.removeProperty('--dsh-minimap-pad')
      },
    }
  }

  function createMinimapManager(env) {
    const doc0 = env.document
    const win = env.window
    const instances = new Map()
    let disposed = false
    let scanTimer = null
    let styleEl = null

    const scan = () => {
      if (disposed) return
      const found = doc0.querySelectorAll(CONFIG.editorSelector)
      const seen = new Set()
      for (const el of found) {
        seen.add(el)
        if (!instances.has(el)) {
          const inst = createMinimapInstance(env, el)
          if (inst) instances.set(el, inst)
        }
      }
      for (const [el, inst] of Array.from(instances)) {
        if (!seen.has(el)) {
          inst.dispose()
          instances.delete(el)
        }
      }
    }

    const scheduleScan = () => {
      if (disposed || scanTimer !== null) return
      scanTimer = win.setTimeout(() => {
        scanTimer = null
        scan()
      }, CONFIG.scanDebounceMs)
    }

    const rootObserver = typeof win.MutationObserver === 'function'
      ? new win.MutationObserver(scheduleScan)
      : null

    return {
      instances,
      scan,
      start() {
        if (disposed) return
        if (doc0.getElementById && !doc0.getElementById(CONFIG.styleId)) {
          styleEl = doc0.createElement('style')
          styleEl.id = CONFIG.styleId
          styleEl.textContent = CSS
          ;(doc0.head || doc0.documentElement).appendChild(styleEl)
        }
        const root = doc0.documentElement || doc0.body
        if (rootObserver && root) rootObserver.observe(root, { childList: true, subtree: true })
        scan()
      },
      dispose() {
        if (disposed) return
        disposed = true
        if (scanTimer !== null) win.clearTimeout(scanTimer)
        rootObserver && rootObserver.disconnect()
        for (const inst of instances.values()) inst.dispose()
        instances.clear()
        if (styleEl && styleEl.parentElement) styleEl.parentElement.removeChild(styleEl)
        styleEl = null
      },
    }
  }

  // ---------------------------------------------------------------------
  // Thin dsh glue — the only dsh/cordis-aware section of this file.
  // ---------------------------------------------------------------------

  function apply(ctx) {
    ctx.effect(() => {
      const manager = createMinimapManager({ document, window })
      manager.start()
      return () => manager.dispose()
    }, 'dsh-minimap')
  }

  const api = {
    name: 'dsh-minimap',
    inject: [],
    apply,
    _internals: {
      CONFIG,
      viewFromDOM,
      computeLineHeight,
      minimapWidthFor,
      reservedPadFor,
      scrollFraction,
      minimapOffsetFor,
      boxSpan,
      viewportBoxTop,
      visibleLineRange,
      scrollTopForMiniY,
      collectLineSegments,
      computeMetrics,
      boxHeightFor,
      createMinimapManager,
    },
  }

  if (typeof window !== 'undefined' && window.__ModuleLoader__ && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: 'dsh-minimap', factory: () => api })
  }
})()
