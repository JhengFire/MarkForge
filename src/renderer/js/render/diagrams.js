/**
 * 图表渲染：Mermaid（本地 JS）与 PlantUML（本地 Java / 远程服务）
 */

import { renderMindmap } from './mindmap.js';

const DIAGRAM_CACHE = new Map();
let mermaidReady = false;
let mermaidTheme = '';

const MERMAID_THEMES = new Set(['default', 'base', 'dark', 'forest', 'neutral', 'null']);

/**
 * 思维导图字体：设置里的 previewFontFamily 是「system / serif」这种枚举，
 * 不能直接当 font-family 用（"system" 不是字体名），这里映射成真正的字体栈，
 * 与 preview.css 的 --font-body / --font-serif 保持一致。
 */
const MINDMAP_FONTS = {
  serif: 'Georgia, "Times New Roman", "Songti SC", "SimSun", serif',
  system:
    '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", -apple-system, sans-serif',
};

function getMermaid() {
  return typeof window !== 'undefined' ? window.mermaid : null;
}

export function initMermaid(theme = 'default', fontFamily = '') {
  const m = getMermaid();
  if (!m) return false;
  const t = MERMAID_THEMES.has(theme) ? theme : 'default';
  if (mermaidReady && mermaidTheme === t) return true;
  try {
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: t,
      fontFamily: fontFamily || '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
      fontSize: 15,
      flowchart: { useMaxWidth: false, htmlLabels: false, curve: 'basis' },
      sequence: { useMaxWidth: false, wrap: true, width: 180 },
      gantt: { useMaxWidth: false },
      class: { useMaxWidth: false },
      state: { useMaxWidth: false },
      er: { useMaxWidth: false },
      journey: { useMaxWidth: false },
      pie: { useMaxWidth: false },
      gitGraph: { useMaxWidth: false },
      mindmap: { useMaxWidth: false },
      timeline: { useMaxWidth: false },
      suppressErrorRendering: true,
      logLevel: 'fatal',
    });
    mermaidReady = true;
    mermaidTheme = t;
    return true;
  } catch (e) {
    console.error('mermaid initialize failed', e);
    return false;
  }
}

let mermaidSeq = 0;

export async function renderMermaid(code, theme = 'default') {
  initMermaid(theme);
  const m = getMermaid();
  if (!m) throw new Error('Mermaid 未加载');
  const key = 'm:' + theme + ':' + code;
  if (DIAGRAM_CACHE.has(key)) return DIAGRAM_CACHE.get(key);
  const id = 'mmd-' + ++mermaidSeq + '-' + Math.random().toString(36).slice(2, 7);
  try {
    const out = await m.render(id, code);
    const svg = typeof out === 'string' ? out : out && out.svg;
    if (!svg) throw new Error('Mermaid 未返回结果');
    DIAGRAM_CACHE.set(key, svg);
    return svg;
  } catch (e) {
    // mermaid 出错时可能残留在 body 里的临时节点
    try {
      const leftover = document.getElementById('d' + id) || document.getElementById(id);
      if (leftover && leftover.parentNode) leftover.parentNode.removeChild(leftover);
    } catch {
      /* ignore */
    }
    throw new Error(cleanErr(e));
  }
}

function cleanErr(e) {
  const msg = String((e && (e.str || e.message)) || e || '未知错误');
  return msg.replace(/^\s*Error:\s*/i, '').trim();
}

export async function renderPlantUML(code, { mode = 'remote', server } = {}) {
  const key = 'p:' + mode + ':' + (server || '') + ':' + code;
  if (DIAGRAM_CACHE.has(key)) return DIAGRAM_CACHE.get(key);
  const res = await window.mdv.plantuml.render({ source: code, mode, server });
  if (!res || !res.ok) throw new Error((res && res.error) || 'PlantUML 渲染失败');
  DIAGRAM_CACHE.set(key, res.svg);
  return res.svg;
}

export function clearDiagramCache() {
  DIAGRAM_CACHE.clear();
}

/**
 * 渲染一个 .diagram 容器
 * @param {HTMLElement} node  data-kind / data-diagram
 * @param {string} code       图表源码
 * @param {object} settings   { mermaidTheme, plantumlMode, plantumlServer }
 */
export async function renderDiagramNode(node, code, settings = {}) {
  const kind = node.getAttribute('data-kind');
  const syntax = node.getAttribute('data-syntax');
  if (code == null) {
    node.innerHTML = '<div class="diagram-error">图表源代码丢失</div>';
    return;
  }

  // 思维导图走自研渲染器：可折叠、层级配色、纯 SVG（导出栅格化最稳）。
  // Mermaid 的 mindmap 是静态图，做不到折叠，节点一多必然糊成一片。
  if (syntax === 'mindmap') {
    const started = performance.now();
    try {
      // 先清掉 loading 占位，避免布局测量被它干扰
      node.innerHTML = '';
      renderMindmap(node, code, {
        fontFamily: MINDMAP_FONTS[settings.previewFontFamily] || MINDMAP_FONTS.system,
        fontSize: Number(settings.mindmapFontSize) || 14,
      });
      node.dataset.rendered = '1';
      node.dataset.renderMs = String(Math.round(performance.now() - started));
    } catch (e) {
      node.innerHTML = `<div class="diagram-error">${escapeHtml(cleanErr(e))}</div>`;
      node.dataset.rendered = 'error';
    }
    return;
  }

  node.innerHTML = `<div class="diagram-loading">正在渲染 ${kind === 'mermaid' ? 'Mermaid' : 'PlantUML'} 图…</div>`;
  const started = performance.now();
  try {
    const svg =
      kind === 'mermaid'
        ? await renderMermaid(code, settings.mermaidTheme || 'default')
        : await renderPlantUML(code, { mode: settings.plantumlMode, server: settings.plantumlServer });
    node.innerHTML = svg;
    const svgEl = node.querySelector('svg');
    if (svgEl) {
      svgEl.style.maxWidth = '100%';
      svgEl.style.height = 'auto';
      svgEl.removeAttribute('height');
      svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    }
    node.dataset.rendered = '1';
    node.dataset.renderMs = String(Math.round(performance.now() - started));
  } catch (e) {
    node.innerHTML = `<div class="diagram-error">${escapeHtml(cleanErr(e))}</div>`;
    node.dataset.rendered = 'error';
  }
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
