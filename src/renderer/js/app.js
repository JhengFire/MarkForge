/**
 * MDView 渲染进程主逻辑
 */

import { MdEditor } from './editor.js';
import { MarkdownRenderer, extractMath } from './render/markdown.js';
import { initMermaid, renderDiagramNode, clearDiagramCache } from './render/diagrams.js';
import { prepareMindmapExport } from './render/mindmap.js';
import { domSvgToPng, htmlToPng } from './render/raster.js';
import {
  $, $$, el, debounce, throttle, escapeHtml, escapeAttr, countWords,
  formatBytes, nextFrame, fileUrlToPath, resolveLocalUrl,
} from './util.js';

const mdv = window.mdv;

/* ================================================================== *
 * 状态
 * ================================================================== */
const S = {
  settings: {},
  info: {},
  renderer: new MarkdownRenderer(),
  editor: null,
  env: null,
  path: null,
  dir: '',
  dirty: false,
  mode: 'split',
  zoom: 1,
  generation: 0,
  busyCount: 0,
  plantuml: { ready: false, java: '', jar: null },
  katexCss: '',
  forceClosing: false,
  lastRenderOk: true,
};

const DEFAULT_DOC = `# 欢迎使用 MarkForge

这是一个支持 **Mermaid**、**PlantUML** 与 **LaTeX 公式** 的 Markdown 编辑器，编辑与预览同步进行，并可一键打印、导出为 **Word / PDF / HTML**。

## 一、基础语法

**粗体**、*斜体*、~~删除线~~、\`行内代码\`、[链接](https://www.example.com)、H~2~O、x^2^、==高亮==

> 引用块。也可以用 GitHub 风格的提示框：
> [!TIP]
> 用工具栏或快捷键快速插入各种语法。

| 功能 | 快捷键 | 说明 |
| --- | :---: | --- |
| 打开 | Ctrl+O | 打开 Markdown 文件 |
| 保存 | Ctrl+S | 保存当前文档 |
| 打印预览 | Ctrl+P | 所见即所得打印 |
| 导出 Word | Ctrl+Shift+W | 生成 .docx |
| 导出 PDF | Ctrl+Shift+E | 生成 .pdf |

### 任务列表

- [x] 支持 GFM 表格、任务列表、脚注[^1]
- [x] 支持代码高亮
- [ ] 试试在预览区直接点勾选框


### 代码高亮

\`\`\`javascript
function greet(name) {
  // 支持 190+ 种语言
  return \`你好，\${name}！\`;
}
\`\`\`

## 二、数学公式（KaTeX）

行内公式：当 $a \\ne 0$ 时，方程 $ax^2 + bx + c = 0$ 的两个根为
$\\displaystyle x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}$。

块级公式：

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

$$
\\begin{aligned}
\\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0} &
\\nabla \\times \\mathbf{B} &= \\mu_0\\mathbf{J} + \\mu_0\\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t} \\\\
\\nabla \\cdot \\mathbf{B} &= 0 &
\\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t}
\\end{aligned}
$$

矩阵与分段函数：

$$
A = \\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix},
\\qquad
f(x) = \\begin{cases}
x^2, & x \\ge 0 \\\\
-x,  & x < 0
\\end{cases}
$$

## 三、Mermaid 图表

\`\`\`mermaid
flowchart TD
    A[开始] --> B{是否已登录?}
    B -- 是 --> C[进入主页]
    B -- 否 --> D[跳转登录页]
    D --> E[校验账号密码]
    E -->|成功| C
    E -->|失败| F[提示错误]
    F --> D
    C --> G((结束))
\`\`\`

\`\`\`mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant W as 前端
    participant S as 服务端
    participant D as 数据库
    U->>W: 点击「导出 PDF」
    W->>S: POST /export
    S->>D: 查询文档
    D-->>S: 返回数据
    S-->>W: 返回下载地址
    W-->>U: 触发下载
\`\`\`

\`\`\`mermaid
classDiagram
    class Document {
      +String title
      +String content
      +render()
      +export(fmt)
    }
    class Renderer {
      +toHtml(md)
    }
    class Exporter {
      +toPdf()
      +toDocx()
    }
    Document --> Renderer
    Document --> Exporter
\`\`\`

### 思维导图（mindmap）

代码块语言直接写 \`mindmap\`，也支持 \`flowchart\`、\`sequenceDiagram\`、\`gantt\` 等 Mermaid 图类型作为语言标记。层级用缩进（建议 4 空格）表达。

\`\`\`mindmap
mindmap
    root((知识体系))
        AI 基础
            Transformer / Attention / Token
            量化、幻觉、提示注入
            RAG 检索增强
        Agent 智能体
            ReAct、Plan & Execute
            工具调用、参数校验、状态机
            框架：LangGraph、LangChain
        工程化
            后端：Java / Spring Boot
            存储：PostgreSQL、Redis
            部署：Docker、K8s
        可观测与成本
            Token 统计、耗时链路、告警
            评估：召回、相关性、幻觉
\`\`\`

## 四、PlantUML 图表

\`\`\`plantuml
@startuml
skinparam backgroundColor #FFFFFF
skinparam shadowing false
actor 用户 as U
participant "MarkForge" as M
database "本地文件" as F
U -> M : 打开 .md
M -> F : 读取
F --> M : 内容
M --> U : 渲染预览
U -> M : 导出 Word
M -> F : 写入 .docx
@enduml
\`\`\`

## 五、导出与打印

- **Word**：标题、列表、表格、代码块、公式与图表都会被转换；公式和图表以图片形式嵌入，保证在 Word 里也是所见即所得。
- **PDF**：基于 Chromium 打印引擎，支持纸张尺寸、页边距与页码。
- **HTML**：导出自包含的单文件，字体与图片全部内联，离线可看。
- **打印**：Ctrl+P 打开打印预览，或用菜单「文件 → 一键打印」直接调用系统打印机。

---

*把这份示例删掉，开始写你自己的文档吧。*
`;

/**
 * 「插入思维导图」模板。
 *
 * 约定：
 *  - 层级只用缩进表达，统一 4 空格（Mermaid 对缩进敏感，混用 TAB 与空格会串层）；
 *  - 节点文本避免半角括号，否则会被 Mermaid 当成节点形状语法（如 `id(text)`）；
 *  - 避免 `&`，Mermaid 会走 HTML 实体解析，容易渲染成空白。
 */
const MINDMAP_TEMPLATE = [
  '```mindmap',
  'mindmap',
  '    root((AI 应用开发工程师 知识宽度))',
  '        大模型基础',
  '            Transformer / Attention / Token、推理参数',
  '            模型分类：基础 / 指令 / Embedding / Reranker / 多模态',
  '            量化、幻觉、提示注入、安全与提示工程',
  '        RAG 检索增强',
  '            文档处理：解析、清洗、分块、OCR、表格提取',
  '            向量库：PGVector、Milvus、Qdrant、Chroma',
  '            混合检索、重排、查询改写、路由、上下文压缩',
  '        Agent 智能体',
  '            Agent 范式：ReAct、Plan & Execute、记忆体系',
  '            框架：LangGraph、LangChain、AutoGen、n8n',
  '            工具调用、参数校验、容错、权限控制、状态机',
  '        后端与编程语言',
  '            Java：Spring Boot、Spring AI、DDD、Flyway、Maven 多模块',
  '            Python：原型、评估脚本、模型调试',
  '            WebSocket、异步、限流、熔断、重试、链路追踪',
  '        存储与中间件',
  '            PostgreSQL（向量扩展）、MySQL',
  '            Redis：缓存、会话、限流',
  '            消息队列：Kafka / RocketMQ / RabbitMQ',
  '            对象存储：MinIO、OSS',
  '        容器、部署、CI/CD',
  '            Docker、Docker Compose',
  '            K8s 基础：Deployment、Secret、ConfigMap',
  '            推理服务：vLLM、TGI、Ollama',
  '            Git Worktree、PR、Harness',
  '        前端与交互',
  '            流式对话、文件上传、知识库后台',
  '            Vue / React、Three.js 可视化',
  '            多模态交互：图像识别、语音转文字',
  '        评估、可观测与成本',
  '            LLM 评估：召回、相关性、幻觉、LLM-as-judge',
  '            提示日志、Token 统计、耗时链路、告警',
  '        行业、合规、业务适配',
  '            行业知识库：适航、构型、WBS / PBS',
  '            脱敏、权限隔离、数据不出域、版权风险',
  '            AI 嵌入业务流程、需求判断',
  '        架构与软技能',
  '            方案选型权衡：API / 私有化部署',
  '            成本估算：Token、GPU、并发容量',
  '            需求拆解、预期管理、跨角色沟通',
  '        可选延伸能力',
  '            SFT / DPO 微调、数据集闭环',
  '            多模态图文、图表分析',
  '            业务自动化、RPA 智能机器人',
  '```',
].join('\n');

/* ================================================================== *
 * 启动
 * ================================================================== */
async function boot() {
  S.settings = await mdv.settings.get();
  S.info = await mdv.info();

  applyTheme(S.settings.theme);
  buildEditor();
  bindToolbar();
  bindShell();
  buildSettingsUI();
  buildCheatSheet();

  await refreshPlantumlStatus();
  await loadInitialDoc();

  mdv.onCommand(handleCommand);
  mdv.onOpenFile(({ path: p, content }) => openContent(p, content));

  $('#stVersion').textContent = 'v' + S.info.version;
  updateRenderStatus('ok', '就绪');
  selfCheckVendorLibs();
  window.addEventListener('resize', () => layoutPreview());
}

/**
 * 三方库自检。
 *
 * KaTeX / highlight.js / Mermaid 都是 index.html 里的本地 <script> 提供的全局，
 * 一旦某个没加载成功，表现是「公式/图表默默不渲染」，很难排查。
 * 这里在启动时集中报一次，把原因直接摆到用户面前。
 */
function selfCheckVendorLibs() {
  const missing = [];
  if (!window.katex) missing.push('KaTeX（公式）');
  if (!window.hljs) missing.push('highlight.js（代码高亮）');
  if (!window.mermaid) missing.push('Mermaid（图表）');
  if (!missing.length) {
    console.info('[MarkForge] 本地库自检通过：KaTeX / highlight.js / Mermaid');
    return;
  }
  console.error(
    '[MarkForge] 本地库未加载：' + missing.join('、') +
      '。请确认 vendor/ 目录完整（可执行 npm run vendor 重新生成）。'
  );
  toast('本地资源未加载：' + missing.join('、'), 'err', 6000);
  updateRenderStatus('warn', '本地库缺失');
}

function applyTheme(theme) {
  const dark = theme === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#hljs-light').disabled = dark;
  $('#hljs-dark').disabled = !dark;
  $('#stTheme').textContent = dark ? '深色' : '浅色';
  if (S.editor) S.editor.applySettings({ theme: dark ? 'dark' : 'light' });
  clearDiagramCache();
}

function buildEditor() {
  S.editor = new MdEditor($('#editorHost'), {
    doc: '',
    onChange: onDocChanged,
    onCursor: ({ line, col }) => {
      $('#stCursor').textContent = `行 ${line}，列 ${col}`;
    },
    onScroll: () => syncFromEditor(),
  });
  S.editor.applySettings({
    theme: S.settings.theme,
    lineNumbers: S.settings.editorLineNumbers !== false,
    lineWrapping: S.settings.editorLineWrapping !== false,
    tabSize: S.settings.tabSize || 2,
    spellcheck: !!S.settings.spellcheck,
    fontSize: S.settings.editorFontSize || 15,
  });
  layoutPreview();
}

async function loadInitialDoc() {
  const draft = await mdv.draft.read();
  const startPath = (S.info.argvFile || '') || '';
  if (startPath) {
    const r = await mdv.file.openPath(startPath);
    if (r.ok) {
      openContent(r.path, r.content, { silent: true });
      return;
    }
  }
  const content = draft.ok && draft.content && draft.content.trim() ? draft.content : DEFAULT_DOC;
  S.editor.setDoc(content);
  setDirty(false);
  renderNow(true);
}

/* ================================================================== *
 * 渲染
 * ================================================================== */
const renderSoon = debounce(() => renderNow(false), 220);
const saveDraftSoon = debounce(() => {
  if (S.dirty) mdv.draft.write(S.editor.doc);
}, 1200);

function onDocChanged() {
  setDirty(true);
  saveDraftSoon();
  renderSoon();
}

async function renderNow(immediate = false) {
  const gen = ++S.generation;
  const src = S.editor.doc;
  const preview = $('#preview');
  const scrollTop = $('#previewScroll').scrollTop;

  let result;
  try {
    result = S.renderer.render(src, {
      baseDir: S.dir,
      highlight: S.settings.codeHighlight !== false,
      singleDollar: S.settings.singleDollarMath !== false,
      katex: S.settings.renderKaTeX !== false,
      renderMermaid: S.settings.renderMermaid !== false,
      renderPlantUML: S.settings.renderPlantUML !== false,
      docId: 'd' + gen,
    });
  } catch (e) {
    updateRenderStatus('err', '渲染失败');
    console.error(e);
    toast('Markdown 渲染失败：' + e.message, 'err');
    return;
  }

  S.env = result.env;
  preview.innerHTML = result.html;
  $('#previewScroll').scrollTop = scrollTop;

  updateStats(src, result.env);
  buildOutline(result.env);

  // 图表异步渲染
  const nodes = $$('#preview .diagram[data-diagram]');
  if (nodes.length) {
    updateRenderStatus('warn', `正在渲染 ${nodes.length} 张图表…`);
    const tasks = nodes.map((node) => {
      const idx = Number(node.getAttribute('data-diagram'));
      const item = result.env.diagrams[idx];
      if (!item) return Promise.resolve();
      return renderDiagramNode(node, item.code, S.settings).then(() => {
        if (gen !== S.generation) return;
      });
    });
    await Promise.all(tasks);
    if (gen !== S.generation) return;
    const failed = $$('#preview .diagram[data-rendered="error"]').length;
    updateRenderStatus(failed ? 'warn' : 'ok', failed ? `${failed} 张图表渲染失败` : '渲染完成');
  } else {
    updateRenderStatus('ok', '渲染完成');
  }

  updatePreviewHint();
}

function updatePreviewHint() {
  const env = S.env;
  if (!env) return;
  const parts = [];
  if (env.stats.math) parts.push(`${env.stats.math} 个公式`);
  if (env.stats.diagrams) parts.push(`${env.stats.diagrams} 张图表`);
  $('#previewHint').textContent = parts.length ? '实时渲染 · ' + parts.join(' · ') : '实时渲染';
}

function updateStats(src, env) {
  const w = countWords(src);
  const lines = S.editor.view.state.doc.lines;
  $('#stStats').textContent = `${w.total} 字 · ${lines} 行`;
  const bits = [];
  if (env.stats.math) bits.push(`∑ ${env.stats.math}`);
  if (env.stats.diagrams) bits.push(`▣ ${env.stats.diagrams}`);
  $('#stDiagrams').textContent = bits.join('   ');
}

function updateRenderStatus(kind, text) {
  const dot = $('#stRender .dot');
  dot.className = 'dot' + (kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  $('#stRenderText').textContent = text;
}

/* ================================================================== *
 * 大纲
 * ================================================================== */
function buildOutline(env) {
  const list = $('#outlineList');
  const headings = $$('#preview h1, #preview h2, #preview h3, #preview h4, #preview h5, #preview h6');
  if (!headings.length) {
    list.innerHTML = '<div class="empty">还没有标题。<br>用 <b># 标题</b> 或工具栏的 H1/H2 创建层级结构。</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  headings.forEach((h) => {
    const level = Number(h.tagName.slice(1));
    const line = Number(h.getAttribute('data-line') || 0);
    const clone = h.cloneNode(true);
    clone.querySelectorAll('.header-anchor').forEach((a) => a.remove());
    const text = (clone.textContent || '').trim() || '(无标题)';
    const item = el('div', {
      class: `outline-item lv-${level}`,
      text,
      title: text,
      'data-line': String(line),
      'data-id': h.id || '',
    });
    item.addEventListener('click', () => {
      S.editor.gotoLine(line + 1);
      scrollPreviewToLine(line, { smooth: true });
    });
    frag.appendChild(item);
  });
  list.innerHTML = '';
  list.appendChild(frag);
}

/* ================================================================== *
 * 滚动同步
 * ================================================================== */
let syncLock = 0;

function lineAnchors() {
  const nodes = $$('#preview [data-line]');
  return nodes.map((n) => ({ line: Number(n.getAttribute('data-line')), el: n }));
}

function findAnchorForLine(line) {
  const anchors = lineAnchors();
  let best = null;
  for (const a of anchors) {
    if (a.line <= line) {
      if (!best || a.line > best.line) best = a;
    }
  }
  return best || anchors[0] || null;
}

function relTop(node) {
  const scroller = $('#previewScroll');
  return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
}

const syncFromEditor = throttle(() => {
  if (S.settings.syncScroll === false || S.mode !== 'split') return;
  if (syncLock > Date.now()) return;
  const line = S.editor.topLine() - 1;
  const anchor = findAnchorForLine(line);
  if (!anchor) return;
  const scroller = $('#previewScroll');
  const target = Math.max(0, relTop(anchor.el) - 10);
  if (Math.abs(scroller.scrollTop - target) < 2) return;
  syncLock = Date.now() + 120;
  scroller.scrollTop = target;
}, 60);

const syncFromPreview = throttle(() => {
  if (S.settings.syncScroll === false || S.mode !== 'split') return;
  if (syncLock > Date.now()) return;
  const scroller = $('#previewScroll');
  const nodes = $$('#preview [data-line]');
  if (!nodes.length) return;
  const top = scroller.getBoundingClientRect().top + 12;
  let current = nodes[0];
  for (const n of nodes) {
    if (n.getBoundingClientRect().top <= top) current = n;
    else break;
  }
  const line = Number(current.getAttribute('data-line') || 0);
  syncLock = Date.now() + 120;
  S.editor.scrollToLine(line + 1);
  highlightOutline(line);
}, 90);

function highlightOutline(line) {
  let current = null;
  $$('#outlineList .outline-item').forEach((item) => {
    const l = Number(item.getAttribute('data-line') || 0);
    if (l <= line && (!current || l >= Number(current.getAttribute('data-line')))) current = item;
  });
  $$('#outlineList .outline-item.active').forEach((i) => i.classList.remove('active'));
  if (current) {
    current.classList.add('active');
    const box = $('#outlineList');
    const top = current.offsetTop;
    if (top < box.scrollTop || top > box.scrollTop + box.clientHeight - 30) {
      box.scrollTop = Math.max(0, top - box.clientHeight / 2);
    }
  }
}

function scrollPreviewToLine(line, { smooth = false } = {}) {
  const anchor = findAnchorForLine(line);
  if (!anchor) return;
  const scroller = $('#previewScroll');
  const target = Math.max(0, relTop(anchor.el) - 10);
  syncLock = Date.now() + 200;
  if (smooth && 'scrollBehavior' in scroller.style) {
    scroller.scrollTo({ top: target, behavior: 'smooth' });
  } else {
    scroller.scrollTop = target;
  }
}

/* ================================================================== *
 * 布局
 * ================================================================== */
function setMode(mode) {
  S.mode = mode;
  document.body.classList.remove('mode-split', 'mode-editor', 'mode-preview');
  document.body.classList.add('mode-' + mode);
  $$('#modeSwitch button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  layoutPreview();
  if (mode !== 'editor') renderNow(true);
  if (mode !== 'preview') setTimeout(() => S.editor.focus(), 30);
}

function layoutPreview() {
  const body = document.body;
  body.style.setProperty('--md-max-width', (Number(S.settings.contentWidth) || 860) + 'px');
  const sz = (Number(S.settings.previewFontSize) || 16) * S.zoom;
  body.style.setProperty('--md-font-size', sz.toFixed(1) + 'px');
  body.style.setProperty('--md-line-height', String(S.settings.lineHeight || 1.75));
  $('#preview').classList.toggle('font-serif', S.settings.previewFontFamily === 'serif');
  $('#previewScroll').style.background = 'var(--ui-panel)';
}

function setZoom(delta) {
  S.zoom = Math.min(2.4, Math.max(0.6, +(S.zoom + delta).toFixed(2)));
  layoutPreview();
  if (S.editor) {
    S.editor.applySettings({ fontSize: Math.round((Number(S.settings.editorFontSize) || 15) * S.zoom) });
  }
  toast(`缩放 ${Math.round(S.zoom * 100)}%`, 'info', 1200);
}

function setOutline(open) {
  document.body.classList.toggle('outline-open', open);
  S.outlineOpen = open;
}

/* ================================================================== *
 * 文件
 * ================================================================== */
function setDirty(dirty) {
  S.dirty = dirty;
  $('#docTitle').classList.toggle('dirty', dirty);
}

function setDocTitle(p) {
  S.path = p || null;
  const name = p ? p.split(/[\\/]/).pop() : '未命名.md';
  $('#docName').textContent = name;
  $('#docName').title = p || '未保存的文档';
  $('#docHint').textContent = p ? '' : '（未保存）';
}

async function newFile() {
  if (!(await confirmDiscard())) return;
  S.editor.setDoc('');
  setDocTitle(null);
  S.dir = '';
  setDirty(false);
  await mdv.draft.clear();
  renderNow(true);
  S.editor.focus();
}

async function openFile() {
  if (!(await confirmDiscard())) return;
  const r = await mdv.file.openDialog();
  if (r.canceled) return;
  openContent(r.path, r.content);
}

function openContent(p, content, { silent = false } = {}) {
  S.editor.setDoc(content);
  setDocTitle(p);
  S.dir = p ? p.replace(/[\\/][^\\/]*$/, '') : '';
  setDirty(false);
  mdv.draft.clear();
  renderNow(true);
  if (!silent) toast('已打开 ' + p.split(/[\\/]/).pop(), 'ok', 1600);
}

async function saveFile() {
  const content = S.editor.doc;
  if (!S.path) return saveFileAs();
  const r = await mdv.file.save(S.path, content);
  if (r.ok) {
    setDirty(false);
    await mdv.draft.clear();
    toast('已保存到 ' + r.path, 'ok', 1600);
  } else {
    toast('保存失败：' + r.error, 'err', 4000);
  }
}

async function saveFileAs() {
  const cur = S.path || '';
  const defaultName = cur ? cur.split(/[\\/]/).pop() : '未命名.md';
  const r = await mdv.file.saveAsDialog({
    defaultName,
    content: S.editor.doc,
    filters: [
      { name: 'Markdown', extensions: ['md'] },
      { name: '纯文本', extensions: ['txt'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (r.canceled) return;
  if (r.ok) {
    setDocTitle(r.path);
    S.dir = r.path.replace(/[\\/][^\\/]*$/, '');
    setDirty(false);
    await mdv.draft.clear();
    renderNow(true);
    toast('已保存到 ' + r.path, 'ok', 2000);
  } else {
    toast('保存失败：' + r.error, 'err');
  }
}

/** 有未保存修改时询问；返回 true 表示可以继续 */
async function confirmDiscard() {
  if (!S.dirty) return true;
  const name = S.path ? S.path.split(/[\\/]/).pop() : '未命名.md';
  const r = await mdv.dialog.confirmSave(name);
  if (r === 0) {
    await saveFile();
    return !S.dirty;
  }
  return r === 1;
}

/* ================================================================== *
 * 导出 / 打印
 * ================================================================== */
async function ensureRendered() {
  if ($$('#preview .diagram[data-rendered]').length !== $$('#preview .diagram').length) {
    await renderNow(true);
  }
}

async function withMeasuring(fn) {
  const need = $('#previewScroll').clientWidth === 0;
  if (need) {
    document.body.classList.add('measuring');
    await nextFrame();
    await nextFrame();
  }
  try {
    return await fn();
  } finally {
    if (need) document.body.classList.remove('measuring');
  }
}

function docTitle() {
  if (S.path) return S.path.split(/[\\/]/).pop().replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
  const first = ($('#preview h1') && $('#preview h1').textContent) || '';
  return first.trim() || '未命名文档';
}

function baseMeta(extra = {}) {
  return {
    pageSize: S.settings.pdfPageSize || 'A4',
    margin: S.settings.pdfMargin == null ? 18 : S.settings.pdfMargin,
    landscape: !!S.settings.pdfLandscape,
    contentWidth: Number(S.settings.contentWidth) || 860,
    codeHighlight: S.settings.codeHighlight !== false,
    codeTheme: S.settings.codeTheme || 'github',
    author: S.settings.authorName || '',
    ...extra,
  };
}

async function exportHtml() {
  busy(true, '正在生成 HTML…');
  try {
    const payload = await makeExportHtml();
    const name = docTitle().replace(/[\\/:*?"<>|]/g, '_') + '.html';
    const r = await mdv.exporter.html({ payload, defaultName: name });
    if (r.canceled) return;
    if (r.ok) toast('HTML 已导出：' + r.path, 'ok', 3200);
    else toast('导出失败：' + r.error, 'err', 4000);
  } finally {
    busy(false);
  }
}

/** 由主进程把 CSS / 字体内联成单文件 HTML */
async function buildHtml(payload) {
  const r = await mdv.exporter.html({ payload, dryRun: true });
  return (r && r.html) || '';
}

/** 组装可导出的完整 HTML（由主进程拼 CSS / 字体） */
async function makeExportHtml(metaOverride = {}) {
  await ensureRendered();
  // 思维导图的拖动/缩放只影响屏幕预览，导出前还原成完整原图
  const restoreMindmaps = prepareMindmapExport($('#preview'));
  let bodyHtml = '';
  try {
    bodyHtml = $('#preview').innerHTML;
  } finally {
    restoreMindmaps();
  }
  return {
    title: docTitle(),
    bodyHtml,
    baseDir: S.dir,
    theme: S.settings.theme,
    meta: baseMeta(metaOverride),
  };
}

async function exportPdf() {
  const opts = await askPdfOptions();
  if (!opts) return;
  busy(true, '正在生成 PDF…');
  try {
    const payload = await makeExportHtml({
      pageSize: opts.pageSize,
      margin: opts.margin,
      landscape: opts.landscape,
    });
    const html = await buildHtml(payload);
    const name = docTitle().replace(/[\\/:*?"<>|]/g, '_') + '.pdf';
    const r = await mdv.exporter.pdf({
      html,
      defaultName: name,
      options: {
        pageSize: opts.pageSize,
        margin: opts.margin,
        landscape: opts.landscape,
        headerFooter: opts.headerFooter,
        printBackground: opts.printBackground,
      },
    });
    if (r.canceled) return;
    if (r.ok) toast(`PDF 已导出：${r.path}（${formatBytes(r.size)}）`, 'ok', 3600);
    else toast('导出失败：' + r.error, 'err', 4000);
  } finally {
    busy(false);
  }
}

async function printPreview() {
  busy(true, '正在准备打印…');
  try {
    const payload = await makeExportHtml();
    const html = await buildHtml(payload);
    const r = await mdv.printer.preview({ html, title: docTitle() });
    if (!r.ok) toast('无法打开打印预览：' + r.error, 'err');
  } finally {
    busy(false);
  }
}

async function printNow() {
  busy(true, '正在发送到打印机…');
  try {
    const payload = await makeExportHtml();
    const html = await buildHtml(payload);
    const r = await mdv.printer.now({
      html,
      options: { silent: false, printBackground: S.settings.pdfPrintBackground !== false },
    });
    if (r.ok) toast('已发送到打印机', 'ok');
    else if (r.reason) toast('打印取消或失败：' + r.reason, 'warn', 4000);
  } finally {
    busy(false);
  }
}

/* ---------------- Word 导出 ---------------- */
async function exportDocx(opts = {}) {
  const quiet = !!opts.quiet;
  if (!quiet) busy(true, '正在生成 Word 文档…');
  try {
    // 1) 取出 token 树（与预览同一套预处理）
    const extracted = extractMath(S.editor.doc, { singleDollar: S.settings.singleDollarMath !== false });
    const env = { baseDir: S.dir, docId: 'docx', headings: [], diagrams: [], math: extracted.items, images: {} };
    let tokens;
    try {
      tokens = S.renderer.md.parse(extracted.text, env);
    } catch (e) {
      toast('解析 Markdown 失败：' + e.message, 'err');
      return;
    }

    if (!S.katexCss) S.katexCss = await mdv.exporter.katexCss();

    let mathMissing = 0;
    const payload = await withMeasuring(async () => {
      await ensureRendered();
      const mathRes = await collectMathPngs();
      mathMissing = mathRes.missing;
      return {
        tokens,
        baseDir: S.dir,
        images: await collectImageAssets(),
        math: mathRes.map,
        diagrams: await collectDiagramPngs(),
        meta: {
          title: docTitle(),
          author: S.settings.authorName || '',
          fontFamily: S.settings.previewFontFamily,
          bodyFont: S.settings.docxBodyFont || '等线',
          codeFont: S.settings.docxCodeFont || 'Consolas',
          fontSize: 21,
          defaultName: docTitle().replace(/[\\/:*?"<>|]/g, '_') + '.docx',
        },
      };
    });

    const r = await mdv.exporter.docx({ ...payload, targetPath: opts.targetPath || payload.targetPath });
    if (r.canceled) return r;
    if (r.ok) {
      let msg = `Word 已导出：${r.path}（${formatBytes(r.size)}）`;
      const warns = (r.warnings ? r.warnings.length : 0) + mathMissing;
      if (warns) msg += ` · ${warns} 处提示`;
      if (!quiet) toast(msg, 'ok', 4000);
      if (mathMissing) {
        console.warn(`${mathMissing} 个公式未能栅格化，Word 中以占位文本替代`);
      }
    } else if (!quiet) {
      toast('导出失败：' + r.error, 'err', 5000);
    }
    return r;
  } finally {
    if (!quiet) busy(false);
  }
}

/** 图片资源：本地文件读成 dataURL，并测量尺寸 */
async function collectImageAssets() {
  const out = {};
  const imgs = $$('#preview img');
  for (const img of imgs) {
    const raw = img.getAttribute('src') || '';
    if (!raw || out[raw]) continue;
    let dataUrl = '';
    let width = 0;
    let height = 0;
    if (/^data:/i.test(raw)) {
      dataUrl = raw;
    } else if (/^https?:/i.test(raw)) {
      continue; // 远程图片交给 Word 端不可用，跳过
    } else {
      const p = fileUrlToPath(raw);
      const r = await mdv.file.readDataUrl(p);
      if (!r.ok) continue;
      dataUrl = r.dataUrl;
    }
    const size = await measureImage(dataUrl);
    width = size.width;
    height = size.height;
    if (dataUrl) out[raw] = { dataUrl, width, height };
  }
  return out;
}

function measureImage(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 600, height: img.naturalHeight || 400 });
    img.onerror = () => resolve({ width: 600, height: 400 });
    img.src = dataUrl;
  });
}

/**
 * 公式 → PNG
 *
 * 两点关键：
 * 1) 直接把实时 DOM 里的 .katex 元素交给栅格化（内部走 XMLSerializer），
 *    不要用 outerHTML 拼字符串，否则 TeX 里的 & / < 会让 SVG 变成非法 XML。
 * 2) 字号要换算：预览里公式按 16px 正文渲染，而 Word 正文是 10.5pt(≈14px)。
 *    不换算的话公式在 Word 里会明显比正文大一圈。
 *
 * @returns {Promise<{ map: object, missing: number }>}
 */
async function collectMathPngs() {
  const WORD_BODY_PX = 14; // 10.5pt @96dpi，与 docx.js 的 baseSize(21 半磅) 对应
  const map = {};
  const nodes = $$('#preview [data-math]');
  let missing = 0;

  for (const node of nodes) {
    const idx = node.getAttribute('data-math');
    if (idx == null || map[idx]) continue;
    const target = node.querySelector('.katex') || node;
    const rect = target.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) {
      missing++;
      continue;
    }
    const fontPx = parseFloat(getComputedStyle(target).fontSize) || 16;
    const k = WORD_BODY_PX / fontPx;
    try {
      const png = await htmlToPng(target, {
        width: Math.ceil(rect.width),
        height: Math.ceil(rect.height),
        css: S.katexCss,
        scale: 3,
        padding: 4,
      });
      map[idx] = {
        dataUrl: png.dataUrl,
        width: png.width * k,
        height: png.height * k,
      };
    } catch (e) {
      missing++;
      console.warn('公式栅格化失败', idx, e);
    }
  }
  return { map, missing };
}

/** 图表 → PNG */
async function collectDiagramPngs() {
  const out = {};
  const nodes = $$('#preview .diagram');
  for (const node of nodes) {
    const idx = node.getAttribute('data-diagram');
    const svg = node.querySelector('svg');
    if (!svg) continue;
    try {
      out[idx] = await domSvgToPng(svg, { scale: 2 });
    } catch (e) {
      console.warn('图表栅格化失败', e);
    }
  }
  return out;
}

/* ================================================================== *
 * 命令分发
 * ================================================================== */
function handleCommand({ id, checked }) {
  const ed = S.editor;
  switch (id) {
    /* 文件 */
    case 'file.new': return newFile();
    case 'file.open': return openFile();
    case 'file.save': return saveFile();
    case 'file.saveAs': return saveFileAs();

    /* 导出 */
    case 'export.docx': return exportDocx();
    case 'export.pdf': return exportPdf();
    case 'export.html': return exportHtml();
    case 'print.preview': return printPreview();
    case 'print.now': return printNow();

    /* 编辑 */
    case 'edit.find': return ed.openSearch();
    case 'fmt.bold': return ed.wrap('**', '**', '粗体');
    case 'fmt.italic': return ed.wrap('*', '*', '斜体');
    case 'fmt.strike': return ed.wrap('~~', '~~', '删除线');
    case 'fmt.code': return ed.wrap('`', '`', 'code');
    case 'fmt.h1': return ed.setHeading(1);
    case 'fmt.h2': return ed.setHeading(2);
    case 'fmt.h3': return ed.setHeading(3);
    case 'fmt.p': return ed.setHeading(0);
    case 'fmt.ul': return ed.toggleLinePrefix('- ');
    case 'fmt.ol': return ed.toggleLinePrefix('1. ');
    case 'fmt.task': return ed.toggleLinePrefix('- [ ] ', { exclusive: null });
    case 'fmt.quote': return ed.toggleLinePrefix('> ');
    case 'fmt.codeblock': return ed.insertBlock('```\n' + '\n```');
    case 'fmt.hr': return ed.insertBlock('\n---\n');
    case 'fmt.table':
      return ed.insertBlock(
        '\n| 列 1 | 列 2 | 列 3 |\n| --- | :---: | ---: |\n| 内容 | 内容 | 内容 |\n| 内容 | 内容 | 内容 |\n'
      );

    /* 插入 */
    case 'ins.link': return ed.wrap('[', '](https://)', '链接文字');
    case 'ins.image': return ed.insertBlock('![图片说明](图片路径.png)');
    case 'ins.imageFile': return insertImageFromFile();
    case 'ins.mathInline': return ed.wrap('$', '$', 'a^2+b^2=c^2');
    case 'ins.mathBlock': return ed.insertBlock('\n$$\n\\int_{0}^{1} x^2 \\, dx = \\frac{1}{3}\n$$\n');
    case 'ins.mermaid':
      return ed.insertBlock(
        '\n```mermaid\nflowchart LR\n    A[开始] --> B{判断}\n    B -->|是| C[处理]\n    B -->|否| D[结束]\n    C --> D\n```\n'
      );
    case 'ins.plantuml':
      return ed.insertBlock(
        '\n```plantuml\n@startuml\nactor 用户\n用户 -> 系统 : 发起请求\n系统 --> 用户 : 返回结果\n@enduml\n```\n'
      );
    case 'ins.mindmap': return ed.insertBlock('\n' + MINDMAP_TEMPLATE + '\n');
    case 'ins.toc': return ed.insertBlock('\n[TOC]\n');
    case 'ins.pagebreak': return ed.insertBlock('\n\\pagebreak\n');
    case 'ins.cheatsheet': return openOverlay('cheatOverlay');

    /* 视图 */
    case 'view.split': return setMode('split');
    case 'view.editor': return setMode('editor');
    case 'view.preview': return setMode('preview');
    case 'view.outline': return setOutline(!document.body.classList.contains('outline-open'));
    case 'view.syncScroll':
      applySettings({ syncScroll: checked });
      return;
    case 'view.wrap':
      applySettings({ editorLineWrapping: checked });
      return;
    case 'view.zoomIn': return setZoom(0.1);
    case 'view.zoomOut': return setZoom(-0.1);
    case 'view.zoomReset': { S.zoom = 1; layoutPreview(); return; }
    case 'view.themeLight': return toggleTheme('light');
    case 'view.themeDark': return toggleTheme('dark');

    /* 其他 */
    case 'app.settings': return openOverlay('settingsOverlay');
    case 'help.syntax': return ed.insertBlock(SYNTAX_HELP);
    case 'help.samples': return insertSamples();
    case 'help.about': return openAbout();
    default:
      console.warn('未知命令', id);
  }
}

async function insertImageFromFile() {
  const r = await mdv.file.openDialog();
  if (r.canceled) return;
  // 用相对路径插入（相对当前文档目录）
  let p = r.path.replace(/\\/g, '/');
  if (S.dir) {
    const base = S.dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
    if (p.toLowerCase().startsWith(base.toLowerCase())) p = p.slice(base.length);
  }
  S.editor.insertBlock(`![${p.split('/').pop()}](${p})`);
}

/* ================================================================== *
 * 设置
 * ================================================================== */
const SETTINGS_SCHEMA = {
  appear: [
    { key: 'theme', label: '界面主题', type: 'select', options: [['light', '浅色'], ['dark', '深色']] },
    { key: 'previewFontFamily', label: '正文字体', type: 'select', options: [['system', '无衬线（默认）'], ['serif', '衬线 / 宋体']] },
    { key: 'previewFontSize', label: '正文字号 (px)', type: 'range', min: 12, max: 26, step: 1 },
    { key: 'editorFontSize', label: '编辑区字号 (px)', type: 'range', min: 11, max: 24, step: 1 },
    { key: 'lineHeight', label: '行高', type: 'range', min: 1.3, max: 2.4, step: 0.05 },
    { key: 'contentWidth', label: '正文最大宽度 (px)', type: 'number', min: 480, max: 1600, step: 20 },
  ],
  editor: [
    { key: 'editorLineNumbers', label: '显示行号', type: 'check' },
    { key: 'editorLineWrapping', label: '自动换行', type: 'check' },
    { key: 'spellcheck', label: '拼写检查', type: 'check', desc: '在编辑区标记拼写可疑的单词（英文为主）' },
    { key: 'tabSize', label: 'Tab 宽度', type: 'select', options: [['2', '2 空格'], ['4', '4 空格'], ['8', '8 空格']] },
  ],
  preview: [
    { key: 'syncScroll', label: '编辑与预览滚动同步', type: 'check' },
    { key: 'codeHighlight', label: '代码语法高亮', type: 'check' },
    {
      key: 'codeTheme', label: '代码高亮主题', type: 'select',
      options: [['github', 'GitHub 浅色'], ['github-dark', 'GitHub 深色'], ['atom-one-light', 'Atom 浅色'], ['atom-one-dark', 'Atom 深色'], ['vs', 'VS'], ['xcode', 'Xcode'], ['monokai', 'Monokai'], ['dracula', 'Dracula']],
    },
    { key: 'renderKaTeX', label: '渲染 KaTeX 公式', type: 'check' },
    { key: 'singleDollarMath', label: '识别单美元符号行内公式 $…$', type: 'check', desc: '关闭后可避免与 "$100" 这类文本冲突，公式改用 \\( … \\) 写法' },
    { key: 'renderMermaid', label: '渲染 Mermaid 图', type: 'check' },
    { key: 'mermaidTheme', label: 'Mermaid 主题', type: 'select', options: [['default', '默认'], ['neutral', '中性'], ['forest', '森林'], ['dark', '深色'], ['base', '基础']] },
    { key: 'mindmapFontSize', label: '思维导图字号 (px)', type: 'range', min: 11, max: 22, step: 1, desc: '节点文字大小；画布尺寸随之自动调整' },
    { key: 'renderPlantUML', label: '渲染 PlantUML 图', type: 'check' },
    { key: 'plantumlMode', label: 'PlantUML 渲染方式', type: 'select', options: [['remote', '远程服务（需联网）'], ['local', '本地 Java + plantuml.jar']] },
    { key: 'plantumlServer', label: 'PlantUML 服务地址', type: 'text', desc: '例如 https://www.plantuml.com/plantuml，也可填自建服务' },
  ],
  export: [
    { key: 'pdfPageSize', label: '纸张大小', type: 'select', options: [['A4', 'A4'], ['A3', 'A3'], ['A5', 'A5'], ['Letter', 'Letter'], ['Legal', 'Legal'], ['Tabloid', 'Tabloid']] },
    { key: 'pdfMargin', label: '页边距 (mm)', type: 'range', min: 0, max: 50, step: 1 },
    { key: 'pdfLandscape', label: '横向纸张', type: 'check' },
    { key: 'pdfHeaderFooter', label: '显示页码', type: 'check' },
    { key: 'pdfPrintBackground', label: '打印背景色与底色', type: 'check' },
    { key: 'docxBodyFont', label: 'Word 正文字体', type: 'text' },
    { key: 'docxCodeFont', label: 'Word 代码字体', type: 'text' },
    { key: 'authorName', label: '文档作者（写入导出文件属性）', type: 'text' },
  ],
};

function buildSettingsUI() {
  const body = $('#settingsBody');
  const render = (tab) => {
    body.innerHTML = '';
    const fields = SETTINGS_SCHEMA[tab];
    if (!fields) {
      renderAboutPane(body);
      return;
    }
    for (const f of fields) {
      body.appendChild(settingsField(f));
    }
  };
  $$('#settingsTabs button').forEach((b) => {
    b.addEventListener('click', () => {
      $$('#settingsTabs button').forEach((x) => x.classList.toggle('active', x === b));
      render(b.dataset.tab);
    });
  });
  render('appear');
}

function settingsField(f) {
  const wrap = el('div', { class: 'field' });
  const cur = S.settings[f.key];
  if (f.type === 'check') {
    const lab = el('label', { class: 'check' });
    const input = el('input', { type: 'checkbox' });
    input.checked = cur !== false;
    input.addEventListener('change', () => applySettings({ [f.key]: input.checked }));
    lab.appendChild(input);
    lab.appendChild(el('div', {}, [el('div', { class: 't', text: f.label }), f.desc ? el('div', { class: 'd', text: f.desc }) : null]));
    wrap.appendChild(lab);
    return wrap;
  }
  wrap.appendChild(el('label', { text: f.label }));
  let input;
  if (f.type === 'select') {
    input = el('select');
    for (const [v, t] of f.options) {
      const o = el('option', { value: v, text: t });
      input.appendChild(o);
    }
    input.value = String(cur);
    input.addEventListener('change', () => applySettings({ [f.key]: input.value }));
  } else if (f.type === 'range') {
    const row = el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } });
    input = el('input', { type: 'range', min: f.min, max: f.max, step: f.step });
    input.value = String(cur);
    const out = el('span', { class: 'hint', text: String(cur), style: { minWidth: '46px', textAlign: 'right', fontSize: '12px', color: 'var(--ui-muted)' } });
    input.addEventListener('input', () => { out.textContent = input.value; });
    input.addEventListener('change', () => applySettings({ [f.key]: Number(input.value) }));
    row.appendChild(input);
    row.appendChild(out);
    wrap.appendChild(row);
    if (f.desc) wrap.appendChild(el('div', { class: 'desc', text: f.desc }));
    return wrap;
  } else if (f.type === 'number') {
    input = el('input', { type: 'number', min: f.min, max: f.max, step: f.step });
    input.value = String(cur);
    input.addEventListener('change', () => applySettings({ [f.key]: Number(input.value) }));
  } else {
    input = el('input', { type: 'text' });
    input.value = cur == null ? '' : String(cur);
    input.addEventListener('change', () => applySettings({ [f.key]: input.value }));
  }
  wrap.appendChild(input);
  if (f.desc) wrap.appendChild(el('div', { class: 'desc', text: f.desc }));
  return wrap;
}

function renderAboutPane(body) {
  const i = S.info;
  body.innerHTML = '';
  const tb = el('table', { style: { width: '100%', fontSize: '13px', borderCollapse: 'collapse' } });
  const rows = [
    ['版本', 'MarkForge v' + i.version],
    ['运行环境', `Electron ${i.electron} · Chromium ${i.chrome} · Node ${i.node}`],
    ['平台', i.platform],
    ['配置文件目录', i.userData],
  ];
  for (const [k, v] of rows) {
    const tr = el('tr');
    tr.appendChild(el('td', { text: k, style: { padding: '6px 10px 6px 0', color: 'var(--ui-muted)', whiteSpace: 'nowrap', verticalAlign: 'top' } }));
    tr.appendChild(el('td', { text: v, style: { padding: '6px 0', wordBreak: 'break-all' } }));
    tb.appendChild(tr);
  }
  body.appendChild(el('div', { class: 'section-title', text: '运行信息' }));
  body.appendChild(tb);

  body.appendChild(el('div', { class: 'section-title', text: 'PlantUML 本地渲染' }));
  const info = el('div', { class: 'desc' });
  body.appendChild(info);
  const btn = el('button', { class: 'btn', text: '下载 plantuml.jar', style: { marginTop: '10px' } });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '正在下载…';
    const r = await mdv.plantuml.downloadJar();
    btn.disabled = false;
    btn.textContent = '下载 plantuml.jar';
    if (r.ok) {
      await refreshPlantumlStatus();
      renderAboutPane(body);
      toast('plantuml.jar 已下载，可离线渲染 PlantUML', 'ok', 3600);
    } else {
      toast('下载失败：' + r.error, 'err', 4000);
    }
  });
  body.appendChild(btn);
  updatePlantumlInfo(info);

  body.appendChild(el('div', { class: 'section-title', text: '上游开源项目' }));
  body.appendChild(
    el('div', {
      class: 'desc',
      html:
        'Markdown 解析 <b>markdown-it</b> · 编辑器 <b>CodeMirror 6</b> · 公式 <b>KaTeX</b> · ' +
        '图表 <b>Mermaid</b> · <b>PlantUML</b> · 代码高亮 <b>highlight.js</b> · 文档生成 <b>docx</b>',
    })
  );

  const row = el('div', { style: { marginTop: '14px', display: 'flex', gap: '8px' } });
  const b1 = el('button', { class: 'btn', text: '打开配置目录' });
  b1.addEventListener('click', () => mdv.file.reveal(i.userData));
  row.appendChild(b1);
  body.appendChild(row);
}

function updatePlantumlInfo(node) {
  if (!node) return;
  const p = S.plantuml;
  node.innerHTML = p.ready
    ? `已就绪<br>Java：<code>${escapeHtml(p.java)}</code><br>jar：<code>${escapeHtml(p.jar)}</code>`
    : `未配置本地 jar，当前使用远程服务渲染。<br>若需离线渲染，下载 jar 放入配置目录即可（需本机有 Java，当前检测：<code>${escapeHtml(p.java || '未找到')}</code>）。`;
}

async function refreshPlantumlStatus() {
  try {
    S.plantuml = await mdv.plantuml.status();
  } catch {
    S.plantuml = { ready: false, java: '', jar: null };
  }
  const st = $('#stPlantuml');
  if (st) {
    st.textContent = S.plantuml.ready ? 'PlantUML 本地' : 'PlantUML 远程';
    st.title = S.plantuml.ready ? '使用本地 Java 渲染：' + S.plantuml.jar : '使用远程服务渲染';
  }
  return S.plantuml;
}

function applySettings(patch) {
  S.settings = { ...S.settings, ...patch };
  mdv.settings.set(patch);
  if (patch.theme) applyTheme(patch.theme);
  layoutPreview();
  if (S.editor) {
    S.editor.applySettings({
      theme: S.settings.theme,
      lineNumbers: S.settings.editorLineNumbers !== false,
      lineWrapping: S.settings.editorLineWrapping !== false,
      tabSize: Number(S.settings.tabSize) || 2,
      spellcheck: !!S.settings.spellcheck,
      fontSize: Math.round((Number(S.settings.editorFontSize) || 15) * S.zoom),
    });
  }
  if ('mermaidTheme' in patch || 'plantumlMode' in patch || 'plantumlServer' in patch) clearDiagramCache();
  if ('codeHighlight' in patch || 'codeTheme' in patch) updateCodeTheme();
  renderNow(true);
}

function toggleTheme(theme) {
  applySettings({ theme });
  toast(theme === 'dark' ? '已切换到深色主题' : '已切换到浅色主题', 'info', 1200);
}

function updateCodeTheme() {
  const base = S.settings.codeTheme || 'github';
  $('#hljs-light').href = `../../vendor/highlight/styles/${base}.min.css`;
  $('#hljs-dark').href = `../../vendor/highlight/styles/${base}.min.css`;
}

/* ================================================================== *
 * PDF 选项弹窗
 * ================================================================== */
function askPdfOptions() {
  return new Promise((resolve) => {
    const body = $('#metaBody');
    const foot = $('#metaFoot');
    $('#metaTitle').textContent = '导出 PDF 选项';
    body.innerHTML = '';
    const opt = {
      pageSize: S.settings.pdfPageSize || 'A4',
      margin: S.settings.pdfMargin == null ? 18 : S.settings.pdfMargin,
      landscape: !!S.settings.pdfLandscape,
      headerFooter: S.settings.pdfHeaderFooter !== false,
      printBackground: S.settings.pdfPrintBackground !== false,
    };
    // 就地构建（不写回 settings）
    const size = el('select');
    for (const v of ['A4', 'A3', 'A5', 'Letter', 'Legal', 'Tabloid']) {
      const o = el('option', { value: v, text: v });
      size.appendChild(o);
    }
    size.value = opt.pageSize;
    size.addEventListener('change', () => { opt.pageSize = size.value; });

    const margin = el('input', { type: 'range', min: 0, max: 40, step: 1 });
    margin.value = String(opt.margin);
    const mo = el('span', { text: opt.margin + ' mm', style: { fontSize: '12px', color: 'var(--ui-muted)', minWidth: '52px' } });
    margin.addEventListener('input', () => { mo.textContent = margin.value + ' mm'; opt.margin = Number(margin.value); });

    const f1 = el('div', { class: 'field' }, [el('label', { text: '纸张大小' }), size]);
    const f2 = el('div', { class: 'field' }, [el('label', { text: '页边距' }), el('div', { style: { display: 'flex', gap: '10px', alignItems: 'center' } }, [margin, mo])]);

    const checks = [
      ['landscape', '横向纸张'],
      ['headerFooter', '显示页码'],
      ['printBackground', '打印背景色'],
    ];
    const f3 = el('div', {});
    for (const [k, label] of checks) {
      const lab = el('label', { class: 'check' });
      const cb = el('input', { type: 'checkbox' });
      cb.checked = opt[k];
      cb.addEventListener('change', () => { opt[k] = cb.checked; });
      lab.appendChild(cb);
      lab.appendChild(el('span', { class: 't', text: label }));
      f3.appendChild(lab);
    }

    body.appendChild(f1);
    body.appendChild(f2);
    body.appendChild(f3);

    const remember = el('label', { class: 'check' });
    const rcb = el('input', { type: 'checkbox' });
    rcb.checked = true;
    remember.appendChild(rcb);
    remember.appendChild(el('span', { class: 't', text: '记住这些设置' }));
    body.appendChild(remember);

    foot.innerHTML = '';
    const cancel = el('button', { class: 'btn', text: '取消' });
    const ok = el('button', { class: 'btn primary', text: '选择保存位置' });
    const finish = (val) => {
      closeOverlay('metaOverlay');
      resolve(val);
    };
    cancel.addEventListener('click', () => finish(null));
    ok.addEventListener('click', () => {
      if (rcb.checked) {
        applySettings({
          pdfPageSize: opt.pageSize,
          pdfMargin: opt.margin,
          pdfLandscape: opt.landscape,
          pdfHeaderFooter: opt.headerFooter,
          pdfPrintBackground: opt.printBackground,
        });
      }
      finish(opt);
    });
    foot.appendChild(cancel);
    foot.appendChild(ok);
    openOverlay('metaOverlay');
  });
}

/* ================================================================== *
 * 速查表
 * ================================================================== */
function buildCheatSheet() {
  $('#cheatBody').innerHTML = `
  <div class="cheat">
    <div>
      <h4>Markdown</h4>
      <table>
        <tr><td># 标题</td><td>一级标题，最多 ######</td></tr>
        <tr><td>**粗体**</td><td>加粗</td></tr>
        <tr><td>*斜体*</td><td>斜体</td></tr>
        <tr><td>~~删除~~</td><td>删除线</td></tr>
        <tr><td>\`代码\`</td><td>行内代码</td></tr>
        <tr><td>- 项 / 1. 项</td><td>无序 / 有序列表</td></tr>
        <tr><td>- [ ] / - [x]</td><td>任务列表</td></tr>
        <tr><td>&gt; 文字</td><td>引用块</td></tr>
        <tr><td>| a | b |</td><td>表格（配合 --- 分隔行）</td></tr>
        <tr><td>[文字](url)</td><td>链接</td></tr>
        <tr><td>![说明](路径)</td><td>图片</td></tr>
        <tr><td>[^1] + [^1]: 内容</td><td>脚注</td></tr>
        <tr><td>[TOC]</td><td>自动目录</td></tr>
        <tr><td>\\pagebreak</td><td>强制分页（打印/导出生效）</td></tr>
      </table>
      <h4>提示框</h4>
      <table>
        <tr><td>&gt; [!NOTE]</td><td>提示 / TIP / IMPORTANT</td></tr>
        <tr><td>&gt; [!WARNING]</td><td>注意 / CAUTION</td></tr>
      </table>
    </div>
    <div>
      <h4>KaTeX 公式</h4>
      <table>
        <tr><td>$x^2 + y^2$</td><td>行内公式</td></tr>
        <tr><td>$$ … $$</td><td>块级公式（居中）</td></tr>
        <tr><td>\\frac{a}{b}</td><td>分数</td></tr>
        <tr><td>\\sqrt[3]{x}</td><td>根式</td></tr>
        <tr><td>\\sum_{i=1}^{n}</td><td>求和</td></tr>
        <tr><td>\\int_{a}^{b}</td><td>积分</td></tr>
        <tr><td>\\lim_{x \\to 0}</td><td>极限</td></tr>
        <tr><td>\\alpha \\beta \\gamma</td><td>希腊字母</td></tr>
        <tr><td>\\begin{pmatrix} … \\end{pmatrix}</td><td>矩阵</td></tr>
        <tr><td>\\begin{cases} … \\end{cases}</td><td>分段函数</td></tr>
        <tr><td>\\begin{aligned} … \\end{aligned}</td><td>多行对齐</td></tr>
        <tr><td>\\vec{v} \\cdot \\nabla</td><td>向量 / 算子</td></tr>
        <tr><td>\\text{中文}</td><td>公式里写中文</td></tr>
      </table>
      <h4>图表代码块</h4>
      <table>
        <tr><td>\`\`\`mermaid</td><td>Mermaid 图（首行写图类型）</td></tr>
        <tr><td>flowchart TD</td><td>流程图</td></tr>
        <tr><td>sequenceDiagram</td><td>时序图</td></tr>
        <tr><td>classDiagram</td><td>类图</td></tr>
        <tr><td>stateDiagram-v2</td><td>状态图</td></tr>
        <tr><td>erDiagram</td><td>ER 图</td></tr>
        <tr><td>gantt</td><td>甘特图</td></tr>
        <tr><td>pie</td><td>饼图</td></tr>
        <tr><td>gitGraph</td><td>Git 分支图</td></tr>
        <tr><td>mindmap</td><td>思维导图（缩进表示层级）</td></tr>
        <tr><td>\`\`\`mindmap</td><td>也可把图类型直接写成语言标记</td></tr>
        <tr><td>\`\`\`plantuml</td><td>PlantUML 图（@startuml 包裹）</td></tr>
      </table>
    </div>
  </div>`;
}

function insertSamples() {
  const samples = [
    {
      name: '公式 + 图表综合示例',
      md: `
## 公式与图表示例

二次方程求根公式：$x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}$

高斯积分：

$$\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}$$

流程图：

\`\`\`mermaid
flowchart LR
    A[输入] --> B{校验}
    B -->|通过| C[处理]
    B -->|拒绝| D[报错]
    C --> E([输出])
\`\`\`

时序图：

\`\`\`plantuml
@startuml
Alice -> Bob : 请求
Bob --> Alice : 响应
@enduml
\`\`\`
`,
    },
  ];
  S.editor.insertBlock(samples[0].md);
  toast('已插入示例', 'ok', 1500);
}

const SYNTAX_HELP = `
<!-- Markdown 语法速查 -->
# 标题一
## 标题二

**粗体** *斜体* ~~删除线~~ \`行内代码\` ==高亮== H~2~O x^2^

- 无序列表
- [ ] 待办
- [x] 已完成

1. 有序列表

> 引用

| 表头 | 表头 |
| --- | --- |
| 单元格 | 单元格 |

行内公式 $E = mc^2$，块级公式：

$$
\\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6}
$$

\`\`\`mermaid
flowchart LR
    A --> B
\`\`\`

\`\`\`plantuml
@startuml
A -> B
@enduml
\`\`\`
`;

/* ================================================================== *
 * 覆盖层 / 提示
 * ================================================================== */
function openOverlay(id) {
  $('#' + id).classList.remove('hidden');
}
function closeOverlay(id) {
  $('#' + id).classList.add('hidden');
}

function openAbout() {
  $$('#settingsTabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === 'about'));
  renderAboutPane($('#settingsBody'));
  openOverlay('settingsOverlay');
}

function busy(on, text) {
  S.busyCount += on ? 1 : -1;
  if (S.busyCount < 0) S.busyCount = 0;
  const node = $('#busy');
  node.classList.toggle('show', S.busyCount > 0);
  if (text) $('#busyText').textContent = text;
}

function toast(msg, kind = 'ok', ms = 2200) {
  const node = el('div', { class: 'toast ' + kind, text: msg });
  $('#toasts').appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s';
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 280);
  }, ms);
}

/* ================================================================== *
 * 事件绑定
 * ================================================================== */
function bindToolbar() {
  $('#toolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) handleCommand({ id: btn.dataset.cmd });
  });
  document.querySelector('.topbar').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cmd]');
    if (btn) handleCommand({ id: btn.dataset.cmd });
  });
  $$('#modeSwitch button').forEach((b) => {
    b.addEventListener('click', () => setMode(b.dataset.mode));
  });
}

function bindShell() {
  // 关闭弹层
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) closeOverlay(c.dataset.close);
    if (e.target.classList && e.target.classList.contains('overlay')) {
      e.target.classList.add('hidden');
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $$('.overlay').forEach((o) => o.classList.add('hidden'));
    }
  });

  $('#outlineClose').addEventListener('click', () => setOutline(false));
  $('#stOutline').addEventListener('click', () => setOutline(!document.body.classList.contains('outline-open')));
  $('#stTheme').addEventListener('click', () => toggleTheme(S.settings.theme === 'dark' ? 'light' : 'dark'));
  $('#settingsReset').addEventListener('click', async () => {
    const r = await mdv.dialog.message({
      type: 'question',
      message: '恢复所有设置为默认值？',
      buttons: ['恢复', '取消'],
    });
    if (r !== 0) return;
    S.settings = await mdv.settings.set({
      theme: 'light', editorFontSize: 15, previewFontSize: 16, previewFontFamily: 'system',
      lineHeight: 1.75, contentWidth: 860, editorLineNumbers: true, editorLineWrapping: true,
      spellcheck: false, tabSize: 2, syncScroll: true, renderKaTeX: true, renderMermaid: true,
      renderPlantUML: true, singleDollarMath: true, mermaidTheme: 'default', plantumlMode: 'remote',
      mindmapFontSize: 14,
      plantumlServer: 'https://www.plantuml.com/plantuml', codeHighlight: true, codeTheme: 'github',
      pdfPageSize: 'A4', pdfMargin: 18, pdfLandscape: false, pdfHeaderFooter: true, pdfPrintBackground: true,
      docxBodyFont: '等线', docxCodeFont: 'Consolas',
    });
    applySettings({});
    buildSettingsUI();
    toast('已恢复默认设置', 'ok');
  });

  // 预览区事件
  const pv = $('#preview');
  pv.addEventListener('click', (e) => {
    // 任务列表勾选 → 回写源码
    const cb = e.target.closest('input.task-list-item-checkbox');
    if (cb) {
      e.preventDefault();
      toggleTaskAtLine(cb);
      return;
    }
    // 外链、锚点
    const a = e.target.closest('a');
    if (a) {
      const href = a.getAttribute('href') || '';
      if (/^https?:/i.test(href)) {
        e.preventDefault();
        mdv.shell.openExternal(href);
        return;
      }
      if (href.startsWith('#') && a.classList.contains('header-anchor')) {
        e.preventDefault();
        const id = href.slice(1);
        const target = document.getElementById(id);
        if (target) scrollPreviewToLine(Number(target.getAttribute('data-line') || 0), { smooth: true });
      }
    }
  });

  $('#previewScroll').addEventListener('scroll', syncFromPreview, { passive: true });

  // 分栏拖动
  const splitter = $('#splitter');
  let dragging = false;
  splitter.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const ws = $('#workspace');
    const rect = ws.getBoundingClientRect();
    const outlineW = document.body.classList.contains('outline-open') ? 232 : 0;
    const ratio = (e.clientX - rect.left - outlineW) / (rect.width - outlineW);
    const pct = Math.min(0.85, Math.max(0.15, ratio));
    $('.pane.editor').style.flex = `0 0 ${(pct * 100).toFixed(2)}%`;
    $('.pane.preview').style.flex = `1 1 auto`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    layoutPreview();
  });

  // 拖拽打开文件
  const veil = $('#dropVeil');
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    dragDepth++;
    veil.classList.add('show');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) veil.classList.remove('show');
  });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    veil.classList.remove('show');
    const files = Array.from(e.dataTransfer.files || []);
    if (!files.length) return;
    const f = files.find((x) => /\.(md|markdown|mdown|mkd|txt)$/i.test(x.name)) || files[0];
    const p = mdv.file.pathForFile(f);
    if (!p) {
      toast('无法获取文件路径，请用「打开」按钮', 'warn');
      return;
    }
    if (!(await confirmDiscard())) return;
    const r = await mdv.file.openPath(p);
    if (r.ok) openContent(r.path, r.content);
    else toast('打开失败：' + r.error, 'err');
  });

  // 关闭前确认
  window.addEventListener('beforeunload', (e) => {
    if (S.forceClosing || !S.dirty) return;
    e.preventDefault();
    e.returnValue = 'unsaved';
    askCloseConfirm();
  });
}

let closeAsking = false;
async function askCloseConfirm() {
  if (closeAsking) return;
  closeAsking = true;
  const name = S.path ? S.path.split(/[\\/]/).pop() : '未命名.md';
  const r = await mdv.dialog.confirmSave(name);
  closeAsking = false;
  if (r === 0) {
    await saveFile();
    if (!S.dirty) {
      S.forceClosing = true;
      mdv.closeWindow();
    }
  } else if (r === 1) {
    S.forceClosing = true;
    mdv.closeWindow();
  }
}

function toggleTaskAtLine(cb) {
  const li = cb.closest('[data-line]');
  const lineNo = li ? Number(li.getAttribute('data-line')) : -1;
  if (lineNo < 0) return;
  const doc = S.editor.view.state.doc;
  const checked = cb.checked;
  for (let n = lineNo + 1; n <= Math.min(doc.lines, lineNo + 4); n++) {
    const line = doc.line(n);
    const m = /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/.exec(line.text);
    if (m) {
      const pos = line.from + m[1].length;
      S.editor.view.dispatch({ changes: { from: pos, to: pos + 1, insert: checked ? 'x' : ' ' } });
      return;
    }
  }
}

/* ================================================================== *
 * 启动
 * ================================================================== */
const bootPromise = boot().catch((e) => {
  console.error(e);
  document.body.innerHTML =
    `<pre style="padding:24px;font-family:monospace;color:#b91c1c">启动失败：${escapeHtml(e.message)}\n${escapeHtml(e.stack || '')}</pre>`;
  throw e;
});

/**
 * 调试 / 自测入口（仅供开发者与自动化测试使用）
 * 在 DevTools 里可以直接：__mdview.setDoc('# hi'); await __mdview.renderNow(true)
 */
window.__mdview = {
  ready: bootPromise,
  state: S,
  setDoc: (text) => S.editor.setDoc(text),
  renderNow: (immediate = true) => renderNow(immediate),
  getDoc: () => S.editor.doc,
  makeExportHtml,
  buildHtml,
  exportDocx,
  setMode,
  applySettings,
  renderer: S.renderer,
  countWords,
};
