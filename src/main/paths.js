'use strict';

const path = require('path');
const fs = require('fs');

/**
 * 应用根目录。
 * 主进程会被 esbuild 打包到 dist/，此时 __dirname 不再是项目根，
 * 因此统一用 app.getAppPath() 定位（开发态=项目根，打包态=app.asar）。
 */
function resolveAppRoot() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getAppPath === 'function') {
      const p = app.getAppPath();
      if (p && fs.existsSync(p)) return p;
    }
  } catch {
    /* 非 Electron 环境（构建脚本） */
  }
  return path.resolve(__dirname, '..', '..');
}

const appRoot = resolveAppRoot();

/**
 * 解析资源路径。
 * 开发态：<root>/vendor/xxx
 * 打包态：<resources>/app.asar/vendor/xxx（vendor 已随包打进 asar）
 */
function vendor(...segs) {
  return path.join(appRoot, 'vendor', ...segs);
}

function renderer(...segs) {
  return path.join(appRoot, 'src', 'renderer', ...segs);
}

function exists(p) {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** PlantUML 本地 jar 位置：优先用户数据目录，其次应用内置 resources */
function plantumlJarCandidates(userDataPath) {
  const list = [];
  if (userDataPath) list.push(path.join(userDataPath, 'plantuml.jar'));
  list.push(path.join(process.resourcesPath || appRoot, 'plantuml.jar'));
  list.push(path.join(appRoot, 'resources', 'plantuml.jar'));
  return list;
}

/** 查找可用的 java 可执行文件 */
function findJava() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const exe = path.join(home, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (exists(exe)) return exe;
  }
  // 常见安装位置兜底
  const guesses = [
    'C:\\Program Files\\Java\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk',
  ];
  for (const g of guesses) {
    if (g.endsWith('java.exe') && exists(g)) return g;
  }
  for (const root of guesses.slice(1)) {
    try {
      for (const d of fs.readdirSync(root)) {
        const exe = path.join(root, d, 'bin', 'java.exe');
        if (exists(exe)) return exe;
      }
    } catch {
      /* ignore */
    }
  }
  // 交给 PATH
  return 'java';
}

module.exports = { appRoot, vendor, renderer, exists, plantumlJarCandidates, findJava };
