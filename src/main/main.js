'use strict';

const {
  app, BrowserWindow, Menu, ipcMain, dialog, shell, nativeTheme,
} = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Store } = require('./store');
const P = require('./paths');
const plantuml = require('./plantuml');
const assets = require('./exporter/assets');
const printer = require('./exporter/print');
const { buildDocx } = require('./exporter/docx');

const isDev = !app.isPackaged;
let store = null;
let mainWin = null;
let pendingOpenFile = null;

// 在没有可用 GPU 的环境（远程桌面、虚拟机、部分受管终端）里，Chromium 的
// GPU 进程会反复崩溃并最终以 FATAL 退出。本应用是文本编辑器，不依赖硬件加速，
// 因此默认关闭；需要对照 GPU 渲染时设 MDVIEW_GPU=1 即可恢复。
if (!process.env.MDVIEW_GPU) {
  app.disableHardwareAcceleration();
}
/** 命令行模式：不抢 GUI 单实例锁，也不创建主窗口 */
const CLI_OPTS = parseCli(process.argv);
/** 单实例：第二个实例打开的文件转交给主窗口 */
const gotLock = CLI_OPTS ? true : app.requestSingleInstanceLock();
if (!CLI_OPTS && !gotLock) {
  app.quit();
} else if (!CLI_OPTS) {
  app.on('second-instance', (_e, argv) => {
    if (mainWin) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.focus();
    }
    const f = pickFileFromArgv(argv);
    if (f) sendOpen(f);
  });
}

/**
 * 命令行导出（无界面）。
 *
 *   MDView.exe --export doc.md --to pdf,docx -o out/
 *
 * 走的是和 GUI 完全相同的渲染与导出管线：隐藏窗口里渲染 Markdown，
 * 公式、Mermaid / PlantUML / 思维导图都会真实渲染，再交给对应的导出器。
 */
function parseCli(argv) {
  const args = (argv || []).slice(1);
  const ei = args.indexOf('--export');
  if (ei < 0) return null;

  const opts = {
    input: '',
    formats: [],
    out: '',
    page: 'A4',
    margin: 18,
    landscape: false,
    headerFooter: true,
    help: false,
  };

  for (let i = ei + 1; i < args.length; i++) {
    const a = args[i];
    if (a === '--to' || a === '--format') {
      opts.formats = String(args[++i] || '')
        .split(',')
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
    } else if (a === '-o' || a === '--out') {
      opts.out = args[++i] || '';
    } else if (a === '--page') {
      opts.page = args[++i] || 'A4';
    } else if (a === '--margin') {
      const n = Number(args[++i]);
      if (Number.isFinite(n) && n >= 0) opts.margin = n;
    } else if (a === '--landscape') {
      opts.landscape = true;
    } else if (a === '--no-header-footer') {
      opts.headerFooter = false;
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (!a.startsWith('-') && !opts.input) {
      opts.input = a;
    }
  }

  if (!opts.formats.length) opts.formats = ['html'];
  return opts;
}

function cliUsage() {
  return [
    '用法：MDView --export <文件.md> [选项]',
    '',
    '选项：',
    '  --to, --format <列表>   导出格式，逗号分隔：html / pdf / docx（默认 html）',
    '  -o, --out <路径>        输出文件；多格式时视为输出目录',
    '  --page <尺寸>           PDF 纸张：A4 / A3 / A5 / Letter / Legal / Tabloid',
    '  --margin <mm>           PDF 页边距，默认 18',
    '  --landscape             PDF 横向',
    '  --no-header-footer      PDF 不显示页眉页脚',
    '  -h, --help              显示帮助',
    '',
    '示例：',
    '  MDView --export report.md --to pdf',
    '  MDView --export report.md --to pdf,docx -o dist/',
  ].join('\n');
}

/** 隐藏窗口里渲染并导出，返回进程退出码 */
async function runCli(opts) {
  if (opts.help) {
    console.log(cliUsage());
    return 0;
  }

  const input = path.resolve(opts.input || '');
  if (!opts.input || !fs.existsSync(input)) {
    console.error('[cli] 找不到输入文件：' + (opts.input || '(未指定)'));
    console.error(cliUsage());
    return 2;
  }
  const allowed = new Set(['html', 'pdf', 'docx']);
  const bad = opts.formats.filter((f) => !allowed.has(f));
  if (bad.length) {
    console.error('[cli] 不支持的格式：' + bad.join(', '));
    return 2;
  }

  // 输出路径：单格式 = 文件；多格式或 -o 指向目录 = 目录
  const base = path.basename(input).replace(/\.[^.]+$/, '');
  const outList = {};
  const outIsDir = opts.formats.length > 1 || (opts.out && !/\.[^.\\/]+$/.test(opts.out));
  for (const f of opts.formats) {
    const p = opts.out
      ? outIsDir
        ? path.join(opts.out, base + '.' + f)
        : opts.out
      : path.join(path.dirname(input), base + '.' + f);
    outList[f] = path.resolve(p);
    fs.mkdirSync(path.dirname(outList[f]), { recursive: true });
  }

  const source = fs.readFileSync(input, 'utf8');
  const dir = path.dirname(input);

  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 1000,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  try {
    await win.loadFile(P.renderer('index.html'));
    const script = `(async () => {
      const OUT = ${JSON.stringify(outList)};
      const FMT = ${JSON.stringify(opts.formats)};
      const SRC = ${JSON.stringify(source)};
      const DIR = ${JSON.stringify(dir)};
      const PDF = ${JSON.stringify({
        pageSize: opts.page,
        margin: opts.margin,
        landscape: opts.landscape,
        headerFooter: opts.headerFooter,
        printBackground: true,
      })};

      await window.__mdview.ready;
      const app = window.__mdview;
      app.state.dir = DIR;
      app.setDoc(SRC);
      await app.renderNow(true);

      // 等图表（Mermaid / PlantUML / 思维导图）全部渲染完
      const deadline = Date.now() + 60000;
      for (;;) {
        const total = document.querySelectorAll('#preview .diagram').length;
        const done = document.querySelectorAll('#preview .diagram[data-rendered]').length;
        if (!total || done >= total || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 200));
      }

      let html = '';
      if (FMT.includes('html') || FMT.includes('pdf')) {
        const payload = await app.makeExportHtml();
        html = await app.buildHtml(payload);
      }

      const results = {};
      if (FMT.includes('html')) {
        results.html = await window.mdv.exporter.html({ html, targetPath: OUT.html });
      }
      if (FMT.includes('pdf')) {
        results.pdf = await window.mdv.exporter.pdf({ html, targetPath: OUT.pdf, options: PDF });
      }
      if (FMT.includes('docx')) {
        results.docx = await app.exportDocx({ targetPath: OUT.docx, quiet: true });
      }

      return {
        results,
        diagramErrors: document.querySelectorAll('#preview .diagram-error').length,
        headings: document.querySelectorAll('#preview h1, #preview h2, #preview h3').length,
      };
    })()`;

    const res = await win.webContents.executeJavaScript(script, true);

    let code = 0;
    for (const [fmt, r] of Object.entries(res.results || {})) {
      if (r && r.ok) {
        console.log(`[cli] ${fmt} → ${r.path}${r.size ? '（' + Math.round(r.size / 1024) + ' KB）' : ''}`);
      } else {
        code = 1;
        console.error(`[cli] ${fmt} 导出失败：${(r && r.error) || '未知错误'}`);
      }
    }
    if (res.diagramErrors) {
      console.warn(`[cli] 有 ${res.diagramErrors} 张图表渲染失败，已按错误占位导出`);
    }
    return code;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

function pickFileFromArgv(argv) {
  const list = (argv || []).slice(1);
  for (const a of list) {
    if (!a || a.startsWith('-')) continue;
    if (/^\.(md|markdown|mdown|mkd|txt)$/i.test(path.extname(a)) && fs.existsSync(a)) return a;
  }
  return null;
}

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}
function sendOpen(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    store.pushRecent(file);
    send('app:openFile', { path: file, content });
    if (mainWin) mainWin.setTitle(path.basename(file) + ' - MDView');
  } catch (e) {
    dialog.showErrorBox('打开失败', String(e.message));
  }
  // 刷新「打开最近」菜单（store 尚未初始化时忽略）
  try {
    buildMenu();
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ *
 * 菜单
 * ------------------------------------------------------------------ */
function buildMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate()));
}

function menuTemplate() {
  const cmd = (id, extra) => () => send('menu:command', { id, ...(extra || {}) });
  return [
    {
      label: '文件(&F)',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: cmd('file.new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: cmd('file.open') },
        {
          label: '打开最近',
          // 注意：Electron 的 submenu 只接受数组或 Menu 实例，不接受函数，
          // 所以这里立即求值；打开/保存文件后会重建菜单以刷新列表。
          submenu: (() => {
            const rec = store.get('recentFiles') || [];
            if (!rec.length) return [{ label: '（暂无）', enabled: false }];
            return [
              ...rec.map((f) => ({ label: f, click: () => sendOpen(f) })),
              { type: 'separator' },
              { label: '清除记录', click: () => store.set({ recentFiles: [] }) },
            ];
          })(),
        },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: cmd('file.save') },
        { label: '另存为…', accelerator: 'CmdOrCtrl+Shift+S', click: cmd('file.saveAs') },
        { type: 'separator' },
        { label: '导出为 Word (.docx)…', accelerator: 'CmdOrCtrl+Shift+W', click: cmd('export.docx') },
        { label: '导出为 PDF…', accelerator: 'CmdOrCtrl+Shift+E', click: cmd('export.pdf') },
        { label: '导出为 HTML…', accelerator: 'CmdOrCtrl+Shift+H', click: cmd('export.html') },
        { type: 'separator' },
        { label: '打印预览…', accelerator: 'CmdOrCtrl+P', click: cmd('print.preview') },
        { label: '一键打印', accelerator: 'CmdOrCtrl+Alt+P', click: cmd('print.now') },
        { type: 'separator' },
        { label: '设置…', accelerator: 'CmdOrCtrl+,', click: cmd('app.settings') },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑(&E)',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找 / 替换', accelerator: 'CmdOrCtrl+F', click: cmd('edit.find') },
        {
          label: '格式',
          submenu: [
            { label: '加粗', accelerator: 'CmdOrCtrl+B', click: cmd('fmt.bold') },
            { label: '斜体', accelerator: 'CmdOrCtrl+I', click: cmd('fmt.italic') },
            { label: '删除线', click: cmd('fmt.strike') },
            { label: '行内代码', accelerator: 'CmdOrCtrl+`', click: cmd('fmt.code') },
            { type: 'separator' },
            { label: '标题 1', accelerator: 'CmdOrCtrl+1', click: cmd('fmt.h1') },
            { label: '标题 2', accelerator: 'CmdOrCtrl+2', click: cmd('fmt.h2') },
            { label: '标题 3', accelerator: 'CmdOrCtrl+3', click: cmd('fmt.h3') },
            { label: '正文（清除标题）', accelerator: 'CmdOrCtrl+0', click: cmd('fmt.p') },
            { type: 'separator' },
            { label: '无序列表', accelerator: 'CmdOrCtrl+Shift+8', click: cmd('fmt.ul') },
            { label: '有序列表', accelerator: 'CmdOrCtrl+Shift+7', click: cmd('fmt.ol') },
            { label: '任务列表', click: cmd('fmt.task') },
            { label: '引用块', accelerator: 'CmdOrCtrl+Shift+.', click: cmd('fmt.quote') },
            { label: '代码块', accelerator: 'CmdOrCtrl+Shift+C', click: cmd('fmt.codeblock') },
            { label: '表格', accelerator: 'CmdOrCtrl+T', click: cmd('fmt.table') },
            { label: '分割线', click: cmd('fmt.hr') },
          ],
        },
        {
          label: '插入',
          submenu: [
            { label: '链接', accelerator: 'CmdOrCtrl+K', click: cmd('ins.link') },
            { label: '图片', accelerator: 'CmdOrCtrl+Shift+I', click: cmd('ins.image') },
            { label: '本地图片文件…', click: cmd('ins.imageFile') },
            { type: 'separator' },
            { label: '行内公式  $…$', accelerator: 'CmdOrCtrl+M', click: cmd('ins.mathInline') },
            { label: '块级公式  $$…$$', accelerator: 'CmdOrCtrl+Shift+M', click: cmd('ins.mathBlock') },
            { type: 'separator' },
            { label: 'Mermaid 图', click: cmd('ins.mermaid') },
            { label: 'PlantUML 图', click: cmd('ins.plantuml') },
            { label: '公式 / 图表速查…', click: cmd('ins.cheatsheet') },
            { type: 'separator' },
            { label: '目录 TOC', click: cmd('ins.toc') },
            { label: '分页符（导出用）', click: cmd('ins.pagebreak') },
          ],
        },
      ],
    },
    {
      label: '视图(&V)',
      submenu: [
        { label: '编辑 + 预览', accelerator: 'CmdOrCtrl+Alt+1', click: cmd('view.split') },
        { label: '仅编辑', accelerator: 'CmdOrCtrl+Alt+2', click: cmd('view.editor') },
        { label: '仅预览', accelerator: 'CmdOrCtrl+Alt+3', click: cmd('view.preview') },
        { type: 'separator' },
        { label: '显示大纲', accelerator: 'CmdOrCtrl+Shift+O', click: cmd('view.outline') },
        { label: '同步滚动', type: 'checkbox', checked: true, click: (mi) => send('menu:command', { id: 'view.syncScroll', checked: mi.checked }) },
        { label: '自动换行', type: 'checkbox', checked: true, click: (mi) => send('menu:command', { id: 'view.wrap', checked: mi.checked }) },
        { type: 'separator' },
        { label: '放大', accelerator: 'CmdOrCtrl+=', click: cmd('view.zoomIn') },
        { label: '缩小', accelerator: 'CmdOrCtrl+-', click: cmd('view.zoomOut') },
        { label: '实际大小', accelerator: 'CmdOrCtrl+Shift+0', click: cmd('view.zoomReset') },
        { type: 'separator' },
        { label: '浅色主题', click: cmd('view.themeLight') },
        { label: '深色主题', click: cmd('view.themeDark') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { role: 'reload', label: '重新加载' },
      ],
    },
    {
      label: '帮助(&H)',
      submenu: [
        { label: 'Markdown 语法速查', click: cmd('help.syntax') },
        { label: '公式与图表示例', click: cmd('help.samples') },
        { type: 'separator' },
        { label: '关于 MDView', click: cmd('help.about') },
      ],
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */
function createWindow() {
  const bounds = store.get('windowBounds') || {};
  mainWin = new BrowserWindow({
    width: bounds.width || 1360,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 880,
    minHeight: 600,
    show: false,
    title: 'MDView',
    backgroundColor: store.get('theme') === 'dark' ? '#1b1d23' : '#ffffff',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'src', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: !!store.get('spellcheck'),
    },
  });

  mainWin.loadFile(P.renderer('index.html'));

  mainWin.once('ready-to-show', () => {
    mainWin.show();
    if (pendingOpenFile) {
      sendOpen(pendingOpenFile);
      pendingOpenFile = null;
    }
  });

  // 冒烟测试：MDVIEW_SMOKE=1 npx electron .
  if (process.env.MDVIEW_SMOKE) {
    mainWin.webContents.once('did-finish-load', async () => {
      let code = 1;
      try {
        // 运行时按路径加载，避免把测试代码打进生产包
        const smokePath = path.join(app.getAppPath(), 'test', 'smoke.js');
        const smoke = require(smokePath);
        const res = await smoke.run(mainWin);
        code = res && res.ok ? 0 : 1;
      } catch (e) {
        console.error('[smoke] 执行失败：', e);
      }
      setTimeout(() => app.exit(code), 200);
    });
  }

  const saveBounds = () => {
    if (!mainWin || mainWin.isDestroyed() || mainWin.isMinimized()) return;
    store.set({ windowBounds: mainWin.getNormalBounds() });
  };
  mainWin.on('resize', saveBounds);
  mainWin.on('move', saveBounds);
  mainWin.on('closed', () => { mainWin = null; });

  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */
function registerIpc() {
  const userData = app.getPath('userData');

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dev: isDev,
    userData,
    home: os.homedir(),
    documents: app.getPath('documents'),
    pathSeparator: path.sep,
  }));

  ipcMain.handle('settings:get', () => store.get());
  ipcMain.handle('settings:set', (_e, patch) => {
    const data = store.set(patch || {});
    if (data.theme) nativeTheme.themeSource = data.theme === 'dark' ? 'dark' : 'light';
    return data;
  });

  /** KaTeX 样式（字体已内联为 base64）——导出 Word 时栅格化公式需要 */
  ipcMain.handle('assets:katexCss', () => assets.katexCss());

  /* ---------------- 文件 ---------------- */
  ipcMain.handle('file:openDialog', async () => {
    const last = store.get('lastDir') || app.getPath('documents');
    const r = await dialog.showOpenDialog(mainWin, {
      title: '打开 Markdown 文件',
      defaultPath: last,
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'mdx'] },
        { name: '文本', extensions: ['txt', 'text'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const p = r.filePaths[0];
    store.set({ lastDir: path.dirname(p) });
    const content = fs.readFileSync(p, 'utf8');
    store.pushRecent(p);
    return { canceled: false, path: p, content, dir: path.dirname(p) };
  });

  ipcMain.handle('file:openPath', async (_e, p) => {
    try {
      const content = fs.readFileSync(p, 'utf8');
      store.set({ lastDir: path.dirname(p) });
      store.pushRecent(p);
      return { ok: true, path: p, content, dir: path.dirname(p) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('file:save', async (_e, { path: p, content }) => {
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content == null ? '' : String(content), 'utf8');
      store.set({ lastDir: path.dirname(p) });
      store.pushRecent(p);
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('file:saveAsDialog', async (_e, { defaultName, content, filters, title }) => {
    const r = await dialog.showSaveDialog(mainWin, {
      title: title || '另存为',
      defaultPath: path.join(store.get('lastDir') || app.getPath('documents'), defaultName || 'untitled.md'),
      filters: filters || [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (r.canceled || !r.filePath) return { canceled: true };
    try {
      fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
      fs.writeFileSync(r.filePath, content == null ? '' : String(content), 'utf8');
      store.set({ lastDir: path.dirname(r.filePath) });
      store.pushRecent(r.filePath);
      return { canceled: false, ok: true, path: r.filePath };
    } catch (e) {
      return { canceled: false, ok: false, error: e.message };
    }
  });

  ipcMain.handle('file:readText', async (_e, p) => {
    try {
      return { ok: true, content: fs.readFileSync(p, 'utf8') };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('file:readDataUrl', async (_e, p) => {
    try {
      const ext = path.extname(p).toLowerCase();
      const mime =
        { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
          '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.avif': 'image/avif' }[ext]
        || 'application/octet-stream';
      const b64 = fs.readFileSync(p).toString('base64');
      return { ok: true, dataUrl: `data:${mime};base64,${b64}`, size: fs.statSync(p).size };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('file:exists', (_e, p) => P.exists(p));
  ipcMain.handle('file:stat', (_e, p) => {
    try {
      const s = fs.statSync(p);
      return { ok: true, isFile: s.isFile(), isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('path:join', (_e, parts) => path.join(...(parts || [])));
  ipcMain.handle('path:dirname', (_e, p) => path.dirname(p));
  ipcMain.handle('path:basename', (_e, p) => path.basename(p));
  ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return true;
  });
  ipcMain.handle('dialog:message', async (_e, opts = {}) => {
    const r = await dialog.showMessageBox(mainWin, {
      type: opts.type || 'info',
      title: opts.title || 'MDView',
      message: opts.message || '',
      detail: opts.detail,
      buttons: opts.buttons || ['确定'],
      defaultId: 0,
      cancelId: opts.cancelId == null ? (opts.buttons || []).length - 1 : opts.cancelId,
      noLink: true,
    });
    return r.response;
  });
  ipcMain.handle('dialog:confirmSave', async (_e, name) => {
    const r = await dialog.showMessageBox(mainWin, {
      type: 'warning',
      title: 'MDView',
      message: `“${name}” 尚未保存，是否保存？`,
      buttons: ['保存', '不保存', '取消'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    return r.response; // 0 保存 / 1 不保存 / 2 取消
  });

  ipcMain.handle('window:forceClose', () => {
    if (mainWin && !mainWin.isDestroyed()) {
      mainWin.__forceClose = true;
      mainWin.close();
    }
    return true;
  });

  /* ---------------- 草稿（防丢失） ---------------- */
  const draftPath = path.join(userData, 'draft.md');
  ipcMain.handle('draft:read', () => {
    try {
      return { ok: true, content: fs.readFileSync(draftPath, 'utf8'), path: draftPath };
    } catch {
      return { ok: false, content: '' };
    }
  });
  ipcMain.handle('draft:write', (_e, text) => {
    try {
      fs.writeFileSync(draftPath, String(text == null ? '' : text), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('draft:clear', () => {
    try {
      fs.rmSync(draftPath, { force: true });
    } catch {
      /* ignore */
    }
    return true;
  });

  /* ---------------- 导出 ---------------- */
  ipcMain.handle('export:html', async (_e, arg) => {
    const { html, defaultName, targetPath, dryRun, payload } = arg || {};
    // 允许只组装不落盘（PDF / 打印共用同一条 HTML 生成路径）
    const content = payload ? assets.buildStandaloneHtml(payload) : html;
    if (dryRun) return { ok: true, html: content };

    let out = targetPath;
    if (!out) {
      const r = await dialog.showSaveDialog(mainWin, {
        title: '导出为 HTML',
        defaultPath: path.join(store.get('lastDir') || app.getPath('documents'), defaultName || 'document.html'),
        filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      out = r.filePath;
    }
    try {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, content, 'utf8');
      store.set({ lastDir: path.dirname(out) });
      return { ok: true, path: out };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('export:pdf', async (_e, { html, defaultName, options, targetPath }) => {
    let out = targetPath;
    if (!out) {
      const r = await dialog.showSaveDialog(mainWin, {
        title: '导出为 PDF',
        defaultPath: path.join(store.get('lastDir') || app.getPath('documents'), defaultName || 'document.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return { canceled: true };
      out = r.filePath;
    }
    try {
      const buf = await printer.renderPdf(html, options || {});
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buf);
      store.set({ lastDir: path.dirname(out) });
      return { ok: true, path: out, size: buf.length };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('export:docx', async (_e, payload) => {
    try {
      const { buffer, warnings } = await buildDocx(payload || {});
      let out = payload && payload.targetPath;
      if (!out) {
        const r = await dialog.showSaveDialog(mainWin, {
          title: '导出为 Word',
          defaultPath: path.join(
            store.get('lastDir') || app.getPath('documents'),
            (payload && payload.meta && payload.meta.defaultName) || 'document.docx'
          ),
          filters: [{ name: 'Word 文档', extensions: ['docx'] }],
        });
        if (r.canceled || !r.filePath) return { canceled: true };
        out = r.filePath;
      }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, buffer);
      store.set({ lastDir: path.dirname(out) });
      return { ok: true, path: out, size: buffer.length, warnings: warnings || [] };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /* ---------------- 打印 ---------------- */
  ipcMain.handle('print:preview', async (_e, { html, title }) => {
    try {
      await printer.openPrintWindow({ html, title });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('print:now', async (_e, { html, options }) => {
    try {
      return await printer.renderPrint(html, options || {});
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('print:listPrinters', async () => {
    try {
      const wins = BrowserWindow.getAllWindows();
      const w = wins[0];
      if (!w) return [];
      return await w.webContents.getPrintersAsync();
    } catch {
      return [];
    }
  });

  /* ---------------- PlantUML ---------------- */
  ipcMain.handle('plantuml:status', () => {
    const st = plantuml.detect(userData);
    return {
      java: st.java,
      jar: st.jar,
      ready: st.ready,
      jarPath: path.join(userData, 'plantuml.jar'),
    };
  });

  ipcMain.handle('plantuml:render', async (_e, { source, mode, server }) => {
    const st = plantuml.detect(userData);
    if (mode === 'local' && st.ready) {
      const r = await plantuml.renderLocal(source, { java: st.java, jar: st.jar });
      if (r.ok) return r;
      const fallback = await plantuml.renderRemote(source, server);
      return { ...fallback, note: '本地渲染失败，已改用远程：' + (r.error || '') };
    }
    return plantuml.renderRemote(source, server);
  });

  ipcMain.handle('plantuml:downloadJar', async () => {
    const dest = path.join(userData, 'plantuml.jar');
    const r = await plantuml.downloadJar(dest);
    if (r.ok) r.status = plantuml.detect(userData);
    return r;
  });
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */
app.whenReady().then(async () => {
  store = new Store(app.getPath('userData'));
  nativeTheme.themeSource = store.get('theme') === 'dark' ? 'dark' : 'light';
  registerIpc();

  // 命令行导出：不创建主窗口，导出完直接退出
  if (CLI_OPTS) {
    let code = 1;
    try {
      code = await runCli(CLI_OPTS);
    } catch (e) {
      console.error('[cli] ' + (e && e.message ? e.message : e));
    }
    app.exit(code);
    return;
  }

  pendingOpenFile = pickFileFromArgv(process.argv);
  if (process.argv.includes('--open')) {
    const idx = process.argv.indexOf('--open');
    if (process.argv[idx + 1]) pendingOpenFile = process.argv[idx + 1];
  }

  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

process.on('uncaughtException', (err) => {
  try {
    dialog.showErrorBox('MDView 发生错误', String(err && err.stack ? err.stack : err));
  } catch {
    /* ignore */
  }
});
