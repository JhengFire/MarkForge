'use strict';

const fs = require('fs');
const { BrowserWindow } = require('electron');
const { writeTempHtml, cleanupTemp } = require('./assets');

/** 等待页面内所有图片加载完成 */
async function waitForImages(win, timeout = 8000) {
  const started = Date.now();
  for (;;) {
    let done = true;
    try {
      done = await win.webContents.executeJavaScript(
        'Array.from(document.images).every(function(i){return i.complete})',
        true
      );
    } catch {
      return;
    }
    if (done) return;
    if (Date.now() - started > timeout) return;
    await new Promise((r) => setTimeout(r, 120));
  }
}

/** 在隐藏窗口里渲染一份 HTML 并执行回调 */
async function withHiddenWindow(html, fn) {
  const { file, dir } = writeTempHtml(html, 'mdview-render');
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      javascript: true,
      backgroundThrottling: false,
    },
  });
  try {
    await win.loadFile(file);
    await waitForImages(win);
    return await fn(win);
  } finally {
    try {
      if (!win.isDestroyed()) win.destroy();
    } catch {
      /* ignore */
    }
    cleanupTemp(dir);
  }
}

const MM_PER_INCH = 25.4;

function toMargins(mm) {
  const v = Math.max(0, Number(mm) || 0) / MM_PER_INCH;
  return { top: v, bottom: v, left: v, right: v };
}

/**
 * 导出 PDF
 * @returns {Promise<Buffer>} pdf 数据
 */
async function renderPdf(html, options = {}) {
  return withHiddenWindow(html, async (win) => {
    const pageSize = options.pageSize || 'A4';
    const opts = {
      landscape: !!options.landscape,
      printBackground: options.printBackground !== false,
      pageSize,
      margins: toMargins(options.margin == null ? 18 : options.margin),
    };
    if (options.headerFooter) {
      const style =
        'width:100%;font-size:9px;color:#888;padding:0 14mm;font-family:sans-serif;' +
        'display:flex;justify-content:space-between;';
      opts.displayHeaderFooter = true;
      opts.headerTemplate =
        `<div style="${style}"><span></span><span class="title"></span></div>`;
      opts.footerTemplate =
        `<div style="${style}"><span></span>` +
        '<span>第 <span class="pageNumber"></span> / <span class="totalPages"></span> 页</span></div>';
    }
    return win.webContents.printToPDF(opts);
  });
}

/** 打开打印预览窗口（用户确认后交给系统打印/另存 PDF） */
async function openPrintWindow({ html, title }, onClosed) {
  const { file, dir } = writeTempHtml(html, 'mdview-print');
  const win = new BrowserWindow({
    width: 1024,
    height: 860,
    title: (title || '打印预览') + ' - 打印预览',
    autoHideMenuBar: true,
    backgroundColor: '#525659',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(file);
  await waitForImages(win);
  win.on('closed', () => {
    cleanupTemp(dir);
    if (typeof onClosed === 'function') onClosed();
  });
  return win;
}

/** 直接打印（静默交给默认打印机或弹出系统对话框） */
async function renderPrint(html, options = {}) {
  return withHiddenWindow(html, async (win) => {
    return new Promise((resolve) => {
      const opts = {
        silent: !!options.silent,
        printBackground: options.printBackground !== false,
      };
      if (options.deviceName) opts.deviceName = options.deviceName;
      win.webContents.print(opts, (success, failureReason) => {
        resolve({ success, reason: failureReason || '' });
      });
    });
  });
}

/** 写文件（自动建目录） */
function writeFileSafe(p, data) {
  fs.mkdirSync(require('path').dirname(p), { recursive: true });
  fs.writeFileSync(p, data);
  return p;
}

module.exports = { renderPdf, openPrintWindow, renderPrint, writeFileSafe, withHiddenWindow, waitForImages };
