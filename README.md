# MarkForge

**把 Markdown 写成可以直接交付的文档。**

Windows 桌面 Markdown 编辑器与阅读器：实时预览、Mermaid / PlantUML / KaTeX、可折叠思维导图，一键导出 Word / PDF / 单文件 HTML，并提供无界面 CLI 与 tag 触发的自动发布。

**English** · [Jump to English](#english)

---

## 中文

### 功能

**渲染**

- **Markdown / GFM**：表格、任务列表、脚注、定义列表、删除线、上下标（`H~2~O`、`x^2^`）、缩写、高亮（`==文字==`）、下划线（`++文字++`）、emoji
- **KaTeX 公式**：行内 `$…$` / `\(…\)`，块级 `$$…$$` / `\[…\]`，支持矩阵、分段函数、多行对齐
- **Mermaid**（本地渲染，离线可用）：流程图、时序图、类图、状态图、ER 图、甘特图、饼图、Git 图、时间线
- **思维导图**：自研 SVG 渲染器。可折叠、层级配色、空白拖动平移、`Ctrl + 滚轮` 缩放（右上角也有缩放按钮），宽图自动适配预览宽度
- **PlantUML**：默认走远程服务，也可配置本地 Java + `plantuml.jar` 离线渲染
- **代码高亮**：highlight.js，内置多套主题
- **目录 / 提示框**：`[TOC]`、`> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
- 标题锚点、外链点击、本地图片路径解析（相对路径 / Windows 绝对路径）

**编辑**

- CodeMirror 6：语法高亮、行号、代码折叠、多光标、查找替换（支持正则）
- 工具栏 + 菜单：标题、加粗斜体、列表、引用、代码块、表格、链接图片、公式、图表、目录、分页符
- 编辑 / 预览 / 分栏三种模式，分栏宽度可拖动
- 双向滚动同步、大纲侧栏、任务列表复选框回写源码
- 浅色 / 深色主题、缩放、拼写检查、草稿自动保存

**导出**

| 目标 | 说明 |
| --- | --- |
| **HTML** | 单文件自包含：CSS 内联、KaTeX 字体 base64、图表内联 SVG、本地图片转 base64，离线可看 |
| **PDF** | Chromium 打印引擎；纸张（A4/A3/A5/Letter/Legal/Tabloid）、页边距、横向、页码、背景色 |
| **Word (.docx)** | 标题 / 列表 / 表格 / 引用 / 代码块 / 脚注为原生结构；公式与图表栅格化后以图片嵌入 |
| **打印** | `Ctrl+P` 打印预览，菜单「一键打印」直接交给系统打印机 |

### 环境要求

- Windows 10 / 11（x64）
- Node.js ≥ 18（开发与打包）
- 可选：Java 8+（本地渲染 PlantUML 时需要，不装则用远程服务）

### 快速开始

```bash
npm install
npm start        # 构建三方资源 + 打包前端 + 启动
```

资源未变动时，后续直接 `npm run dev`。

国内网络已在 `.npmrc` 中配好 npmmirror 镜像，无需额外设置。

### 命令行导出

不开界面，直接把 Markdown 导出成 HTML / PDF / Word（公式、图表、思维导图都会真实渲染）：

```bash
# 开发态
npm run cli -- report.md --to pdf
npm run cli -- report.md --to pdf,docx,html -o dist/

# 打包后
MarkForge.exe --export report.md --to pdf,docx -o dist/
```

| 选项 | 说明 |
| --- | --- |
| `--to, --format <列表>` | `html` / `pdf` / `docx`，逗号分隔，默认 `html` |
| `-o, --out <路径>` | 输出文件；多格式时视为目录 |
| `--page <尺寸>` | PDF 纸张：A4 / A3 / A5 / Letter / Legal / Tabloid |
| `--margin <mm>` | PDF 页边距，默认 18 |
| `--landscape` | PDF 横向 |
| `--no-header-footer` | PDF 不显示页眉页脚 |

不带 `-o` 时输出到源文件同目录。退出码：0 成功、1 导出失败、2 参数错误。

### 打包

```bash
npm run pack   # 只生成 release/win-unpacked
npm run dist   # 安装包 + 免安装单文件 exe
```

产物输出到 `release/`：

- `MarkForge Setup x.y.z.exe`（NSIS 安装包，可自选安装目录、创建快捷方式）
- `MarkForge-x.y.z-portable.exe`（免安装版）

两点默认行为：

- **复用本地 Electron**：`build.electronDist` 指向 `node_modules/electron/dist`，不联网下载 100 MB 发行包。
- **不打包 node_modules**：主进程与渲染层已由 esbuild 打成自包含的 `dist/main.js` / `dist/renderer.js`，asar 约 11 MB。

> 若 `npm run dist` 报 `EBUSY ... app.asar`：旧产物正被扫描器或上一个进程持有，延迟无效。`scripts/dist.js` 会依次尝试重试删除 → 改名搁置 → 换到 `release/build-<时间戳>/` 输出。

### 发布与 tag

Git tag 本身不携带文件，安装包通过 **Release 附件** 提供（二进制不进仓库历史）。

推送 `v*` tag 会触发 [.github/workflows/release.yml](.github/workflows/release.yml)：在 `windows-latest` 上 `npm ci` → 同步版本号 → `npm run dist` → 上传两个 exe 到同名 Release。

```bash
git tag -a v1.0.0 -m "MarkForge 1.0.0"
git push origin main --tags
```

本地已打好包、想手动上传：

```bash
gh release create v1.0.0 "release/MarkForge Setup 1.0.0.exe" "release/MarkForge-1.0.0-portable.exe" \
  --title "MarkForge 1.0.0" --notes "更新说明"
```

### 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl+N` / `Ctrl+O` / `Ctrl+S` / `Ctrl+Shift+S` | 新建 / 打开 / 保存 / 另存为 |
| `Ctrl+Shift+W` / `Ctrl+Shift+E` / `Ctrl+Shift+H` | 导出 Word / PDF / HTML |
| `Ctrl+P` / `Ctrl+Alt+P` | 打印预览 / 一键打印 |
| `Ctrl+F` | 查找替换 |
| `Ctrl+B` / `Ctrl+I` | 加粗 / 斜体 |
| `Ctrl+1..3` / `Ctrl+0` | 标题 1–3 / 正文 |
| `Ctrl+T` | 插入表格 |
| `Ctrl+K` / `Ctrl+Shift+I` | 插入链接 / 图片 |
| `Ctrl+M` / `Ctrl+Shift+M` | 插入行内公式 / 块级公式 |
| `Ctrl+Alt+1 / 2 / 3` | 编辑+预览 / 仅编辑 / 仅预览 |
| `Ctrl+Shift+O` | 显示 / 隐藏大纲 |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+Shift+0` | 放大 / 缩小 / 实际大小 |
| `Ctrl+,` | 设置 |

### 项目结构

```
markforge/
├─ src/
│  ├─ main/                    # 主进程：窗口、菜单、IPC、CLI
│  │  ├─ main.js
│  │  ├─ paths.js              # 资源路径解析
│  │  ├─ store.js              # 设置持久化
│  │  ├─ plantuml.js           # 本地 Java / 远程服务渲染 PlantUML
│  │  └─ exporter/
│  │     ├─ assets.js          # 单文件 HTML 组装、CSS/字体/图片内联
│  │     ├─ print.js           # PDF 导出、打印预览、直接打印
│  │     └─ docx.js            # Markdown token 树 → DOCX
│  ├─ preload/preload.js       # contextBridge 安全桥
│  └─ renderer/                # 渲染进程
│     ├─ index.html
│     ├─ styles/               # app.css / preview.css / print.css
│     └─ js/
│        ├─ app.js
│        ├─ editor.js
│        ├─ util.js
│        └─ render/
│           ├─ markdown.js     # markdown-it 管线 + 公式抽取
│           ├─ diagrams.js     # Mermaid / PlantUML
│           ├─ mindmap.js      # 可折叠思维导图（纯 SVG）
│           └─ raster.js       # SVG / HTML → PNG（导出 Word 用）
├─ scripts/                    # vendor / bundle / make-icon / dist
├─ test/                       # 离线测试与冒烟测试
└─ .github/workflows/          # tag 触发的自动打包发布
```

### 实现要点

**公式不被 Markdown 吞掉。** 交给 markdown-it 之前先按字符扫描全文，把公式抽成 `\uE000M0\uE001` 占位符（跳过围栏代码块与行内代码），渲染后按索引还原成 KaTeX HTML。

**Word 里的公式是真图片。** 渲染进程把 KaTeX DOM 经 `<svg><foreignObject>` + Canvas 栅格化成 PNG（字体与 CSS 构建期内联），Mermaid / PlantUML / 思维导图由 SVG 转 PNG，主进程再用 `docx` 生成 `.docx` 并内嵌。

**PDF、打印、HTML 共用同一条路径。** 渲染进程把预览 DOM 交给主进程，按需内联 CSS / 字体 / 图片拼成单文件 HTML，再交给 `printToPDF` 或打印窗口，四种输出天然一致。

**滚动同步靠 `data-line`。** markdown-it 的 core ruler 给块级 token 打源码行号，渲染成 `data-line`；编辑器滚动时二分查找最近的锚点元素对齐。

### 已知限制

- Word 导出中公式与图表以图片嵌入（非 Word 原生 OMML），放大后会略微失真；正文、表格、列表是原生结构。
- Word 导出暂不支持远程（`http(s)`）图片，本地图片与 `data:` 图片正常。
- PlantUML 默认使用公共远程服务，需联网且不宜渲染敏感内容；建议配置本地 jar。
- 单实例运行；通过文件关联打开第二个文件时会转交给已运行窗口。

### 许可

MIT

---

## English

**Write Markdown that ships as a finished document.**

A Windows desktop Markdown editor and reader with live preview, Mermaid / PlantUML / KaTeX, collapsible mind maps, and pixel-perfect export to Word, PDF, and self-contained HTML — plus a headless CLI and tag-triggered releases.

### Features

**Rendering**

- **Markdown / GFM**: tables, task lists, footnotes, definition lists, strikethrough, sub/superscript, abbreviations, highlight, underline, emoji
- **KaTeX**: inline `$…$` or `\(…\)`, block `$$…$$` or `\[…\]`; matrices, cases, aligned environments
- **Mermaid** (rendered locally, works offline): flowchart, sequence, class, state, ER, gantt, pie, git graph, timeline
- **Mind map**: custom SVG renderer with collapsible branches, per-branch colors, drag-to-pan on empty space, `Ctrl + wheel` zoom (plus on-canvas zoom buttons), and width fitting to the preview pane
- **PlantUML**: remote service by default, or local Java + `plantuml.jar` for offline rendering
- **Syntax highlighting** via highlight.js with multiple themes
- **TOC and alerts**: `[TOC]`, `> [!NOTE]` / `[!TIP]` / `[!IMPORTANT]` / `[!WARNING]` / `[!CAUTION]`
- Heading anchors, external links, local image resolution (relative or absolute Windows paths)

**Editing**

- CodeMirror 6: syntax highlighting, line numbers, code folding, multi-cursor, regex search & replace
- Toolbar and menus for headings, emphasis, lists, quotes, code blocks, tables, links/images, math, diagrams, TOC, page breaks
- Editor / preview / split modes with a draggable divider
- Bidirectional scroll sync, outline sidebar, task checkbox write-back to source
- Light and dark themes, zoom, spellcheck, autosaved drafts

**Export**

| Target | Details |
| --- | --- |
| **HTML** | Single self-contained file: inlined CSS, base64 KaTeX fonts, inline diagram SVGs, base64 local images — readable offline |
| **PDF** | Chromium print engine; paper size, margins, landscape, page numbers, background colors |
| **Word (.docx)** | Native headings, lists, tables, quotes, code blocks, footnotes; math and diagrams rasterized to embedded images |
| **Print** | `Ctrl+P` print preview, or one-click print from the menu |

### Requirements

- Windows 10 / 11 (x64)
- Node.js ≥ 18 for development and packaging
- Optional: Java 8+ for local PlantUML rendering

### Quick start

```bash
npm install
npm start        # build vendor assets + bundle + launch
```

Use `npm run dev` afterwards as long as assets are unchanged.

### CLI export

```bash
npm run cli -- report.md --to pdf
npm run cli -- report.md --to pdf,docx,html -o dist/
# packaged
MarkForge.exe --export report.md --to pdf,docx -o dist/
```

| Option | Description |
| --- | --- |
| `--to, --format <list>` | `html` / `pdf` / `docx`, comma separated, default `html` |
| `-o, --out <path>` | Output file; treated as a directory for multiple formats |
| `--page <size>` | A4 / A3 / A5 / Letter / Legal / Tabloid |
| `--margin <mm>` | PDF margin, default 18 |
| `--landscape` | Landscape PDF |
| `--no-header-footer` | Hide PDF header/footer |

Without `-o`, files are written next to the source. Exit codes: 0 success, 1 export failure, 2 invalid arguments.

### Building

```bash
npm run pack   # unpacked directory only
npm run dist   # NSIS installer + portable exe
```

Artifacts land in `release/`:

- `MarkForge Setup x.y.z.exe` — NSIS installer, custom install path, shortcuts
- `MarkForge-x.y.z-portable.exe` — portable single file

Electron is reused from `node_modules/electron/dist` (`build.electronDist`), and `node_modules` is excluded from the package because everything is prebundled by esbuild — the asar is ~11 MB.

### Releases

Git tags do not carry files; installers are attached as Release assets. Pushing a `v*` tag runs [.github/workflows/release.yml](.github/workflows/release.yml), which builds on `windows-latest` and uploads both executables to the matching Release.

```bash
git tag -a v1.0.0 -m "MarkForge 1.0.0"
git push origin main --tags
```

### Implementation notes

- **Math survives Markdown.** Formulas are extracted into `\uE000M0\uE001` placeholders before markdown-it runs (skipping fenced blocks and inline code) and restored as KaTeX HTML afterwards.
- **Word gets real images.** KaTeX DOM is rasterized through `<svg><foreignObject>` + Canvas; diagrams go SVG → PNG; `docx` then builds the document around those images.
- **One HTML path for PDF, print, and HTML export**, so all four outputs stay identical.
- **Scroll sync uses `data-line`**, written onto block tokens by a markdown-it core ruler.

### Known limitations

- Word export embeds math and diagrams as images (not native OMML); they blur slightly when scaled up.
- Remote (`http(s)`) images are not supported in Word export; local and `data:` images are.
- PlantUML defaults to the public remote service — avoid sensitive content, prefer a local jar.
- Single instance: opening a second file hands it to the running window.

### License

MIT
