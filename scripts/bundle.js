'use strict';

/**
 * 用 esbuild 打包：
 *   1) 渲染进程  src/renderer/js/app.js      -> dist/renderer.js
 *   2) 主进程    src/main/main.js            -> dist/main.js（docx 等一并打进去）
 *   3) hljs 浏览器包（lib/common，含常用语言）
 */

const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    console.error('无法加载 esbuild：' + (e && e.message));
    console.error('若确实缺失，请执行：npm i -D esbuild');
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(dist, { recursive: true });
  fs.mkdirSync(path.join(root, 'vendor', 'highlight'), { recursive: true });

  const common = {
    bundle: true,
    logLevel: 'warning',
    legalComments: 'none',
    target: 'chrome122',
  };

  // 1) 渲染进程
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/renderer/js/app.js')],
    outfile: path.join(dist, 'renderer.js'),
    format: 'iife',
    platform: 'browser',
    minify: false,
    charset: 'utf8',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  console.log('[bundle] dist/renderer.js');

  // 2) 主进程（docx / image-size / plantuml-encoder 一并打包）
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/main/main.js')],
    outfile: path.join(dist, 'main.js'),
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    minify: false,
    charset: 'utf8',
    external: ['electron'],
  });
  console.log('[bundle] dist/main.js');

  // 3) highlight.js 浏览器包
  await esbuild.build({
    ...common,
    entryPoints: [path.join(root, 'src/vendor/hljs-entry.js')],
    outfile: path.join(root, 'vendor/highlight/highlight.min.js'),
    format: 'iife',
    platform: 'browser',
    minify: true,
    charset: 'utf8',
  });
  console.log('[bundle] vendor/highlight/highlight.min.js');
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
