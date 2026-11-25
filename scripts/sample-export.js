'use strict';

/**
 * 用真实渲染管线把 test/sample.md 导出成单文件 HTML，方便离线核对排版。
 *
 * 与「在应用里导出 HTML」走的是同一条路径（同一份 markdown 管线 + assets.js 组装），
 * 区别只是：这里没有浏览器，Mermaid / PlantUML 图无法现场渲染，会被替换成说明块。
 *
 * 用法：node scripts/sample-export.js
 * 产物：.tmp/sample.html
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const tmp = path.join(root, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

/* 1) 打包渲染层，并在 Node 里挂上 KaTeX 全局 */
const bundled = path.join(tmp, 'markdown.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'js', 'render', 'markdown.js')],
  outfile: bundled,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
  charset: 'utf8',
});

global.window = global;
global.window.katex = require('katex');

const { MarkdownRenderer } = require(bundled);
const assets = require(path.join(root, 'src', 'main', 'exporter', 'assets.js'));

/* 2) 渲染 Markdown */
const src = fs.readFileSync(path.join(root, 'test', 'sample.md'), 'utf8');
const renderer = new MarkdownRenderer();
const { html, env } = renderer.render(src, {
  baseDir: root,
  highlight: true,
  singleDollar: true,
  katex: true,
  renderMermaid: true,
  renderPlantUML: true,
  docId: 'sample',
});

/* 3) 离线环境渲染不了图表，替换成说明块，避免满屏「正在渲染…」 */
let body = html.replace(
  /<div class="diagram"[^>]*>[\s\S]*?<\/div><\/div>/g,
  '<div class="mdv-offline-note">⬚ Mermaid / PlantUML 图 —— 需要在应用内渲染，本离线示例未包含</div>'
);

const extraCss = `
.mdv-offline-note{margin:1.1em 0;padding:14px 16px;border:1px dashed var(--border);
  border-radius:8px;background:var(--code-bg);color:var(--muted);font-size:.9em;text-align:center}
`;

/* 4) 组装单文件 HTML（CSS / KaTeX 字体 / 图片全部内联） */
const out = assets.buildStandaloneHtml({
  title: 'MDView 渲染示例',
  bodyHtml: body,
  baseDir: root,
  theme: 'light',
  meta: {
    author: 'MDView',
    codeHighlight: true,
    codeTheme: 'github',
    contentWidth: 860,
    pageSize: 'A4',
    margin: 18,
    extraCss,
  },
});

const file = path.join(tmp, 'sample.html');
fs.writeFileSync(file, out, 'utf8');

console.log('已生成：' + file);
console.log(
  `公式 ${env.stats.math} 个 · 图表 ${env.stats.diagrams} 个 · 标题 ${env.stats.headings} 个 · ${(out.length / 1024).toFixed(0)} KB`
);
