# dsh-minimap

为 dsh web GUI 的侧边文件查看器叠加 **VS Code 风格的文本缩略图（minimap）**：宽体文字缩略 + 可拖动的视口框，点击/拖动即可在长文件中快速定位。

A VS Code-style **minimap overlay** for the dsh web GUI's side file viewer: a wide text thumbnail with a draggable viewport box for fast navigation in long files.

## 功能 Features

- 在侧栏文件查看器（dsh-better-sidebar 的 CodeMirror 6 编辑器）右缘叠加文本缩略图，逐行绘制整篇文档的微型文字；宽度随编辑器容器自适应（约 22%，钳制在 56–110px），侧栏拖宽拖窄自动跟随
- 编辑器内容区右侧自动预留缩略图宽度加固定 5px 间隙的内边距（`padding-right`，编辑器自带的右侧留白会计入预留，可视间隙恰为 5px），长行文字不会被缩略图遮挡；卸载/编辑器移除后自动还原
- 半透明视口框实时跟随编辑器滚动；在缩略图上**点击跳转**（视口居中）或**按住拖动**（框内抓取保持相对位置）
- 缩略图上滚轮等效于滚动编辑器
- **语法着色**：滚动经过的行会从编辑器已渲染的 token 中捕获真实高亮色并缓存复用于缩略图；尚未到过的行回落为编辑器基础文字色；整体降低不透明度，自动适配明暗主题
- 比例映射以编辑器的**真实滚动范围**（含底部 padding）为基准，视口框拖到底即编辑器真正到底
- 超大文件自动等比压缩行高，canvas 按 devicePixelRatio 渲染保持清晰；仅绘制可视窗口行，滚动事件 rAF 节流
- 纯叠加层：不注册/替换任何 sidebar 组件，sidebar 感知不到本插件；sidebar 未安装或内部结构变化时静默不渲染，编辑器本体不受影响
- 多编辑器/多标签页各自独立挂载；关闭标签页或卸载插件后 canvas 与样式完全移除

A text thumbnail overlays the right edge of the side file viewer (the CodeMirror 6 editor from dsh-better-sidebar), rendering every document line as miniature text. Its width adapts to the editor container (~22%, clamped to 56–110 px) and follows sidebar resizes via ResizeObserver. The editor content area automatically reserves a right padding of the minimap's width plus a fixed 5 px gap (any right-side chrome the editor already has, e.g. the scroller's own padding, counts toward the reservation, so the visible gap lands at exactly 5 px), so long lines never run underneath the thumbnail; the padding is removed again when the editor or the plugin goes away. A translucent viewport box tracks editor scrolling; click the minimap to jump (viewport centers) or drag inside the box (grab keeps the relative position). Mouse wheel over the minimap scrolls the editor. **Syntax colors**: lines you have scrolled through are painted with the real highlight colors captured from the editor's rendered tokens and cached; lines never seen fall back to the editor's base text color; everything is drawn at reduced opacity to adapt to dark/light themes. The proportional mapping is anchored to the editor's **true scroll range** (bottom padding included), so dragging the viewport box to the minimap's bottom edge always reaches the real end of the document. Oversized documents scale the line height down uniformly; the canvas renders at devicePixelRatio and only paints the visible window, throttled by rAF. The plugin is a pure overlay — it registers and replaces nothing, the sidebar never knows it exists; without the sidebar (or if its internals change) the minimap silently stays away and the editor is never affected. Each editor/tab gets its own instance; closing a tab or uninstalling the plugin removes every canvas and the stylesheet.

## 安装 Install

方式一：从 **npm registry** 安装（推荐）：

```sh
dsh plugin --profile web add dsh-minimap
```

方式二：从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:ping1999/dsh-minimap
```

安装后**重启 web 服务**生效：

```sh
pnpm dsh web
```

## 使用 Usage

重启后打开任意会话，在右侧 Files 侧栏打开一个文本文件，编辑器右缘即出现缩略图：

- 滚动编辑器 → 缩略图视口框同步移动
- 点击缩略图任意位置 → 编辑器跳转到对应位置（视口居中）
- 按住视口框拖动 → 编辑器跟随滚动；滚轮悬停缩略图同样滚动

After the web server restarts, open any text file in the Files sidebar — the minimap appears at the editor's right edge. Scroll the editor and the viewport box follows; click anywhere on the minimap to jump (the viewport centers there), drag the box to scroll, or hover the minimap and use the wheel.

## 工作原理 How it works

持久化 bundle（`package.json` 的 `dsh.bundle.patch` → `cordis.patch.yml`），由 `dsh plugin add` 的 reconcile 自动加入 profile 的 `dsh.profile.bundles` 层：

- **Client 半**（`lib/client.js`）：通过 `exports["./client"]` + `dsh.client`（`immediately: true`，随 web 启动加载）声明。零 React、零 cordis 服务依赖（`inject: []`）。内部两段式分层：
  - **纯 DOM 核心**：`MutationObserver` 发现 `[data-dsh-better-sidebar]` 内的 `.cm-editor` 挂载/卸载，对每个编辑器在父容器右缘绝对定位一个 canvas。文档全文经 CM6 的 DOM 回链读取（与公开静态方法 `EditorView.findFromDOM` 同一条路径：`dom.cmTile` → 沿 `tile.parent` 到 root → `.view`，鸭式复制，不 import 任何 `@codemirror/*` 包——共享模块表里没有它们）。渲染用分数映射（editor scrollTop 与 minimap offset 共享同一滚动分数，以 `scroller.scrollHeight` 的真实滚动范围为分母，两端对齐），滚动/resize/内容变化各自经 rAF 或 debounce 触发重绘；编辑器尚未挂载完成时有界重试。语法着色受 CM6 虚拟化限制——DOM 里只有可视行的 token——因此采用"滚动捕获 + 按行缓存"的渐进着色：捕获以行文本校验，编辑后自动失效重捕
  - **薄 dsh 胶水**（约 30 行）：`__ModuleLoader__` 注册 + cordis `apply` 在 `ctx.effect` 里启动 manager，disposer 负责全量清理。将来若迁移到别的宿主/ABI（如 dsh-std 的 LocalModule），只需重写这段胶水
- **Host 半**（`lib/host.js`）：空实现——Node 侧 loader 以包根入口导入它（浏览器专属的 `lib/client.js` 必须只在 `./client` 导出下被 web 端加载），无网络请求、无持久化状态

## 要求与限制 Requirements and limitations

- 需要侧栏文件查看器由 CodeMirror 6 实现（当前即 dsh-better-sidebar 的文本查看器）；其它查看器（图片/PDF/Markdown）不出现缩略图
- 全文一次性语法着色**做不到**：CM6 只把可视行渲染进 DOM（虚拟化），而宿主共享模块表里没有 `@codemirror/language` 这类可离线高亮的包，因此着色是渐进式的——滚动经过的行才有颜色
- `cmTile` 是 CM6 的非公开字段（被公开方法 `EditorView.findFromDOM` 使用）：若未来 sidebar 升级导致该链失效，缩略图静默不渲染，编辑器功能不受影响
- 动态安装后需重启 web 服务生效（与所有 profile bundle 一致）
- v1 无设置项：几何参数（宽度比/上下限、固定 5px 间隙等）集中在 `lib/client.js` 顶部 `CONFIG`，宽度按编辑器容器宽度自适应计算

## License

MIT
