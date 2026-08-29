# AGENTS.md — dsh-minimap 开发参考

给在本仓库上工作的 AI agent（和人）的技术参考。面向用户的文档在 README.md（中英双语，中文在前）——README 不写内部实现，技术细节集中放在这里。

## 这是什么

dsh web GUI 插件：给侧边文件查看器（dsh-better-sidebar 内的 CodeMirror 6 编辑器）叠加 VS Code 风格的 minimap（文字缩略图 + 可拖动视口框）。以 `dsh-minimap` 发布到 npm，源码在 github.com/ping1999/dsh-minimap。

## 仓库结构

- `lib/client.js` — 浏览器端全部逻辑（约 670 行、零依赖 IIFE）。所有行为都在这里。
- `lib/host.js` — Node 侧入口（`main`）。**故意的空实现，且必须保持 Node-safe**（模块作用域不得碰 window/document），因为 Node 侧 loader 会以包根入口导入它。
- `cordis.patch.yml` — bundle patch，把插件挂进 web profile（`dsh plugin add` 的 reconcile 自动合并进 profile 的 `dsh.profile.bundles` 层）。
- `tests/client.test.mjs` — node:test 测试，自带 fake-editor 线束（19 个用例）。`tests/host.test.mjs` — host 冒烟测试。
- `package.json` — `exports`：`"."` → host，`"./client"` → client（浏览器专属代码只能走 `./client`）。`dsh.bundle.patch` 声明 bundle；`dsh.client { platform: "web", immediately: true }` 声明随 web 启动即加载。`files` 白名单控制 npm 发布内容（本文件与 tests 不发布）。

## 架构

两个半身，走两条加载通道：

- **Host 半**（`lib/host.js`）：no-op，存在仅因 Node 侧插件 loader 要导入包根。
- **Client 半**（`lib/client.js`）：经 `./client` 导出由 web 端加载，通过 `window.__ModuleLoader__.load({ id: 'dsh-minimap', ... })` 自注册，暴露 cordis `apply`，在 `ctx.effect` 里启动 manager，disposer 负责全量清理。末尾导出 `_internals`（CONFIG 与各纯函数）供测试直接取用。

client 文件刻意分两层：

1. **纯 DOM 核心**（`createMinimapManager` 及辅助函数）——零 dsh/cordis 引用，所有浏览器原语经 `env` 注入，可原样迁移到任何宿主/模块 ABI。
2. **薄胶水**（文件底部约 30 行）——ModuleLoader 注册 + cordis 接线。换宿主（如 dsh-std 的 LocalModule）只需重写这段。

零 React、零 cordis 服务依赖（`inject: []`），目前整体零运行时依赖，保持这样，除非有充分理由。

## 核心机制（从 README 剥离的技术细节）

### 读文档：CM6 DOM 回链

经 CM6 的 DOM 回链读编辑器文档——与公开静态方法 `EditorView.findFromDOM` 同一条路径：`dom.cmTile` → 沿 `tile.parent` 走到 root tile → 读 `.view`。`viewFromDOM` 是鸭式复制，**不 import 任何 `@codemirror/*` 包**（宿主共享模块表里没有它们）。`cmTile` 是非公开字段：若未来 sidebar/CM 升级使该链失效，`viewFromDOM` 返回 null，缩略图静默不渲染，编辑器不受影响。**访问 CM 内部结构必须做防御并静默失败。**

### 滚动映射：共享分数

编辑器与 minimap 共享同一滚动分数：`frac = scrollTop / docScrollRange`，其中 `docScrollRange = scroller.scrollHeight - clientHeight`（**真实**滚动范围，含底部 padding 与 CM 的实时高度重估）。minimap 位移 = `frac * miniScrollRange`，点击/拖动走逆运算。两端精确对齐：视口框拖到 minimap 底缘即编辑器真实最大 scrollTop。相关函数：`minimapOffsetFor` / `scrollTopForMiniY` / `computeMetrics`。

### 输入：Pointer Events + 滚轮转发

拖动/点击走 Pointer Events（鼠标、触屏、手写笔统一一条路径），以 `pointerId` 绑定当次拖动——第二根手指既不能移动也不能取消它；`pointercancel` 与 `pointerup` 同等收尾。wheel 事件手动转发给 scroller：`deltaMode` 行/页先换算成像素，`deltaX` 横向滚动同样转发，`ctrl+wheel`（捏合缩放）不拦截。

### 几何：宽度自适应 + 固定 5px 间隙

- 宽度 = `容器宽 * widthRatio(0.22)`，钳制在 `[widthMin 56, widthMax 110]` CSS px，ResizeObserver 跟随侧栏拖宽拖窄。
- 编辑器内容区经 `padding-right` 预留「宽度 + gap(5px)」（内联样式 + `--dsh-minimap-pad` CSS 变量，回退值 115px）。
- **chrome 抵扣**：编辑器自带的右侧留白计入预留。`.cm-scroller` 自带 16px 右 padding（`box-sizing: content-box`）；`applySize` 用 `getBoundingClientRect` 量出后按 `pad = max(0, width + gap - chromeRight)` 应用，使**可视间隙恰为 5px**。不要回退这个行为——有专门测试守着（'editor right-side chrome counts toward the reserved width'）。
- 几何参数全部集中在 `lib/client.js` 顶部 `CONFIG`，只改那里。

### 渲染

canvas 按 devicePixelRatio 渲染；只绘制可视窗口内的行（`visibleLineRange`）；滚动驱动的重绘经 rAF 节流，编辑器发现/内容变化/颜色捕获各自 debounce（`scanDebounceMs` / `contentDebounceMs` / `colorCaptureDebounceMs`）。超大文件由 `computeLineHeight` 等比压缩行高，把总 canvas 高度限制在 `containerH * maxCanvasFactor(8)` 以内。编辑器未挂载完成时 `computeMetrics` 返回 null 跳过该帧，并有有界重试。

### 渐进式语法着色

全文一次性着色**做不到**：CM6 虚拟化 DOM（只有可视行存在 token 元素），宿主也没有可离线高亮的共享包。策略是从编辑器已渲染的 DOM 按行捕获颜色段，缓存以行号为键、**以行文本校验**（编辑后自动失效重捕），条目数上限 `colorCacheMax(4000)`、按插入序 FIFO 淘汰；有缓存的行画真实高亮色，其余回落为编辑器基础文字色；整体以 `textAlpha 0.55` 绘制以适配明暗主题。

### 叠加纯净性与生命周期

不注册/替换 sidebar 的任何组件：`MutationObserver` 监听 `[data-dsh-better-sidebar] .cm-editor` 的挂载，每个编辑器实例在其容器右缘绝对定位一个 canvas 并施加预留 padding。sidebar 未安装或 DOM 结构变化时静默不渲染、不产生副作用。编辑器卸载/标签页关闭/插件卸载时 canvas、padding 与样式表完全移除。多编辑器/多标签页各自独立实例。

## 测试

- `npm test` → `node --test tests/*.test.mjs`，Node `^22.19 || >=24`。
- client 测试用真实 `createMinimapManager` 跑 fake-editor 线束（假 scroller/content、`getBoundingClientRect`、cmTile 回链）。改几何或滚动映射时**扩展线束，不要把 manager mock 掉**。
- 人工验证：本地起 web 服务后用 Playwright 实测——覆盖多档侧栏宽度下的宽度/间隙、拖到底的精确性、console 无新增报错。

## 本机开发流程

- 插件以 link 方式装进 `~/.dsh/profiles/web`：改 `lib/client.js` 后刷新页面即生效；改 `cordis.patch.yml` / host 半 / package.json 的 dsh 字段需重启 web 服务。
- 本机惯用端口 13080（服务如未运行：`dsh web --port 13080`）。
- `~/.dsh/profiles/web/pnpm-workspace.yaml` 里有一组临时 `minimumReleaseAgeExclude` 豁免条目，待上游修复后清理——不要当成仓库内容提交。

## 约定

- Commit message：英文、无 conventional-commits 前缀（与同级 dsh-model-picker 等仓库一致）。
- README.md 中英两版、**中文在前 English 在后**、各自成节——改行为时两半同步更新；内部细节只写进本文件。
- 每次行为变更在 package.json 里 bump `version`，并在同一提交内同步 README/AGENTS.md。
- `lib/host.js` 保持 Node-safe 与空实现；浏览器专属代码只允许出现在 `./client` 导出下。
