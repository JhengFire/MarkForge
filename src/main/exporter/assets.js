'use strict';

/**
 * 导出资源装配：
 *  - 把 KaTeX CSS 里的字体内联成 base64，保证导出的 HTML / PDF 完全离线自包含
 *  - 内联本地图片
 *  - 组装最终单文件 HTML
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { vendor, renderer, exists } = require('../paths');

const cache = new Map();
const cached = (key, fn) => {
  if (!cache.has(key)) cache.set(key, fn());
  return cache.get(key);
};

function readCss(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};

/** KaTeX 样式 + 字体内联（结果缓存） */
function katexCss() {
  return cached('katex', () => {
    const cssPath = vendor('katex', 'katex.min.css');
    let css = readCss(cssPath);
    if (!css) return '';
    const fontsDir = vendor('katex', 'fonts');
    // 仅保留 woff2 并转 base64，其余格式（woff/ttf）丢弃以减小体积
    css = css.replace(/src\s*:\s*([^;}]+)/g, (m, list) => {
      const parts = list
        .split(',')
        .map((s) => s.trim())
        .map((s) => {
          const mm = /url\(\s*(['"]?)fonts\/([^'")]+)\1\s*\)/.exec(s);
          if (!mm) return null;
          const file = mm[2];
          if (!/\.woff2$/i.test(file)) return null;
          const p = path.join(fontsDir, file);
          if (!exists(p)) return null;
          const b64 = fs.readFileSync(p).toString('base64');
          return `url(data:font/woff2;base64,${b64}) format("woff2")`;
        })
        .filter(Boolean);
      return parts.length ? 'src:' + parts.join(',') : 'src:none';
    });
    return css;
  });
}

/** 代码高亮主题样式 */
function hljsCss(theme = 'github') {
  return cached('hljs:' + theme, () => {
    const name = /^[\w-]+$/.test(theme) ? theme : 'github';
    return readCss(vendor('highlight', 'styles', `${name}.min.css`));
  });
}

/** 文档正文样式（预览与导出共用） */
function previewCss() {
  return cached('preview', () => readCss(renderer('styles', 'preview.css')));
}

/** 打印/PDF 专用补充样式（分页控制等） */
function printCss() {
  return cached('print', () => readCss(renderer('styles', 'print.css')));
}

/**
 * 把 HTML 中引用的本地图片替换成 base64，保证导出文件自包含。
 * 只处理相对路径与 file:// 的图片，跳过 http(s)/data。
 */
function inlineLocalImages(html, baseDir) {
  if (!html || !baseDir) return html;
  return html.replace(/(<img\b[^>]*?\bsrc=)(["'])(.*?)\2/gi, (m, pre, q, src) => {
    const s = String(src).trim();
    if (!s || /^(https?:|data:|blob:)/i.test(s)) return m;
    let p = s;
    if (s.startsWith('file://')) {
      try {
        p = decodeURIComponent(new URL(s).pathname).replace(/^\/([A-Za-z]:)/, '$1');
      } catch {
        return m;
      }
    } else if (!path.isAbsolute(s)) {
      p = path.resolve(baseDir, s);
    }
    try {
      if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return m;
      const ext = path.extname(p).toLowerCase();
      const mime = MIME[ext] || 'application/octet-stream';
      const b64 = fs.readFileSync(p).toString('base64');
      return `${pre}${q}data:${mime};base64,${b64}${q}`;
    } catch {
      return m;
    }
  });
}

/**
 * 组装单文件 HTML。
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.bodyHtml   预览区渲染完成的 HTML
 * @param {string} [o.baseDir]  图片相对路径基准目录
 * @param {string} [o.theme]    light | dark
 * @param {object} [o.meta]     文档元信息（作者/日期/自定义 CSS/页宽等）
 */
function buildStandaloneHtml(o = {}) {
  const meta = o.meta || {};
  const theme = o.theme === 'dark' ? 'dark' : 'light';
  const body = inlineLocalImages(o.bodyHtml || '', o.baseDir);
  const parts = [];
  parts.push('<!DOCTYPE html>');
  parts.push('<html lang="zh-CN" data-theme="' + theme + '">');
  parts.push('<head>');
  parts.push('<meta charset="utf-8">');
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
  parts.push('<meta name="generator" content="MarkForge">');
  parts.push(`<title>${escapeHtml(o.title || '未命名文档')}</title>`);
  if (meta.author) parts.push(`<meta name="author" content="${escapeHtml(meta.author)}">`);
  parts.push('<style>');
  parts.push(previewCss());
  parts.push(katexCss());
  if (meta.codeHighlight !== false) parts.push(hljsCss(meta.codeTheme || 'github'));
  if (meta.contentWidth) {
    parts.push(`.markdown-body{max-width:${Number(meta.contentWidth) || 860}px}`);
  }
  if (meta.extraCss) parts.push(String(meta.extraCss));
  parts.push('</style>');
  parts.push('<style>@media print{@page{size:' +
    (meta.pageSize || 'A4') + (meta.landscape ? ' landscape' : '') +
    ';margin:' + (Number(meta.margin) || 18) + 'mm}}' +
    'body{background:var(--bg)} .markdown-body{margin:0 auto;padding:24px}' +
    '</style>');
  // print.css 必须包在 <style> 里。否则它会被 HTML 解析器当作 <head> 中的裸文本，
  // 进而被推到 <body>，使文件开头的 CSS 注释（/* ... */）直接显示在页面顶部。
  parts.push('<style>');
  parts.push(printCss());
  parts.push('</style>');
  parts.push('</head>');
  parts.push('<body class="export-body">');
  parts.push('<article class="markdown-body" id="content">');
  parts.push(body);
  parts.push('</article>');
  parts.push('</body></html>');
  return parts.join('\n');
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 把 HTML 写入临时文件，返回路径（用于 PDF / 打印） */
function writeTempHtml(html, tag = 'mdview') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), tag + '-'));
  const file = path.join(dir, 'document.html');
  fs.writeFileSync(file, html, 'utf8');
  return { file, dir };
}

function cleanupTemp(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

module.exports = {
  buildStandaloneHtml,
  inlineLocalImages,
  writeTempHtml,
  cleanupTemp,
  katexCss,
  hljsCss,
  previewCss,
  printCss,
  escapeHtml,
};
