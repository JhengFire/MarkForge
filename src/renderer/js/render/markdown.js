/**
 * Markdown 渲染管线
 *  - markdown-it + GFM 扩展（表格 / 任务列表 / 脚注 / 定义列表 / 上下标 / 标记 / 缩写 / 属性）
 *  - 公式：在 markdown 解析前把 LaTeX 抽成占位符，避免 _ ^ \ 等被 Markdown 吞掉
 *  - 图表：mermaid / plantuml 代码块转成待异步渲染的容器
 *  - 为块级元素写入 data-line，用于编辑区与预览区滚动同步
 */

import MarkdownIt from 'markdown-it';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import anchor from 'markdown-it-anchor';
import deflist from 'markdown-it-deflist';
import attrs from 'markdown-it-attrs';
import subPlugin from 'markdown-it-sub';
import supPlugin from 'markdown-it-sup';
import abbrPlugin from 'markdown-it-abbr';
import insPlugin from 'markdown-it-ins';
import markPlugin from 'markdown-it-mark';
import * as emojiPkg from 'markdown-it-emoji';

import { escapeHtml, escapeAttr, slugify, resolveLocalUrl } from '../util.js';

const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';
const RE_PH = /\uE000([MBD])(\d+)\uE001/g;
/** [TOC] / [[toc]] 占位段落（<p> 上可能被注入 data-line 等属性） */
const RE_TOC = /<p\b[^>]*>\s*\[\[?toc\]?\]\s*<\/p>/gi;

/* ================================================================== *
 * 图表代码块的语言识别
 * ================================================================== */

/**
 * Mermaid 各图类型的首行关键字。
 *
 * 支持两种写法：
 *   1) ```mermaid  + 首行写图类型（Mermaid 官方写法）
 *   2) ```mindmap / ```flowchart / ```sequenceDiagram …（语言标记即图类型）
 *
 * 第二种更贴近语雀、Typora 的使用习惯，代码块左侧的语言标签也会如实显示成
 * mindmap 而不是笼统的 mermaid。关键字区分大小写（sequenceDiagram 是 camelCase），
 * 因此用小写映射表来找回规范写法。
 */
const MERMAID_KINDS = [
  'flowchart', 'flowchart-elk', 'graph',
  'sequenceDiagram', 'classDiagram', 'classDiagram-v2',
  'stateDiagram', 'stateDiagram-v2', 'erDiagram',
  'journey', 'gantt', 'pie', 'quadrantChart', 'requirementDiagram',
  'gitGraph', 'C4Context', 'C4Container', 'C4Component', 'C4Dynamic', 'C4Deployment',
  'mindmap', 'timeline', 'zenuml',
  'sankey-beta', 'xychart-beta', 'block-beta', 'packet-beta', 'architecture-beta',
  'kanban', 'radar-beta', 'treemap-beta',
];

const MERMAID_KIND_MAP = new Map(MERMAID_KINDS.map((k) => [k.toLowerCase(), k]));

/** 语言标记 → 规范的 Mermaid 图类型关键字；不是 Mermaid 家族则返回 '' */
function mermaidKindOf(lang) {
  return MERMAID_KIND_MAP.get(String(lang || '').toLowerCase()) || '';
}

/** 去掉所有非空行的公共前导空白（代码块整体缩进时必需，否则 mindmap 的根节点会失层） */
function dedent(text) {
  const lines = String(text == null ? '' : text).split('\n');
  let min = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const n = /^[ \t]*/.exec(line)[0].length;
    if (n < min) min = n;
  }
  if (!Number.isFinite(min) || min === 0) return lines.join('\n');
  return lines.map((line) => (line.trim() ? line.slice(min) : line)).join('\n');
}

/**
 * 判断这段图表源码是否该交给自研思维导图渲染器。
 *
 * 两种来源都算：
 *   - 语言标记直接写 ```mindmap；
 *   - ```mermaid 且首行是 mindmap。
 * Mermaid 自带的 mindmap 是静态 SVG，不能折叠、样式也调不动，所以统一接管。
 */
function mindmapSyntaxOf(lang, code) {
  if (lang === 'mindmap') return 'mindmap';
  if (lang !== 'mermaid') return '';
  const first = String(code || '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('%%'));
  return first && first.toLowerCase() === 'mindmap' ? 'mindmap' : '';
}

/**
 * 把「```mindmap」这类语言标记规范成 Mermaid 可解析的源码。
 *
 * mindmap 的层级完全靠缩进表达，所以这里做两件事：
 *   - 去掉整体缩进，保证根节点顶格；
 *   - 若首行没写图类型，补上（用户只写节点树时也能渲染）。
 * 首行已经写了类型时原样保留，避免出现两个 `mindmap` 关键字。
 */
function normalizeMermaidSource(lang, code) {
  const kind = mermaidKindOf(lang);
  const body = dedent(String(code == null ? '' : code).replace(/^\uFEFF/, ''));
  if (!kind) return body;
  const firstLine = (body.split('\n').find((line) => line.trim() !== '') || '').trim();
  if (firstLine.toLowerCase() === kind.toLowerCase()) return body;
  return kind + '\n' + body;
}


/* ================================================================== *
 * 公式抽取
 * ================================================================== */

function matchInlineDollar(src, i) {
  const n = src.length;
  if (src[i + 1] === '$') return null;
  const first = src[i + 1];
  if (first == null || /\s/.test(first)) return null;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '\n') return null;
    if (ch === '$') {
      const content = src.slice(i + 1, j);
      if (!content || /\s$/.test(content)) return null;
      const next = src[j + 1];
      if (next != null && /\d/.test(next)) return null;
      return { tex: content, end: j + 1 };
    }
    j++;
  }
  return null;
}

/**
 * 抽出 LaTeX，返回 { text, items }
 * items: [{ tex, block }]
 * 行内 → \uE000M{idx}\uE001，块级 → \uE000B{idx}\uE001
 */
export function extractMath(src, opts = {}) {
  const singleDollar = opts.singleDollar !== false;
  const items = [];
  let out = '';
  let i = 0;
  const n = src.length;
  let fence = null;

  const push = (tex, block) => {
    const idx = items.length;
    items.push({ tex, block });
    return PH_OPEN + (block ? 'B' : 'M') + idx + PH_CLOSE;
  };

  while (i < n) {
    const atLineStart = i === 0 || src[i - 1] === '\n';

    if (atLineStart) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(src.slice(i, i + 200));
      if (m) {
        const marker = m[1];
        if (!fence) fence = { ch: marker[0], len: marker.length };
        else if (marker[0] === fence.ch && marker.length >= fence.len) fence = null;

        // 围栏分隔行必须整行原样拷贝后跳过。
        // 否则这行的反引号会落进下面的「行内代码」分支，把闭合栅栏与下一段的
        // 起始栅栏一起吞掉，导致 fence 状态整体错位 —— 文档后半段会被误判成
        // 代码块，其中的 $...$ 公式全部不会被抽取。
        const fenceEol = src.indexOf('\n', i);
        const fenceEnd = fenceEol === -1 ? n : fenceEol + 1;
        out += src.slice(i, fenceEnd);
        i = fenceEnd;
        continue;
      }
    }

    if (fence) {
      const eol = src.indexOf('\n', i);
      const end = eol === -1 ? n : eol + 1;
      out += src.slice(i, end);
      i = end;
      continue;
    }

    const c = src[i];

    // 行内代码：整段跳过
    if (c === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const ticks = src.slice(i, k);
      const close = src.indexOf(ticks, k);
      if (close !== -1) {
        out += src.slice(i, close + ticks.length);
        i = close + ticks.length;
        continue;
      }
      out += ticks;
      i = k;
      continue;
    }

    // 块级公式
    if (c === '$' && src[i + 1] === '$') {
      const close = src.indexOf('$$', i + 2);
      if (close !== -1) {
        out += push(src.slice(i + 2, close), true);
        i = close + 2;
        continue;
      }
    }
    if (c === '\\' && src[i + 1] === '[') {
      const close = src.indexOf('\\]', i + 2);
      if (close !== -1) {
        out += push(src.slice(i + 2, close), true);
        i = close + 2;
        continue;
      }
    }

    // 行内公式
    if (singleDollar && c === '$') {
      const m = matchInlineDollar(src, i);
      if (m) {
        out += push(m.tex, false);
        i = m.end;
        continue;
      }
    }
    if (c === '\\' && src[i + 1] === '(') {
      const close = src.indexOf('\\)', i + 2);
      if (close !== -1) {
        out += push(src.slice(i + 2, close), false);
        i = close + 2;
        continue;
      }
    }

    // 分页符标记
    if (atLineStart && (src.startsWith('\\pagebreak', i) || src.startsWith('<!-- pagebreak -->', i))) {
      const token = src.startsWith('\\pagebreak', i) ? '\\pagebreak' : '<!-- pagebreak -->';
      const after = src.slice(i + token.length);
      if (after === '' || /^[ \t]*\r?\n/.test(after)) {
        out += '<div class="page-break"></div>';
        i += token.length;
        continue;
      }
    }

    out += c;
    i++;
  }

  return { text: out, items };
}

/* ================================================================== *
 * 目录 / 提示框
 * ================================================================== */

function buildTocHtml(headings) {
  const list = headings.filter((h) => h.level >= 1 && h.level <= 6);
  if (!list.length) return '<p>（没有可用于生成目录的标题）</p>';
  const rows = list
    .map(
      (h) =>
        `<li class="lv-${h.level}"><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`
    )
    .join('');
  return `<div class="mdv-toc"><div class="mdv-toc-title">目录</div><ul>${rows}</ul></div>`;
}

const ALERT_TYPES = {
  NOTE: '提示',
  TIP: '技巧',
  IMPORTANT: '重要',
  WARNING: '注意',
  CAUTION: '警告',
  INFO: '信息',
};

/* ================================================================== *
 * 主渲染器
 * ================================================================== */

export class MarkdownRenderer {
  constructor() {
    this.md = this.create();
  }

  create() {
    const md = new MarkdownIt({
      html: true,
      linkify: true,
      breaks: false,
      typographer: false,
      xhtmlOut: false,
      langPrefix: 'language-',
      highlight: null, // 由 fence 规则自定义
    });

    md.use(footnote);
    md.use(taskLists, { enabled: true, label: false, labelAfter: true });
    md.use(deflist);
    md.use(attrs, { allowedAttributes: [] });
    md.use(subPlugin);
    md.use(supPlugin);
    md.use(abbrPlugin);
    md.use(insPlugin);
    md.use(markPlugin);
    // markdown-it-emoji v3 是纯 ESM 包，没有 default 导出，
    // 直接用命名空间上的 full / light 即可。
    const emojiFull = emojiPkg.full || emojiPkg.light;
    if (typeof emojiFull === 'function') md.use(emojiFull);

    // 标题锚点
    md.use(anchor, {
      level: [1, 2, 3, 4, 5, 6],
      slugify,
      permalink: anchor.permalink.linkInsideHeader({
        symbol: '#',
        class: 'header-anchor',
        placement: 'before',
        ariaHidden: true,
      }),
      getTokensText: (tokens) => tokens.map((t) => t.content).join(''),
    });

    // 允许一切链接（本地图片需要 file: / 绝对路径）
    md.validateLink = () => true;

    // 行内代码：补充样式类
    md.renderer.rules.code_inline = (tokens, idx) => {
      const cls = tokens[idx].attrs && tokens[idx].attrGet('class');
      return `<code${cls ? ` class="${escapeAttr(cls)}"` : ''}>${escapeHtml(tokens[idx].content)}</code>`;
    };

    // 图片：解析本地路径
    md.renderer.rules.image = (tokens, idx, options, env) => {
      const token = tokens[idx];
      const src = token.attrGet('src') || '';
      const resolved = resolveLocalUrl(src, env.baseDir);
      if (env.images && src) env.images[src] = { src, resolved };
      token.attrSet('src', resolved);
      token.attrSet('loading', 'lazy');
      const alt = token.content || '';
      let html = md.renderer.renderToken(tokens, idx, options);
      if (alt && !token.attrGet('title')) html = html.replace('>', ` alt="${escapeAttr(alt)}">`);
      return html;
    };

    // hr：带 data-line
    md.renderer.rules.hr = (tokens, idx) => {
      const line = tokens[idx].map ? tokens[idx].map[0] : 0;
      return `<hr data-line="${line}">\n`;
    };

    // 代码块 / 图表
    md.renderer.rules.fence = (tokens, idx, options, env) => this.renderFence(tokens[idx], env);
    md.renderer.rules.code_block = (tokens, idx, options, env) => {
      const t = tokens[idx];
      const line = t.map ? t.map[0] : 0;
      const code = env.highlight && window.hljs
        ? window.hljs.highlightAuto(t.content).value
        : escapeHtml(t.content);
      return `<pre data-line="${line}"><code class="hljs">${code}</code></pre>\n`;
    };

    // 为块级元素注入 data-line（滚动同步）
    md.core.ruler.push('mdv_lineattr', (state) => {
      for (const t of state.tokens) {
        if (!t.map) continue;
        if (t.nesting === 1 || t.type === 'fence' || t.type === 'code_block' || t.type === 'hr') {
          if (t.attrGet('data-line') == null) t.attrSet('data-line', String(t.map[0]));
        }
      }
      return true;
    });

    // 收集标题（用于目录与大纲）+ 处理 GitHub 风格提示框 + 登记图表
    md.core.ruler.push('mdv_collect', (state) => {
      const env = state.env;
      env.headings = env.headings || [];
      env.diagrams = env.diagrams || [];
      for (let i = 0; i < state.tokens.length; i++) {
        const t = state.tokens[i];

        // 图表代码块登记（解析期完成，保证与渲染顺序一致）
        if (t.type === 'fence' || t.type === 'code_block') {
          const lang = ((t.info || '').trim().split(/\s+/)[0] || '').toLowerCase();
          const isMermaid = lang === 'mermaid' || !!mermaidKindOf(lang);
          const isPlant = lang === 'plantuml' || lang === 'puml';
          const allow = isMermaid ? env.renderMermaid : env.renderPlantUML;
          if ((isMermaid || isPlant) && allow !== false) {
            const kind = isMermaid ? 'mermaid' : 'plantuml';
            const di = env.diagrams.length;
            const code = isMermaid
              ? normalizeMermaidSource(lang === 'mermaid' ? '' : lang, t.content)
              : t.content.replace(/\s+$/, '');
            const syntax = isMermaid ? mindmapSyntaxOf(lang, code) : '';
            env.diagrams.push({ kind, code, index: di, syntax });
            t.meta = { ...(t.meta || {}), diagramIndex: di, kind, syntax };
          }
        }

        if (t.type === 'heading_open') {
          const inline = state.tokens[i + 1];
          const text = inline ? inline.content.replace(/\s*#\s*$/, '') : '';
          env.headings.push({
            level: Number(String(t.tag).replace(/\D/g, '')) || 1,
            text,
            line: t.map ? t.map[0] : 0,
            id: '',
          });
        }
        // 提示框：[!NOTE] 等
        if (t.type === 'blockquote_open') {
          const p = state.tokens[i + 1];
          if (p && p.type === 'paragraph_open') {
            const inline = state.tokens[i + 2];
            const first = inline && inline.children && inline.children[0];
            if (first && first.type === 'text') {
              const m = /^\[!(\w+)\]\s*/.exec(first.content);
              if (m && ALERT_TYPES[m[1].toUpperCase()]) {
                const label = ALERT_TYPES[m[1].toUpperCase()];
                first.content = first.content.slice(m[0].length);
                t.attrJoin('class', 'mdv-alert');
                p.meta = { alertTitle: label };
                inline.children.unshift({ type: 'html_inline', content: `<div class="mdv-alert-title">${label}</div>` });
              }
            }
          }
        }
      }
      return true;
    });

    return md;
  }

  /** 图表代码块（mermaid 家族 / plantuml） */
  renderFence(token, env) {
    const info = (token.info || '').trim();
    const lang = (info.split(/\s+/)[0] || '').toLowerCase();
    const line = token.map ? token.map[0] : 0;

    if (token.meta && token.meta.diagramIndex != null) {
      const kind =
        token.meta.kind || (lang === 'mermaid' || mermaidKindOf(lang) ? 'mermaid' : 'plantuml');
      const di = token.meta.diagramIndex;
      const syntax = token.meta.syntax || '';
      // 供 Word 导出定位栅格化结果
      token.info = 'mdview-diagram';
      token.content = PH_OPEN + 'D' + di + PH_CLOSE;
      return (
        `<div class="diagram${syntax === 'mindmap' ? ' diagram-mindmap' : ''}" data-diagram="${di}"` +
        ` data-kind="${kind}"${syntax ? ` data-syntax="${syntax}"` : ''} data-line="${line}">` +
        `<div class="diagram-loading">正在渲染 ${
          syntax === 'mindmap' ? '思维导图' : kind === 'mermaid' ? 'Mermaid' : 'PlantUML'
        }…</div>` +
        `</div>\n`
      );
    }

    // 未登记（例如对应的渲染开关被关闭）→ 按普通代码块输出

    const codeHtml =
      env.highlight && window.hljs
        ? (() => {
            try {
              if (lang && window.hljs.getLanguage(lang)) {
                return window.hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value;
              }
              return lang ? escapeHtml(token.content) : window.hljs.highlightAuto(token.content).value;
            } catch {
              return escapeHtml(token.content);
            }
          })()
        : escapeHtml(token.content);

    const titleCls = lang ? ' class="code-with-title"' : '';
    return (
      `<pre${titleCls}${lang ? ` data-lang="${escapeAttr(lang)}"` : ''} data-line="${line}">` +
      `<code class="hljs${lang ? ' language-' + escapeAttr(lang) : ''}">${codeHtml}</code></pre>\n`
    );
  }

  /**
   * 渲染
   * @param {string} src
   * @param {object} options { baseDir, highlight, singleDollar, katex }
   * @returns {{ html:string, env:object }}
   */
  render(src, options = {}) {
    const env = {
      baseDir: options.baseDir || '',
      highlight: options.highlight !== false,
      renderMermaid: options.renderMermaid !== false,
      renderPlantUML: options.renderPlantUML !== false,
      docId: options.docId || 'doc' + Math.random().toString(36).slice(2, 8),
      headings: [],
      diagrams: [],
      math: [],
      images: {},
      links: [],
      stats: null,
    };

    const extracted = extractMath(src, { singleDollar: options.singleDollar !== false });
    env.math = extracted.items;

    let html = this.md.render(extracted.text, env);

    // 标题 id 回填（anchor 插件写在 token 上，渲染后从 DOM 里取更可靠）
    html = this.postProcess(html, env, options);

    env.stats = { headings: env.headings.length, diagrams: env.diagrams.length, math: env.math.length };
    return { html, env };
  }

  /** 渲染后的收尾：公式、目录、外链 */
  postProcess(html, env, options) {
    const md = this.md;
    const useKatex = options.katex !== false;

    const renderOne = (item) => {
      const tex = (item.tex || '').trim();
      if (!useKatex || !window.katex) {
        return `<span class="math-error">LaTeX 未启用：${escapeHtml(tex)}</span>`;
      }
      try {
        return window.katex.renderToString(tex, {
          displayMode: !!item.block,
          throwOnError: false,
          errorColor: '#c0392b',
          strict: 'ignore',
          trust: false,
          macros: { '\\RR': '\\mathbb{R}', '\\NN': '\\mathbb{N}', '\\ZZ': '\\mathbb{Z}' },
        });
      } catch (e) {
        return `<span class="math-error">${escapeHtml(tex)}<br>${escapeHtml(e.message)}</span>`;
      }
    };

    // 块级公式独立成段 → 解包 <p>
    html = html.replace(
      new RegExp('<p>\\s*' + PH_OPEN + 'B(\\d+)' + PH_CLOSE + '\\s*</p>', 'g'),
      (m, i) => {
        const item = env.math[Number(i)];
        if (!item) return m;
        return `<div class="math-block" data-math="${i}" data-display="1">${renderOne(item)}</div>`;
      }
    );
    html = html.replace(new RegExp(PH_OPEN + 'M(\\d+)' + PH_CLOSE, 'g'), (m, i) => {
      const item = env.math[Number(i)];
      if (!item) return m;
      return `<span class="math-inline" data-math="${i}">${renderOne(item)}</span>`;
    });
    html = html.replace(new RegExp(PH_OPEN + 'B(\\d+)' + PH_CLOSE, 'g'), (m, i) => {
      const item = env.math[Number(i)];
      if (!item) return m;
      return `<span class="math-block" data-math="${i}" data-display="1" style="display:block">${renderOne(item)}</span>`;
    });

    // 目录占位（<p> 上可能带 data-line 等属性，必须容忍）
    html = html.replace(RE_TOC, () => buildTocHtml(env.headings));

    // 外链加标记（供主进程/导出时决定是否新窗口）
    html = html.replace(/<a href="(https?:[^"]*)"/g, '<a href="$1" data-external="1"');

    return html;
  }
}

export { buildTocHtml, PH_OPEN, PH_CLOSE, RE_PH };
