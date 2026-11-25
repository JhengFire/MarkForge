'use strict';

/**
 * 离线管线测试（不需要 Electron / 不需要 GUI）
 *
 * 1) 用 esbuild 把渲染层的 markdown.js 打成 CJS，在 Node 里跑完整渲染管线
 * 2) 校验公式抽取 / KaTeX 渲染 / 目录 / 图表占位
 * 3) 用真实 token 树喂给 docx 导出器并真正打包，解剖 word/document.xml
 *    校验公式是否都变成图片、代码块排版是否到位
 *
 * 用法：node test/offline.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const JSZip = require('jszip');

const root = path.resolve(__dirname, '..');
const tmpDir = path.join(root, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const SAMPLE = fs.readFileSync(path.join(root, 'test', 'sample.md'), 'utf8');

let pass = 0;
let fail = 0;
const lines = [];
function T(name, ok, extra) {
  if (ok) pass++;
  else fail++;
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  →  ' + extra : ''}`);
}
function section(title) {
  lines.push('');
  lines.push(`──────── ${title} ────────`);
}

/* ---------- 打包渲染层 ---------- */
const outMarkdown = path.join(tmpDir, 'markdown.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'js', 'render', 'markdown.js')],
  outfile: outMarkdown,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
  charset: 'utf8',
});

global.window = global;
const katex = require('katex');
global.window.katex = katex;

const { MarkdownRenderer, extractMath } = require(outMarkdown);

/* ---------- 1) 渲染管线 ---------- */
section('渲染管线（离线）');

const renderer = new MarkdownRenderer();
const out = renderer.render(SAMPLE, {
  baseDir: root,
  highlight: true,
  singleDollar: true,
  katex: true,
  renderMermaid: true,
  renderPlantUML: true,
  docId: 'offline',
});
const html = out.html;
const env = out.env;

T('抽取到的公式数 > 0', env.math.length > 0, env.math.length + ' 条');
T('行内公式元素 ≥ 3', (html.match(/class="math-inline"/g) || []).length >= 3,
  (html.match(/class="math-inline"/g) || []).length + ' 个');
T('块级公式元素 ≥ 3', (html.match(/class="math-block"/g) || []).length >= 3,
  (html.match(/class="math-block"/g) || []).length + ' 个');
T('KaTeX 已渲染', html.indexOf('class="katex"') !== -1);
T('无 math-error', html.indexOf('math-error') === -1);
T('无占位符残留', html.indexOf('\uE000') === -1 && html.indexOf('\uE001') === -1);

// KaTeX 会把 TeX 源码放进 MathML 的 <annotation>，行内代码里的 $ 也应当保持原样，
// 这两类都正常，先剔除再检查是否还有「本该渲染却没渲染」的裸 LaTeX。
const htmlNoAnn = html
  .replace(/<annotation\b[^>]*>[\s\S]*?<\/annotation>/gi, '')
  .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, '')
  .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, '');
T('无裸 LaTeX 残留', !/\\frac|\$\$|\\begin\{|\$[a-zA-Z]/.test(htmlNoAnn),
  (htmlNoAnn.match(/\\frac|\$\$|\\begin\{|\$[a-zA-Z]/g) || []).slice(0, 5).join(' '));

T('目录已展开', html.indexOf('mdv-toc') !== -1);
T('Mermaid 容器 ≥ 4', (html.match(/data-kind="mermaid"/g) || []).length >= 4,
  (html.match(/data-kind="mermaid"/g) || []).length + ' 个');
T('PlantUML 容器 ≥ 1', (html.match(/data-kind="plantuml"/g) || []).length >= 1);

const ids = [];
for (const m of html.matchAll(/data-math="(\d+)"/g)) ids.push(Number(m[1]));
const uniq = [...new Set(ids)].sort((a, b) => a - b);
T('data-math 编号与公式数一致', uniq.length === env.math.length, `${uniq.length} vs ${env.math.length}`);
T('公式编号从 0 连续', uniq.every((v, i) => v === i), uniq.slice(0, 12).join(','));

/* ---------- 2) docx 管线 ---------- */
const { DocxBuilder } = require('./docx-entry.js');

// 用 1x1 PNG 占位，专门验证「占位符 → 图片」的接线
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function packDoc(markdownSrc, mathMap) {
  const ex = extractMath(markdownSrc, { singleDollar: true });
  const e2 = { baseDir: root, docId: 'docx', headings: [], diagrams: [], math: ex.items, images: {}, renderMermaid: true, renderPlantUML: true };
  const r = new MarkdownRenderer();
  const tokens = r.md.parse(ex.text, e2);
  const builder = new DocxBuilder({
    tokens,
    meta: { title: 'offline', bodyFont: '等线', codeFont: 'Consolas', fontSize: 21 },
    images: {},
    math: mathMap || {},
    diagrams: {},
    baseDir: root,
  });
  const { buffer, warnings } = await builder.toBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');
  const media = Object.keys(zip.files).filter((f) => f.startsWith('word/media/'));
  return { buffer, xml, media, warnings, builder, count: ex.items.length };
}

section('Word 导出：公式');

async function main() {
const allMath = {};
extractMath(SAMPLE, { singleDollar: true }).items.forEach((it, i) => {
  allMath[i] = { dataUrl: PNG_1x1, width: 120, height: 40 };
});
const doc = await packDoc(SAMPLE, allMath);
fs.writeFileSync(path.join(tmpDir, 'offline.docx'), doc.buffer);

T('docx 已打包', doc.buffer.length > 8000, doc.buffer.length + ' 字节');
// 注意：docx 会按内容去重，相同的图片只落一份 media。
// 所以判断「公式是否都嵌入」要看 <w:drawing> 的数量，而不是 media 文件数。
const drawings = (doc.xml.match(/<w:drawing>/g) || []).length;
T('公式全部落成图片', drawings >= doc.count, `${drawings} 张 drawing / 共 ${doc.count} 条公式`);
T('图片资源已写入包内', doc.media.length >= 1, doc.media.length + ' 个 media（去重后）');
T('正文无占位符残留', doc.xml.indexOf('\uE000') === -1);
T('公式以图片形式嵌入', /<w:drawing>/.test(doc.xml));

// 缺图时必须给可读提示，而不是把私有区字符塞进正文
const docNoMath = await packDoc(SAMPLE, {});
T('缺图时给出可读占位', docNoMath.xml.indexOf('\uE000') === -1 && docNoMath.xml.indexOf('公式') !== -1);
T('缺图时有 warning', docNoMath.warnings.length > 0, docNoMath.warnings.length + ' 条');

section('Word 导出：代码块');

const jsLines = ['const greet = (name) => `你好，${name}！`;', 'console.log(greet(\'MDView\'));'];
const hasTable = doc.xml.indexOf('<w:tbl>') !== -1;
T('代码块使用表格「代码框」', hasTable);
T('代码框底色 F6F8FA', /w:fill="F6F8FA"/.test(doc.xml));
T('语言标题栏（EEF1F5）', /w:fill="EEF1F5"/.test(doc.xml));
T('标题栏显示语言名', doc.xml.indexOf('javascript') !== -1 && doc.xml.indexOf('python') !== -1);

// 每一行源码应当是独立段落（这样才能优雅折行）
const paraCount = (doc.xml.match(/<w:p[ >]/g) || []).length;
T('代码行拆成多个段落', paraCount > 40, paraCount + ' 个段落');

// 前导空格必须保留，否则缩进就没了
T('保留前导空格（xml:space=preserve）', doc.xml.indexOf('xml:space="preserve"') !== -1);
T('Python 缩进保留', doc.xml.indexOf('    a, b = 0, 1') !== -1, jsLines.length ? '' : '');

T('单元格内边距（否则背景会紧贴文字）', /<w:tcMar>/.test(doc.xml));
// OOXML 里相邻且属性相同的表格会被 Word 合并成一张 → 两个代码块会长成连体框
T('相邻代码框之间没有被直接拼接', doc.xml.indexOf('</w:tbl><w:tbl>') === -1);

// 制表符要按列展开，否则 Word 里 tab 宽度不可控
{
  const src = '```js\nfunction a() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}\n```\n';
  const d2 = await packDoc(src, {});
  T('制表符展开为空格', d2.xml.indexOf('    if (x) {') !== -1 && d2.xml.indexOf('        return 1;') !== -1,
    d2.xml.indexOf('\t') === -1 ? '文中已无 tab' : '仍含 tab');
  T('代码块内无 tab 字符', d2.xml.indexOf('\t') === -1);
}

/* ---------- 思维导图：Mermaid 语言别名 ---------- */
section('思维导图（mindmap）代码块');

{
  // ```mindmap 且首行没写类型 → 自动补上 mindmap 关键字
  const src = ['```mindmap', 'root((知识体系))', '    AI 基础', '        Transformer', '```', ''].join('\n');
  const r = renderer.render(src, { baseDir: root, highlight: true, renderMermaid: true, docId: 'mm1' });
  const d = (r.env.diagrams || [])[0];
  T('```mindmap 登记为 Mermaid 图表', !!d && d.kind === 'mermaid', d ? 'kind=' + d.kind : '未登记');
  T('首行自动补 mindmap 关键字', !!d && d.code.split('\n')[0] === 'mindmap',
    d ? JSON.stringify(d.code.split('\n')[0]) : '');
  T('子节点缩进保留', !!d && d.code.indexOf('\n    AI 基础') !== -1);
  T('预览输出 data-kind="mermaid"', r.html.indexOf('data-kind="mermaid"') !== -1);
}

{
  // 首行已经写了 mindmap → 不能再补一行，否则出现两个关键字
  const src = ['```mindmap', 'mindmap', 'root((根))', '    分支', '```', ''].join('\n');
  const d = (renderer.render(src, { renderMermaid: true, docId: 'mm2' }).env.diagrams || [])[0];
  const heads = d ? d.code.split('\n').filter((l) => l.trim().toLowerCase() === 'mindmap').length : -1;
  T('不重复补 mindmap 关键字', heads === 1, 'mindmap 行数=' + heads);
}

{
  // 代码块整体缩进（常见于嵌在列表里的写法）→ dedent 后根节点必须顶格
  const src = ['```mindmap', '    mindmap', '        root((根))', '            分支', '```', ''].join('\n');
  const d = (renderer.render(src, { renderMermaid: true, docId: 'mm3' }).env.diagrams || [])[0];
  T('整体缩进被 dedent', !!d && d.code.split('\n')[0] === 'mindmap',
    d ? JSON.stringify(d.code.split('\n')[0]) : '');
  T('dedent 保留相对层级', !!d && d.code.indexOf('\n    root((根))') !== -1);
}

{
  // 其它 Mermaid 图类型也能直接当语言标记
  const src = ['```flowchart', 'A[开始] --> B[结束]', '```', ''].join('\n');
  const d = (renderer.render(src, { renderMermaid: true, docId: 'mm4' }).env.diagrams || [])[0];
  T('```flowchart 首行补 flowchart', !!d && d.code.split('\n')[0] === 'flowchart',
    d ? JSON.stringify(d.code.split('\n')[0]) : '');
}

{
  // 关闭 Mermaid 渲染时应当退回普通代码块，而不是留一个空 div
  const src = ['```mindmap', 'root((根))', '```', ''].join('\n');
  const r = renderer.render(src, { renderMermaid: false, highlight: true, docId: 'mm5' });
  T('关闭渲染时退回普通代码块', (r.env.diagrams || []).length === 0 && r.html.indexOf('<pre') !== -1);
}

lines.push('');
lines.push(fail ? `结果：${fail} 项失败` : '结果：全部通过 ✅');
lines.push('产物：' + path.join(tmpDir, 'offline.docx'));
lines.push('────────────────────────────────');
console.log(lines.join('\n'));
fs.writeFileSync(path.join(root, '_offline.txt'), lines.join('\n'), 'utf8');
process.exitCode = fail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
