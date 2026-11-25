'use strict';

/**
 * 把第三方库的浏览器版资源复制到 vendor/
 * 只复制运行期真正需要的文件，保持仓库干净
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nm = path.join(root, 'node_modules');
const vendorDir = path.join(root, 'vendor');

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyFile(src, dst) {
  if (!fs.existsSync(src)) {
    console.warn('  ✗ 缺少 ' + path.relative(root, src));
    return false;
  }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return true;
}

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) n += copyDir(s, d);
    else {
      ensureDir(path.dirname(d));
      fs.copyFileSync(s, d);
      n++;
    }
  }
  return n;
}

const HLJS_THEMES = [
  'github', 'github-dark', 'github-dark-dimmed', 'atom-one-light', 'atom-one-dark',
  'vs', 'vs2015', 'xcode', 'monokai', 'dracula', 'nord', 'stackoverflow-light',
  'stackoverflow-dark', 'solarized-light', 'solarized-dark', 'agate', 'tokyo-night-light',
  'tokyo-night-dark', 'intellij-light', 'default',
];

function main() {
  console.log('[vendor] 目标目录：' + path.relative(root, vendorDir));
  ensureDir(vendorDir);

  // ---- KaTeX：脚本 + 样式 + 字体 ----
  let n = 0;
  n += copyFile(path.join(nm, 'katex/dist/katex.min.js'), path.join(vendorDir, 'katex/katex.min.js')) ? 1 : 0;
  n += copyFile(path.join(nm, 'katex/dist/katex.min.css'), path.join(vendorDir, 'katex/katex.min.css')) ? 1 : 0;
  const fontCount = copyDir(path.join(nm, 'katex/dist/fonts'), path.join(vendorDir, 'katex/fonts'));
  console.log(`  ✓ katex（含 ${fontCount} 个字体文件）`);
  n += fontCount;

  // ---- Mermaid ----
  if (copyFile(path.join(nm, 'mermaid/dist/mermaid.min.js'), path.join(vendorDir, 'mermaid/mermaid.min.js'))) {
    console.log('  ✓ mermaid');
    n++;
  }

  // ---- highlight.js 主题样式（脚本由 bundle.js 生成） ----
  let themeCount = 0;
  for (const t of HLJS_THEMES) {
    const src = path.join(nm, 'highlight.js/styles', t + '.min.css');
    if (existsSafe(src)) {
      copyFile(src, path.join(vendorDir, 'highlight/styles', t + '.min.css'));
      themeCount++;
    }
  }
  console.log(`  ✓ highlight.js 主题 ${themeCount} 个`);
  n += themeCount;

  console.log(`[vendor] 共复制 ${n} 个文件`);
}

function existsSafe(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

main();
