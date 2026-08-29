// Client tests for dsh-minimap: evaluate the bundle with a captured
// window.__ModuleLoader__ handoff, then drive the manager against a hand-rolled
// fake DOM (fake elements, fake canvas 2d context recording draw calls, fake
// MutationObserver/ResizeObserver/rAF). No browser required.
// Run: node --test tests/client.test.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { test } from 'node:test'

const SRC = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

// ---------------------------------------------------------------------
// Fake DOM primitives
// ---------------------------------------------------------------------

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.childNodes = []
    this.parentElement = null
    this.style = {}
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.listeners = {}
    this.attributes = {}
    this.clientWidth = 800
    this.clientHeight = 800
    this.scrollTop = 0
    this.scrollLeft = 0
    this.scrollHeight = 6000
    this.nodeType = 1
    const self = this
    this.classList = { contains: (c) => self.className.split(/\s+/).indexOf(c) !== -1 }
    this.style.setProperty = (k, v) => { self.style[k] = String(v) }
    this.style.removeProperty = (k) => { delete self.style[k] }
  }

  appendChild(child) {
    child.parentElement = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const i = this.children.indexOf(child)
    if (i !== -1) this.children.splice(i, 1)
    child.parentElement = null
    return child
  }

  remove() {
    if (this.parentElement) this.parentElement.removeChild(this)
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
  }

  removeAttribute(name) {
    delete this.attributes[name]
  }

  hasAttribute(name) {
    return name in this.attributes
  }

  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }

  removeEventListener(type, fn) {
    const l = this.listeners[type]
    if (!l) return
    const i = l.indexOf(fn)
    if (i !== -1) l.splice(i, 1)
  }

  fire(type, event) {
    for (const fn of this.listeners[type] || []) fn(event)
  }

  querySelector(sel) {
    return (this._qs && this._qs[sel]) || null
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, width: this.clientWidth, height: this.clientHeight }
  }
}

class FakeCanvas extends FakeElement {
  constructor() {
    super('canvas')
    this.width = 0
    this.height = 0
    this.ctx = {
      calls: { fillText: [], fillRect: [], strokeRect: [], clearRect: [], setTransform: [] },
      font: '', fillStyle: '', strokeStyle: '', globalAlpha: 1, textBaseline: '', lineWidth: 1,
      setTransform(...a) { this.calls.setTransform.push(a) },
      clearRect(...a) { this.calls.clearRect.push(a) },
      fillText(...a) { this.calls.fillText.push([...a, this.fillStyle]) },
      fillRect(...a) { this.calls.fillRect.push(a) },
      strokeRect(...a) { this.calls.strokeRect.push(a) },
    }
  }

  getContext(kind) {
    return kind === '2d' ? this.ctx : null
  }
}

class FakeMutationObserver {
  constructor(cb) { this.cb = cb; this.observing = [] }
  observe(target, opts) { this.observing.push([target, opts]) }
  disconnect() { this.observing = [] }
  trigger() { this.cb([], this) }
}

class FakeResizeObserver {
  constructor(cb) { this.cb = cb; this.observing = [] }
  observe(target) { this.observing.push(target) }
  disconnect() { this.observing = [] }
}

function makeFakeEnv() {
  const registry = { editors: [], styles: [] }
  const rafQueue = []
  const mutationObservers = []
  const resizeObservers = []

  const head = new FakeElement('head')
  const body = new FakeElement('body')
  const documentElement = new FakeElement('html')
  documentElement.appendChild(head)
  documentElement.appendChild(body)

  const fakeDocument = {
    head, body, documentElement,
    listeners: {},
    createElement: (tag) => (tag === 'canvas' ? new FakeCanvas() : new FakeElement(tag)),
    getElementById: (id) => registry.styles.find((s) => s.id === id) || null,
    querySelectorAll: (sel) => {
      if (sel.indexOf('.cm-editor') !== -1) return registry.editors.slice()
      return []
    },
    addEventListener(type, fn) { ;(this.listeners[type] ||= []).push(fn) },
    removeEventListener(type, fn) {
      const l = this.listeners[type]
      if (!l) return
      const i = l.indexOf(fn)
      if (i !== -1) l.splice(i, 1)
    },
    fire(type, event) { for (const fn of this.listeners[type] || []) fn(event) },
  }

  class TrackedMutationObserver extends FakeMutationObserver {
    constructor(cb) { super(cb); mutationObservers.push(this) }
  }
  class TrackedResizeObserver extends FakeResizeObserver {
    constructor(cb) { super(cb); resizeObservers.push(this) }
  }

  const fakeWindow = {
    devicePixelRatio: 2,
    MutationObserver: TrackedMutationObserver,
    ResizeObserver: TrackedResizeObserver,
    requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length },
    cancelAnimationFrame: () => {},
    setTimeout: (cb, ms) => setTimeout(cb, ms),
    clearTimeout: (id) => clearTimeout(id),
    getComputedStyle: (el) => ({
      position: (el.style && el.style.position) || 'static',
      color: el.color || 'rgb(200, 200, 200)',
    }),
  }

  return {
    registry,
    rafQueue,
    mutationObservers,
    resizeObservers,
    document: fakeDocument,
    window: fakeWindow,
    flushRaf() {
      const q = rafQueue.splice(0)
      for (const cb of q) cb()
    },
  }
}

// Build a fake CM6 editor: wrapper (.editorCm stand-in) > cmEditor with a
// cm-content carrying the cmTile chain to a root tile holding the fake view.
// scrollPadding simulates bottom padding (e.g. scrollPastEnd): the scroller
// can then scroll past view.contentHeight, and the minimap must still reach
// the real bottom.
function makeFakeEditor({
  lines = 1000, contentHeight = 6000, containerH = 800, clientH = 600,
  scrollPadding = 0, coloredFirstLine = false, containerW = 500, chromeRight = 0,
} = {}) {
  const wrapper = new FakeElement('div')
  wrapper.clientHeight = containerH
  wrapper.clientWidth = containerW
  const cmEditor = new FakeElement('div')
  const scroller = new FakeElement('div')
  scroller.clientHeight = clientH
  scroller.scrollHeight = contentHeight + scrollPadding
  const content = new FakeElement('div')
  cmEditor._qs = { '.cm-content': content, '.cm-scroller': scroller }
  // applySize measures the editor's own right-side chrome via rects.
  wrapper._qs = { '.cm-content': content }
  wrapper.getBoundingClientRect = () => ({ top: 0, left: 0, width: containerW, height: containerH, right: containerW })
  content.getBoundingClientRect = () => ({ top: 0, left: 0, width: containerW - chromeRight, height: containerH, right: containerW - chromeRight })

  const doc = {
    lines,
    line: (n) => ({ text: `  const value${n} = computeThing(${n})  ` }),
    lineAt: (pos) => {
      const number = pos + 1
      return { number, text: `  const value${number} = computeThing(${number})  ` }
    },
  }
  const view = {
    state: { doc },
    scrollDOM: scroller,
    contentHeight,
    posAtDOM: (el) => el._pos,
  }
  const rootTile = { parent: null, view }
  content.cmTile = { parent: rootTile }

  if (coloredFirstLine) {
    // A rendered .cm-line for document line 1 with token spans:
    // '  ' base, 'const' red, ' value1 = ' base, 'computeThing' green, '(1)  ' base.
    const lineEl = new FakeElement('div')
    lineEl.className = 'cm-line'
    lineEl._pos = 0
    const span = (color, text) => ({
      nodeType: 1, color, childNodes: [{ nodeType: 3, nodeValue: text }],
    })
    const text = (t) => ({ nodeType: 3, nodeValue: t })
    lineEl.childNodes = [
      text('  '),
      span('rgb(255, 0, 0)', 'const'),
      text(' value1 = '),
      span('rgb(0, 128, 0)', 'computeThing'),
      text('(1)  '),
    ]
    content.appendChild(lineEl)
  }

  wrapper.appendChild(cmEditor)
  return { wrapper, cmEditor, scroller, content, doc, view }
}

function loadBundle(env) {
  let captured = null
  const sandboxWindow = {
    __ModuleLoader__: { load: (spec) => { captured = spec } },
  }
  const fn = new Function('window', 'document', SRC)
  // The bundle only touches window.__ModuleLoader__ at scope; document/window
  // reach the core through the manager's env injection.
  fn(sandboxWindow, env.document)
  assert.ok(captured, 'bundle should register with __ModuleLoader__')
  return captured.factory()
}

function startManager(env) {
  patchedDocument(env)
  const api = loadBundle(env)
  assert.equal(api.name, 'dsh-minimap')
  assert.deepEqual(api.inject, [])
  assert.equal(typeof api.apply, 'function')

  let disposer = null
  const ctx = { effect: (setup) => { disposer = setup() } }
  api.apply(ctx)
  return { api, dispose: () => disposer && disposer() }
}

// ---------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------

test('bundle registers with ModuleLoader and exports cordis plugin shape', () => {
  const env = makeFakeEnv()
  const api = loadBundle(env)
  assert.equal(api.name, 'dsh-minimap')
  assert.deepEqual(api.inject, [])
  assert.equal(typeof api.apply, 'function')
  assert.ok(api._internals.createMinimapManager)
})

test('apply starts the manager, injects style, disposer removes it', () => {
  const env = makeFakeEnv()
  const { dispose } = startManager(env)
  assert.equal(env.registry.styles.length, 1)
  assert.equal(env.registry.styles[0].id, 'dsh-minimap-style')
  // The text-avoidance rule: reserve right-side room inside the editor content.
  assert.match(env.registry.styles[0].textContent, /\[data-dsh-minimap\] \.cm-content\{padding-right:var\(--dsh-minimap-pad,115px\) !important\}/)
  dispose()
  assert.equal(env.registry.styles[0].parentElement, null)
})

test('scan attaches a canvas to the editor wrapper and renders text + viewport box', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, doc } = makeFakeEditor()
  env.registry.editors.push(cmEditor)

  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()

  assert.equal(wrapper.style.position, 'relative')
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  assert.ok(canvas, 'canvas appended to wrapper')
  assert.ok(wrapper.hasAttribute('data-dsh-minimap'), 'text-avoidance attribute set')
  // Adaptive sizing: containerW 500 → width round(500*0.22)=110, pad 110+5=115.
  assert.equal(canvas.style.width, '110px')
  assert.equal(wrapper.style['--dsh-minimap-pad'], '115px')

  env.flushRaf()
  assert.ok(canvas.ctx.calls.fillText.length > 100, 'thumbnail lines drawn')
  assert.equal(canvas.ctx.calls.fillText[0][0], doc.line(1).text.trimEnd())
  assert.equal(canvas.ctx.calls.fillRect.length, 1, 'viewport box drawn')
  // Scroll untouched: box sits at top, container 800px tall, clientH 600,
  // ratio = 3000/6000 = 0.5 → box height 300.
  assert.deepEqual(canvas.ctx.calls.fillRect[0], [0, 0, 110, 300])
  // DPR transform applied.
  assert.deepEqual(canvas.ctx.calls.setTransform[0], [2, 0, 0, 2, 0, 0])
  assert.equal(canvas.width, 220)
  assert.equal(canvas.height, 1600)
  m.dispose()
})

test('scroll position drives minimap offset and viewport box (proportional mapping)', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  // Half-way: scrollTop 2700 of docScrollRange 5400 → frac 0.5; offset 1100 of
  // miniScrollRange 2200; box top = 0.5 * span(800 - 300) = 250.
  scroller.scrollTop = 2700
  scroller.fire('scroll')
  env.flushRaf()
  const boxes = canvas.ctx.calls.fillRect
  assert.deepEqual(boxes[boxes.length - 1], [0, 250, 110, 300])
  m.dispose()
})

test('pointerdown inside the box grabs it; pointermove drags the editor scroll', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  const preventDefault = () => {}
  // Box occupies mini-space [0, 300] at rest; grab at miniY=100.
  canvas.fire('pointerdown', { button: 0, clientY: 100, pointerId: 1, preventDefault })
  assert.equal(scroller.scrollTop, 0, 'grabbing inside box does not jump')
  assert.ok(env.document.listeners['pointermove'], 'drag listeners registered')
  assert.equal(env.document.body.style.userSelect, 'none')

  env.document.fire('pointermove', { clientY: 200, pointerId: 1 })
  // (200 - grab 100) / span 500 = frac 0.2 → 0.2 * docScrollRange 5400 = 1080.
  assert.equal(scroller.scrollTop, 1080)

  env.document.fire('pointerup', { pointerId: 1 })
  assert.equal(env.document.listeners['pointermove'].length, 0, 'drag listeners removed')
  assert.equal(env.document.body.style.userSelect, '')
  m.dispose()
})

test('drag tracks the pointer 1:1 in canvas space (no minimap-offset feedback)', () => {
  // Regression: the drag used to convert pointer y into minimap space by
  // adding the content offset — which is itself derived from scrollTop, so
  // every move fed the previous step's output back into the next input and
  // the box ran to the bottom before the pointer arrived.
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  // Grab inside the box at y=100, then move in +100px steps.
  canvas.fire('pointerdown', { button: 0, clientY: 100, pointerId: 1, preventDefault: () => {} })
  env.document.fire('pointermove', { clientY: 200, pointerId: 1 })
  assert.equal(scroller.scrollTop, 1080, 'first step: +100px → frac 0.2')
  // The first step scrolled the editor (1080/5400 → minimap offset 440).
  // With the buggy math the second identical step would clamp to max.
  env.document.fire('pointermove', { clientY: 300, pointerId: 1 })
  assert.equal(scroller.scrollTop, 2160, 'second step: another +100px → frac 0.4, not runaway')
  env.document.fire('pointerup', { pointerId: 1 })
  m.dispose()
})

test('minimap width and reserved padding adapt to the container width', () => {
  const env = makeFakeEnv()
  // Narrow sidebar (250px): width clamps to the 56px floor, gap is fixed 5px.
  const { wrapper, cmEditor } = makeFakeEditor({ containerW: 250 })
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  assert.equal(canvas.style.width, '56px', 'width clamped to the floor')
  assert.equal(wrapper.style['--dsh-minimap-pad'], '61px', 'pad = width + fixed gap')
  env.flushRaf()
  assert.equal(canvas.width, 112, 'canvas bitmap follows the adapted width (dpr 2)')
  m.dispose()

  const { minimapWidthFor, reservedPadFor } = api._internals
  assert.equal(minimapWidthFor(0), 56, 'unknown width → floor')
  assert.equal(minimapWidthFor(200), 56, 'floor clamps tiny editors')
  assert.equal(minimapWidthFor(500), 110)
  assert.equal(minimapWidthFor(1000), 110, 'ceiling clamps wide editors')
  assert.equal(reservedPadFor(56), 61, 'width floor + fixed gap')
  assert.equal(reservedPadFor(110), 115)
})

test('editor right-side chrome counts toward the reserved width', () => {
  const env = makeFakeEnv()
  // cm-scroller keeps its own 16px right padding: the visible gap would be
  // 16 + 5 without compensation, so .cm-content only gets what remains.
  const { wrapper, cmEditor } = makeFakeEditor({ containerW: 500, chromeRight: 16 })
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  assert.equal(canvas.style.width, '110px')
  assert.equal(wrapper.style['--dsh-minimap-pad'], '99px', 'pad = width + gap − chrome')
  m.dispose()
})

test('clicking outside the box jump-centers the viewport', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  canvas.fire('pointerdown', { button: 0, clientY: 500, pointerId: 1, preventDefault: () => {} })
  // Outside box (mini 500 > boxH 300): grab = 150 → frac (500-150)/500 = 0.7
  // → 0.7 * 5400 = 3780.
  assert.equal(scroller.scrollTop, 3780)
  env.document.fire('pointerup', { pointerId: 1 })
  m.dispose()
})

test('bottom padding: drag to minimap bottom reaches the editor real max scroll', () => {
  const env = makeFakeEnv()
  // 600px bottom padding: scroller can scroll to 6000 while contentHeight
  // alone would cap at 5400. The minimap must follow the scroller's truth.
  const { wrapper, cmEditor, scroller } = makeFakeEditor({ scrollPadding: 600 })
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  // Click at the very bottom edge of the canvas (jump-and-center past the
  // box): frac clamps to 1 → scrollTop = real max 6000, not 5400.
  canvas.fire('pointerdown', { button: 0, clientY: 800, pointerId: 1, preventDefault: () => {} })
  assert.equal(scroller.scrollTop, 6000, 'reaches the real bottom incl. padding')
  env.document.fire('pointerup', { pointerId: 1 })

  // And the box is glued to the canvas bottom edge at max scroll.
  scroller.fire('scroll')
  env.flushRaf()
  const boxes = canvas.ctx.calls.fillRect
  assert.deepEqual(boxes[boxes.length - 1], [0, 500, 110, 300])
  m.dispose()
})

test('touch drags work; a second finger can neither hijack nor cancel the drag', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  canvas.fire('pointerdown', { button: 0, clientY: 100, pointerId: 1, pointerType: 'touch', preventDefault: () => {} })
  canvas.fire('pointerdown', { button: 0, clientY: 700, pointerId: 2, pointerType: 'touch', preventDefault: () => {} })
  assert.equal(scroller.scrollTop, 0, 'second finger is ignored while a drag is active')

  env.document.fire('pointermove', { clientY: 500, pointerId: 2, pointerType: 'touch' })
  assert.equal(scroller.scrollTop, 0, 'second finger cannot move the drag')
  env.document.fire('pointermove', { clientY: 200, pointerId: 1, pointerType: 'touch' })
  assert.equal(scroller.scrollTop, 1080, 'the owning finger drags')

  env.document.fire('pointerup', { pointerId: 2, pointerType: 'touch' })
  assert.ok(env.document.listeners['pointermove'].length > 0, 'stray pointerup does not end the drag')
  env.document.fire('pointercancel', { pointerId: 1, pointerType: 'touch' })
  assert.equal(env.document.listeners['pointermove'].length, 0, 'pointercancel ends the drag')
  assert.equal(env.document.body.style.userSelect, '')
  m.dispose()
})

test('wheel over the minimap scrolls the editor; pinch zoom passes through', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, scroller } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  let prevented = 0
  const preventDefault = () => { prevented++ }
  canvas.fire('wheel', { deltaY: 120, deltaX: 0, deltaMode: 0, ctrlKey: false, preventDefault })
  assert.equal(scroller.scrollTop, 120, 'pixel deltas scroll 1:1')
  // Line-mode deltas (Firefox): scaled by the editor line height (6000/1000 = 6).
  canvas.fire('wheel', { deltaY: 3, deltaX: 0, deltaMode: 1, ctrlKey: false, preventDefault })
  assert.equal(scroller.scrollTop, 138, 'line deltas scale to pixels')
  canvas.fire('wheel', { deltaY: 0, deltaX: 30, deltaMode: 0, ctrlKey: false, preventDefault })
  assert.equal(scroller.scrollLeft, 30, 'horizontal deltas pan the scroller')
  canvas.fire('wheel', { deltaY: 100, deltaX: 0, deltaMode: 0, ctrlKey: true, preventDefault })
  assert.equal(scroller.scrollTop, 138, 'ctrl+wheel leaves the editor scroll untouched')
  assert.equal(prevented, 3, 'pinch-zoom gesture is not swallowed')
  m.dispose()
})

test('short document: viewport box covers exactly the thumbnail', () => {
  const env = makeFakeEnv()
  // 10 lines → 30px thumbnail, fully visible in the editor at once: the box
  // must clamp to the thumbnail instead of overflowing into empty canvas.
  const { wrapper, cmEditor } = makeFakeEditor({ lines: 10, contentHeight: 220 })
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()
  const boxes = canvas.ctx.calls.fillRect
  assert.deepEqual(boxes[boxes.length - 1], [0, 0, 110, 30], 'box height clamps to the thumbnail')
  m.dispose()
})

test('syntax colors captured from rendered lines color the thumbnail', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor } = makeFakeEditor({ coloredFirstLine: true })
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()

  // First render captures colors before drawing, so line 1 (y=0) is drawn as
  // colored segments (no measureText in the fake → charW = 1 → x = column).
  const line1 = canvas.ctx.calls.fillText.filter((c) => c[2] === 0)
  assert.deepEqual(line1, [
    ['const', 2, 0, 'rgb(255, 0, 0)'],
    [' value1 =', 7, 0, 'rgb(200, 200, 200)'],
    ['computeThing', 17, 0, 'rgb(0, 128, 0)'],
    ['(1)', 29, 0, 'rgb(200, 200, 200)'],
  ])
  // Line 2 has no captured DOM → drawn whole in the base color.
  const line2 = canvas.ctx.calls.fillText.filter((c) => c[2] === 3)
  assert.deepEqual(line2, [['  const value2 = computeThing(2)'.trimEnd(), 0, 3, 'rgb(200, 200, 200)']])
  m.dispose()
})

test('editor removal detaches instance: canvas removed, wrapper restored', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor } = makeFakeEditor()
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  env.flushRaf()
  assert.equal(wrapper.children.some((c) => c.className === 'dsh-minimap'), true)

  env.registry.editors.length = 0
  m.scan()
  assert.equal(wrapper.children.some((c) => c.className === 'dsh-minimap'), false)
  assert.equal(wrapper.style.position, '')
  assert.equal(wrapper.hasAttribute('data-dsh-minimap'), false, 'text-avoidance attribute removed')
  assert.equal(wrapper.style['--dsh-minimap-pad'], undefined, 'reserved-padding var removed')
  assert.equal(m.instances.size, 0)
  m.dispose()
})

test('editor without a reachable CM view renders nothing and stays inert', () => {
  const env = makeFakeEnv()
  const { wrapper, cmEditor, content } = makeFakeEditor()
  delete content.cmTile
  env.registry.editors.push(cmEditor)
  const api = loadBundle(env)
  const m = api._internals.createMinimapManager({ document: patchedDocument(env), window: env.window })
  m.start()
  const canvas = wrapper.children.find((c) => c.className === 'dsh-minimap')
  env.flushRaf()
  assert.equal(canvas.ctx.calls.fillText.length, 0)
  assert.equal(canvas.ctx.calls.fillRect.length, 0)
  m.dispose()
})

test('pure mapping helpers behave at boundaries', () => {
  const env = makeFakeEnv()
  const {
    computeLineHeight, minimapOffsetFor, visibleLineRange, scrollTopForMiniY,
    boxSpan, viewportBoxTop, scrollFraction, boxHeightFor,
  } = loadBundle(env)._internals

  assert.equal(computeLineHeight(100, 800), 3)
  assert.equal(computeLineHeight(100000, 800), (800 * 8) / 100000, 'huge docs scale down')

  assert.equal(scrollFraction(0, 5400), 0)
  assert.equal(scrollFraction(5400, 5400), 1)
  assert.equal(scrollFraction(99999, 5400), 1, 'clamped past bottom')
  assert.equal(scrollFraction(100, 0), 0, 'no scroll range → 0')

  assert.equal(minimapOffsetFor(0, 5400, 2200), 0)
  assert.equal(minimapOffsetFor(5400, 5400, 2200), 2200)
  assert.equal(minimapOffsetFor(99999, 5400, 2200), 2200, 'clamped at bottom')
  assert.equal(minimapOffsetFor(100, 0, 2200), 0, 'no scroll range → no offset')

  assert.equal(boxSpan(800, 3000, 300), 500)
  assert.equal(boxSpan(800, 250, 300), 0, 'box taller than a short minimap → no travel')

  assert.equal(boxHeightFor({ containerH: 800, totalMiniH: 3000, clientH: 600, ratio: 0.5 }), 300)
  assert.equal(boxHeightFor({ containerH: 800, totalMiniH: 30, clientH: 600, ratio: 30 / 220 }), 30, 'short doc: box capped at the thumbnail')
  assert.equal(boxHeightFor({ containerH: 800, totalMiniH: 3000, clientH: 10, ratio: 0.5 }), 8, 'grabbability floor')

  assert.equal(viewportBoxTop(0, 5400, 800, 3000, 300), 0)
  assert.equal(viewportBoxTop(2700, 5400, 800, 3000, 300), 250)
  assert.equal(viewportBoxTop(5400, 5400, 800, 3000, 300), 500, 'box bottom glues to canvas bottom')
  assert.equal(viewportBoxTop(99999, 5400, 800, 3000, 300), 500, 'clamped past bottom')

  assert.deepEqual(visibleLineRange(0, 800, 3, 1000), { from: 1, to: 267 })
  assert.deepEqual(visibleLineRange(2999, 800, 3, 1000), { from: 1000, to: 1000 }, 'clamped at doc end')

  assert.equal(scrollTopForMiniY(100, 150, 500, 5400), 0, 'negative fractions clamp to 0')
  assert.equal(scrollTopForMiniY(500, 150, 500, 5400), 3780)
  assert.equal(scrollTopForMiniY(1e9, 150, 500, 5400), 5400, 'past-end fractions clamp to range')
  assert.equal(scrollTopForMiniY(500, 150, 0, 5400), 0, 'zero span is safe')
  assert.equal(scrollTopForMiniY(500, 150, 500, 0), 0, 'zero scroll range is safe')
})

test('collectLineSegments merges adjacent same-color runs', () => {
  const env = makeFakeEnv()
  const { collectLineSegments } = loadBundle(env)._internals
  const text = (t) => ({ nodeType: 3, nodeValue: t })
  const span = (color, ...kids) => ({ nodeType: 1, color, childNodes: kids })
  const line = {
    nodeType: 1,
    childNodes: [
      text('ab'),
      span('red', text('cd')),
      span('red', text('ef')),
      span('blue', text('g'), span('blue', text('h'))),
      span('blue', text('i')),
    ],
  }
  const segs = collectLineSegments(line, 'base', (el) => ({ color: el.color }))
  assert.deepEqual(segs, [
    { from: 0, color: 'base' },
    { from: 2, color: 'red' },
    { from: 6, color: 'blue' },
  ])
})

// The manager's style injection goes through document.getElementById +
// head.appendChild against the fake; patch a registry-aware createElement so
// <style> elements land in the styles list (mirrors browser behavior).
function patchedDocument(env) {
  const doc = env.document
  const origCreate = doc.createElement.bind(doc)
  doc.createElement = (tag) => {
    const el = origCreate(tag)
    if (tag === 'style') env.registry.styles.push(el)
    return el
  }
  return doc
}

console.log('client harness loaded')
