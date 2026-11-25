'use strict';

/**
 * 冒烟测试：启动真实窗口，跑一遍完整渲染 + 三种导出，校验产物。
 * 用法：MDVIEW_SMOKE=1 npx electron .
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SAMPLE = fs.readFileSync(path.join(__dirname, 'sample.md'), 'utf8');

async function run(win, ctx = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mdview-smoke-'));
  const paths = {
    dir: tmp,
    html: path.join(tmp, 'out.html'),
    pdf: path.join(tmp, 'out.pdf'),
    docx: path.join(tmp, 'out.docx'),
  };

  const script = `(async () => {
  const PATHS = ${JSON.stringify(paths)};
  const SAMPLE = ${JSON.stringify(SAMPLE)};
  const PH = String.fromCharCode(0xE000);
  const log = [];
  const fail = [];
  const T = (name, ok, extra) => { log.push({ name, ok: !!ok, extra: String(extra == null ? '' : extra) }); if (!ok) fail.push(name); };
  const q = (s) => document.querySelectorAll(s).length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await window.__mdview.ready;
  const app = window.__mdview;
  app.setDoc(SAMPLE);
  await app.renderNow(true);

  const deadline = Date.now() + 45000;
  for (;;) {
    const total = q('#preview .diagram');
    const done = q('#preview .diagram[data-rendered]');
    if (total > 0 && done >= total) break;
    if (Date.now() > deadline) break;
    await sleep(250);
  }

  T('标题', q('#preview h1') >= 1 && q('#preview h2') >= 3, q('#preview h1') + ' h1 / ' + q('#preview h2') + ' h2');
  T('表格', q('#preview table') >= 1);
  T('代码高亮', q('#preview pre code.hljs') >= 2, q('#preview pre code.hljs') + ' 块');
  T('行内公式', q('#preview .math-inline .katex') >= 3, q('#preview .math-inline .katex') + ' 个');
  T('块级公式', q('#preview .math-block .katex') >= 3, q('#preview .math-block .katex') + ' 个');
  T('无占位符残留', document.getElementById('preview').innerHTML.indexOf(PH) === -1);
  T('行内代码内不解析公式', q('#preview code') >= 1);
  T('Mermaid 渲染', q('#preview .diagram[data-kind="mermaid"] svg') >= 4, q('#preview .diagram[data-kind="mermaid"] svg') + ' 张');
  T('Mermaid 无报错', q('#preview .diagram[data-kind="mermaid"] .diagram-error') === 0);
  T('PlantUML 渲染', q('#preview .diagram[data-kind="plantuml"] svg') >= 1, q('#preview .diagram[data-kind="plantuml"] svg') + ' 张');
  T('PlantUML 无报错', q('#preview .diagram[data-kind="plantuml"] .diagram-error') === 0);
  T('任务列表', q('#preview li.task-list-item input') >= 2);
  T('脚注', q('#preview .footnotes') >= 1);
  T('目录', q('#preview .mdv-toc') >= 1);
  T('提示框/引用', q('#preview blockquote') >= 1);
  T('分页符', q('#preview .page-break') >= 1);
  T('data-line 标记', q('#preview [data-line]') >= 20, q('#preview [data-line]') + ' 个');
  T('大纲列表', q('#outlineList .outline-item') >= 5, q('#outlineList .outline-item') + ' 项');
  T('状态栏字数', /\\d+ 字/.test(document.getElementById('stStats').textContent), document.getElementById('stStats').textContent);

  // 滚动同步
  const scroller = document.getElementById('previewScroll');
  scroller.scrollTop = 400;
  const t1 = scroller.scrollTop;
  T('预览可滚动', t1 > 0, 'scrollTop=' + t1);

  // --- HTML 导出 ---
  const payload = await app.makeExportHtml();
  const html = await app.buildHtml(payload);
  T('HTML 已组装', html.length > 20000, html.length + ' 字节');
  T('HTML 内嵌 KaTeX 字体', html.indexOf('data:font/woff2') !== -1);
  T('HTML 内嵌图形 SVG', html.indexOf('<svg') !== -1);
  T('HTML 含 KaTeX 结构', html.indexOf('class="katex"') !== -1);
  // 回归：print.css 若没被 <style> 包裹，就会作为裸文本落进 <body>，
  // 让文件头部的 CSS 注释（/* ... */）显示在文档顶部。
  const bodyAt = html.indexOf('<body');
  const bodyPart = bodyAt >= 0 ? html.slice(bodyAt) : '';
  T('正文无 CSS 注释泄漏', bodyPart.indexOf('/*') === -1, bodyPart.indexOf('/*') >= 0 ? '发现裸露的 /*' : '');
  const dh = await window.mdv.exporter.html({ html, targetPath: PATHS.html });
  T('HTML 落盘', dh.ok && dh.path, dh.error || dh.path);

  // --- PDF 导出 ---
  const dp = await window.mdv.exporter.pdf({
    html,
    targetPath: PATHS.pdf,
    options: { pageSize: 'A4', margin: 18, headerFooter: true, printBackground: true },
  });
  T('PDF 导出', dp.ok && dp.size > 5000, (dp.error || '') + ' size=' + (dp.size || 0));

  // --- Word 导出 ---
  const dw = await app.exportDocx({ targetPath: PATHS.docx, quiet: true });
  T('Word 导出', dw && dw.ok && dw.size > 8000, ((dw && dw.error) || '') + ' size=' + ((dw && dw.size) || 0));

  return { log, fail, paths: PATHS };
})()`;

  let result;
  try {
    result = await win.webContents.executeJavaScript(script, true);
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e), failures: ['执行脚本异常'], log: [] };
  }

  const lines = [];
  lines.push('');
  lines.push('──────── MDView 冒烟测试 ────────');
  for (const it of result.log) {
    lines.push(`${it.ok ? '  ✓' : '  ✗'} ${it.name}${it.extra ? '  →  ' + it.extra : ''}`);
  }

  // 产物校验
  const checks = [
    ['out.html', result.paths.html, 20000],
    ['out.pdf', result.paths.pdf, 5000],
    ['out.docx', result.paths.docx, 8000],
  ];
  const fileInfo = [];
  for (const [label, p, min] of checks) {
    let size = 0;
    try {
      size = fs.statSync(p).size;
    } catch {
      size = 0;
    }
    const ok = size >= min;
    if (!ok) result.fail.push(label + ' 文件异常');
    lines.push(`${ok ? '  ✓' : '  ✗'} 产物 ${label}  →  ${size} 字节`);
    fileInfo.push({ label, path: p, size });
  }

  // PDF / DOCX 头部魔数校验
  const magic = [
    ['out.pdf', result.paths.pdf, Buffer.from('%PDF')],
    ['out.docx', result.paths.docx, Buffer.from([0x50, 0x4b, 0x03, 0x04])],
  ];
  for (const [label, p, sig] of magic) {
    let ok = false;
    try {
      const fd = fs.openSync(p, 'r');
      const buf = Buffer.alloc(sig.length);
      fs.readSync(fd, buf, 0, sig.length, 0);
      fs.closeSync(fd);
      ok = buf.equals(sig);
    } catch {
      ok = false;
    }
    if (!ok) result.fail.push(label + ' 文件头不正确');
    lines.push(`${ok ? '  ✓' : '  ✗'} 文件头 ${label}  →  ${ok ? 'OK' : '异常'}`);
  }

  lines.push('');
  lines.push(result.fail.length ? `结果：${result.fail.length} 项失败 → ${result.fail.join('、')}` : '结果：全部通过 ✅');
  lines.push('产物目录：' + result.paths.dir);
  lines.push('────────────────────────────────');
  console.log(lines.join('\n'));

  // Windows 上 Electron 是 GUI 子系统进程，stdout 常常不可见，
  // 因此把结果同时落盘一份，便于人工确认与 CI 读取。
  try {
    fs.writeFileSync(path.join(__dirname, 'smoke-result.txt'), lines.join('\n'), 'utf8');
  } catch {
    /* ignore */
  }

  return {
    ok: result.fail.length === 0,
    failures: result.fail,
    log: result.log,
    paths: result.paths,
    fileInfo,
  };
}

module.exports = { run };
