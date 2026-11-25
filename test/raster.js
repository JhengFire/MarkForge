'use strict';

/**
 * 栅格化离线测试（不需要 Electron / canvas）
 *
 * 专门盯住一类曾经把「Word 里的公式」整批打没的 bug：
 * 手工拼接 SVG 时，KaTeX MathML `<annotation>` 里的原始 TeX 含 `&`、`<`
 * 会生成非法 XML，`<img>` 解码失败 → 公式在 Word 里直接消失。
 *
 * 这里用 linkedom 提供 DOM，用 @xmldom/xmldom 做真正的 XML 解析校验。
 *
 * 用法：node test/raster.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { DOMParser } = require('@xmldom/xmldom');
const root = path.resolve(__dirname, '..');
const tmp = path.join(root, '.tmp');
fs.mkdirSync(tmp, { recursive: true });

let pass = 0;
let fail = 0;
const lines = [];
function T(name, ok, extra) {
  if (ok) pass++;
  else fail++;
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  →  ' + extra : ''}`);
}

/* ---------- 用 jsdom 搭一个够用的浏览器环境 ---------- */
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { pretendToBeVisual: true });
const win = dom.window;
const document = win.document;
const XMLSerializer = win.XMLSerializer;

global.window = win;
global.document = document;
global.XMLSerializer = XMLSerializer;
global.Blob = class Blob {
  constructor(parts) {
    this.parts = parts;
  }
};
global.URL.createObjectURL = () => 'blob:stub';

/* ---------- 打包 raster.js ---------- */
const outRaster = path.join(tmp, 'raster.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'js', 'render', 'raster.js')],
  outfile: outRaster,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
});

const { buildRasterSvg, stripLayoutStyle } = require(outRaster);
const katex = require('katex');

/* ---------- 造一批「恶劣」公式 ---------- */
const CASES = [
  ['对齐符（含 &）', '\\begin{aligned} a &= b \\\\ c &= d \\end{aligned}'],
  ['小于号', 'a < b > c'],
  ['小于等于 + 文本', 'x \\le 1 \\text{ 且 } y \\ge 2'],
  ['转义字符', '\\text{a \\& b}'],
  ['引号与尖括号', '\\text{"<tag>"}'],
  ['中文', '\\text{面积} = \\pi r^2'],
  ['矩阵', '\\begin{pmatrix} a_{11} & a_{12} \\\\ a_{21} & a_{22} \\end{pmatrix}'],
  ['分段函数', 'f(x) = \\begin{cases} x^2, & x \\ge 0 \\\\ -x, & x < 0 \\end{cases}'],
];

lines.push('');
lines.push('──────── 栅格化 SVG 合法性 ────────');

const parser = new DOMParser();
for (const [name, tex] of CASES) {
  let html;
  try {
    html = katex.renderToString(tex, { displayMode: true, throwOnError: false, strict: 'ignore' });
  } catch (e) {
    T(name, false, 'KaTeX 渲染异常 ' + e.message);
    continue;
  }

  // KaTeX 的输出里确实带着未转义的 &（在 annotation 里），所以字符串拼接必然踩雷
  const rawHasAmp = html.indexOf('&') !== -1;

  const built = buildRasterSvg(html, { width: 300, height: 60, css: '.katex{font-size:1.06em}', padding: 4 });
  const doc = parser.parseFromString(built.svg, 'image/svg+xml');
  const bad = doc.getElementsByTagName('parsererror');
  const errEl = doc.documentElement && doc.documentElement.nodeName;
  const ok = bad.length === 0 && errEl === 'svg';

  T(
    name,
    ok,
    ok
      ? rawHasAmp
        ? '含 & 仍为合法 XML'
        : '合法 XML'
      : 'XML 解析失败：' + String(doc.toString()).slice(0, 120)
  );
}

/* ---------- 空元素（<br>）：DOM 序列化会自动转成自闭合 ---------- */
{
  // 渲染失败时 markdown.js 会输出带 <br> 的兜底 HTML。
  // outerHTML 里是 `<br>`；直接拼进 SVG 就依赖解析器的宽容度，
  // 严格的 XML 解析器（浏览器）会直接判为非法文档。走 XMLSerializer 则会被规范成自闭合。
  const frag = '<span class="math-error">LaTeX 未启用：x^2<br>渲染失败</span>';
  const fixed = buildRasterSvg(frag, { width: 300, height: 60 });
  const selfClosed = /<br\s*\/>/.test(fixed.svg);
  T('空元素 <br> 被序列化成自闭合', selfClosed, selfClosed ? 'OK' : fixed.svg.match(/<br[^>]*>/g)?.join(' '));
  const ok = parser.parseFromString(fixed.svg, 'image/svg+xml').getElementsByTagName('parsererror').length === 0;
  T('含 <br> 的内容仍为合法 XML', ok);
}

/* ---------- 元素入参（走 cloneNode + XMLSerializer） ---------- */
{
  document.body.innerHTML = '<span id="k">' + katex.renderToString('a \\& b', { throwOnError: false }) + '</span>';
  const el = document.getElementById('k');
  const built = buildRasterSvg(el, { width: 120, height: 30 });
  const doc = parser.parseFromString(built.svg, 'image/svg+xml');
  T('传入 DOM 元素同样合法', doc.getElementsByTagName('parsererror').length === 0);
  T('元素内容被克隆进 SVG', built.svg.indexOf('katex') !== -1);
}

/* ---------- 图表导出：清理屏幕布局样式 ---------- */
{
  // 预览里 renderDiagramNode 会给 SVG 加 max-width:100%; height:auto。
  // 这些声明序列化进 <img> 后会压掉 width/height 属性，
  // 思维导图这类宽图导出时会被压扁或按错误比例拉伸。
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 400');
  svg.setAttribute('style', 'max-width: 100%; height: auto; color: red;');

  stripLayoutStyle(svg);
  const st = svg.getAttribute('style') || '';
  T('移除 max-width', !/max-width/i.test(st), JSON.stringify(st));
  T('移除 height:auto', !/height/i.test(st), JSON.stringify(st));
  T('保留颜色等其它内联样式', /color:\s*red/i.test(st), JSON.stringify(st));

  // 只剩尺寸声明时，style 属性应整体去掉，不留空的 style=""
  const svg2 = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg2.setAttribute('style', 'max-width:100%;height:auto');
  stripLayoutStyle(svg2);
  T('尺寸声明清空后移除 style 属性', svg2.getAttribute('style') === null);
}

lines.push('');
lines.push(fail ? `结果：${fail} 项失败` : '结果：全部通过 ✅');
lines.push('────────────────────────────────');
console.log(lines.join('\n'));
fs.writeFileSync(path.join(root, '_raster.txt'), lines.join('\n'), 'utf8');
process.exitCode = fail ? 1 : 0;
