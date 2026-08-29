# dsh-minimap

为 dsh web GUI 的侧边文件查看器加一条 VS Code 风格的**缩略图滚动条（minimap）**：宽体文字缩略 + 可拖动的视口框，在长文件中快速定位。

A VS Code-style **minimap** for the dsh web GUI's side file viewer: a wide text thumbnail with a draggable viewport box for fast navigation in long files.

[中文](#中文) · [English](#english)

---

## 中文

### 功能

- 在 Files 侧栏文本编辑器的右缘叠加整篇文档的微型文字缩略图
- 半透明视口框实时跟随滚动：点击跳转、按住拖动、悬停滚轮均可定位
- 语法着色：滚动经过的行会带上与编辑器一致的高亮色，自动适配明暗主题
- 宽度随侧栏自适应（约为编辑器宽度的 22%，钳制在 56–110px）；编辑器内容区自动预留「缩略图宽度 + 5px」的间隙，长行文字不会被遮挡
- 拖到底即真正到底：比例映射以编辑器的真实滚动范围为基准
- 纯叠加层：不改动侧栏任何组件，侧栏未启用时静默不渲染；多标签页各自独立，关闭标签页或卸载插件后完全清理

### 安装

从 npm 安装（推荐）：

```sh
dsh plugin --profile web add dsh-minimap
```

或从 GitHub 源码安装：

```sh
dsh plugin --profile web add github:ping1999/dsh-minimap
```

安装后**重启 web 服务**生效：

```sh
pnpm dsh web
```

### 使用

打开任意会话，在右侧 Files 侧栏打开一个文本文件，编辑器右缘即出现缩略图：

- 滚动编辑器 → 缩略图视口框同步移动
- 点击缩略图任意位置 → 编辑器跳转到对应位置（视口居中）
- 按住视口框拖动 → 编辑器跟随滚动
- 悬停缩略图滚轮 → 等效于滚动编辑器

### 限制

- 仅对 CodeMirror 6 文本查看器生效（当前即 dsh-better-sidebar 的文件查看器）；图片 / PDF / Markdown 预览不会出现缩略图
- 语法着色是渐进式的：CM6 只渲染可视行，行滚入视野至少一次后才有颜色
- 安装 / 升级后需重启 web 服务（与所有 profile bundle 一致）
- 暂无设置项

---

## English

### Features

- Overlays a miniature text thumbnail of the whole document on the right edge of the Files sidebar's text editor
- A translucent viewport box tracks scrolling live — click to jump, drag to scroll, or hover and use the wheel
- Syntax colors: lines pick up the editor's real highlight colors once scrolled into view, adapting to dark/light themes
- Width adapts to the sidebar (~22% of the editor width, clamped to 56–110 px); the editor reserves the thumbnail's width plus a fixed 5 px gap, so long lines are never covered
- Dragging the box to the bottom reaches the true end of the document — the mapping is anchored to the editor's real scroll range
- Pure overlay: the sidebar is never modified or even aware of the plugin; each tab gets its own instance, and closing a tab or uninstalling removes everything

### Install

From npm (recommended):

```sh
dsh plugin --profile web add dsh-minimap
```

Or from GitHub source:

```sh
dsh plugin --profile web add github:ping1999/dsh-minimap
```

**Restart the web server** to take effect:

```sh
pnpm dsh web
```

### Usage

Open any session, open a text file in the Files sidebar, and the minimap appears at the editor's right edge:

- Scroll the editor → the viewport box follows
- Click anywhere on the minimap → jump there (the viewport centers)
- Drag the viewport box → the editor scrolls along
- Hover the minimap and use the wheel → same as scrolling the editor

### Limitations

- Only works with the CodeMirror 6 text viewer (currently dsh-better-sidebar's file viewer); image / PDF / Markdown previews get no minimap
- Syntax coloring is progressive: CM6 renders only visible lines, so a line gets its colors after being scrolled into view at least once
- A web-server restart is required after install/upgrade (same as every profile bundle)
- No settings yet

---

## 内部实现 · Internals

架构与实现细节（滚动映射、着色策略、几何参数、测试与开发流程）见 [AGENTS.md](./AGENTS.md)。

Architecture and implementation details (scroll mapping, coloring strategy, geometry, testing and dev workflow) live in [AGENTS.md](./AGENTS.md).

## License

MIT
