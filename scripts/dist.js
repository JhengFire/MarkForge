'use strict';

/**
 * 打包入口（替代直接调用 electron-builder）。
 *
 * 为什么需要这一层：
 * electron-builder 在写新包之前会**无条件**清空 release/win-unpacked，
 * 而上一版产出的 resources/app.asar（本项目 200MB+）经常还在被
 * 杀毒软件扫描、Windows 索引服务或上一次运行的进程持有，于是：
 *
 *   ⨯ EBUSY: resource busy or locked, unlink '...\resources\app.asar'
 *
 * 它内部没有任何重试，整个构建直接中断。单纯"等一会儿再跑"对
 * 持续占用的场景无效 —— 重命名一下 app.asar 就能验证锁是否真的还在。
 *
 * 这里做两件事：
 *   1) 自己先删，带线性退避重试（杀软扫描通常几百毫秒就松手）；
 *   2) 仍然删不掉就换一个带时间戳的输出目录，让 electron-builder
 *      完全不去碰被锁住的旧文件，保证包一定能打出来。
 *
 * 用法：
 *   node scripts/dist.js         # 等价于 electron-builder --win
 *   node scripts/dist.js --dir   # 只解包，不做安装程序（--dir）
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const releaseDir = path.join(root, 'release');
const dirOnly = process.argv.includes('--dir');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 删除文件或目录，返回是否成功。
 * EBUSY / EPERM 时按线性退避重试 —— 这正是 electron-builder 缺的那一步。
 */
function removeWithRetry(target, attempts = 5, delayMs = 600) {
  if (!fs.existsSync(target)) return true;
  for (let i = 1; i <= attempts; i++) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 0 });
      return true;
    } catch (e) {
      const code = e.code || '';
      if (i === attempts) {
        console.warn(`[dist] 删除失败（已重试 ${i} 次）：${path.relative(root, target)} → ${code} ${e.message}`);
        return false;
      }
      console.warn(`[dist] ${code || 'ERROR'}，${delayMs * i}ms 后重试：${path.relative(root, target)}`);
      sleepSync(delayMs * i);
    }
  }
  return true;
}

function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

/**
 * 删除失败时的第二层兜底：把旧目录改名搁置。
 *
 * 目录重命名是一次元数据操作，比"逐个 unlink 几百兆文件"的删除
 * 成功率高得多 —— 扫描器持有的是文件句柄，往往不影响目录改名。
 */
function renameAside(target) {
  const aside = target + '.stale-' + stamp();
  try {
    fs.renameSync(target, aside);
    console.warn('[dist] 旧产物改为搁置：' + path.relative(root, aside));
    return aside;
  } catch (e) {
    console.warn('[dist] 改名搁置也失败：' + (e.code || '') + ' ' + e.message);
    return '';
  }
}

function main() {
  // 这三样是上一次构建的残留：win-unpacked 里的 app.asar 就是 EBUSY 的主角
  const stale = ['win-unpacked', 'win-unpacked.tmp', 'builder-effective-config.yaml'];
  let clean = true;
  const aside = [];

  for (const name of stale) {
    const p = path.join(releaseDir, name);
    if (!fs.existsSync(p)) continue;
    if (removeWithRetry(p)) continue;
    // 删不掉就改名搁置，至少要给 electron-builder 让出目标路径
    const moved = renameAside(p);
    if (moved) aside.push(moved);
    else clean = false;
  }

  let outDir = releaseDir;
  if (!clean) {
    outDir = path.join(releaseDir, 'build-' + stamp());
    console.warn('');
    console.warn('[dist] 旧产物既删不掉也改不了名，本次改写到：' + path.relative(root, outDir));
    console.warn('[dist] 建议先退出正在运行的 MDView，再清理 release/ 下的残留目录。');
    console.warn('');
  }

  const cli = path.join(root, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!fs.existsSync(cli)) {
    console.error('[dist] 找不到 electron-builder，请先执行 npm install');
    process.exit(1);
  }

  const args = [cli, '--win', '--config.directories.output=' + outDir.replace(/\\/g, '/')];
  if (dirOnly) args.push('--dir');

  console.log('[dist] 输出目录：' + path.relative(root, outDir));
  const r = spawnSync(process.execPath, args, { stdio: 'inherit', cwd: root, env: process.env });

  if (r.status !== 0) {
    console.error('');
    console.error('[dist] electron-builder 失败，退出码 ' + r.status);
    if (r.error) console.error('[dist] ' + r.error.message);
    // 本机曾遇到的另一个坑：rcedit 改写 exe 版本信息时会替换原文件，
    // 被删除防护拦下后报 "Unable to commit changes"。
    console.error('[dist] 若报错是 Unable to commit changes / rcedit，可改用：');
    console.error('       npx electron-builder --win --config.win.signAndEditExecutable=false');
    process.exit(r.status || 1);
  }

  console.log('');
  console.log('[dist] 构建完成：' + path.relative(root, outDir));
  try {
    for (const f of fs.readdirSync(outDir)) {
      const p = path.join(outDir, f);
      const st = fs.statSync(p);
      if (st.isFile() && /\.(exe|blockmap|yml)$/i.test(f)) {
        console.log('  - ' + f + '  ' + humanSize(st.size));
      }
    }
  } catch {
    /* ignore */
  }

  // 构建完再试着清掉之前搁置的目录，尽早把磁盘还回去
  for (const dir of aside) {
    if (removeWithRetry(dir, 2, 300)) {
      console.log('[dist] 已清理搁置目录：' + path.relative(root, dir));
    } else {
      console.warn('[dist] 搁置目录仍被占用，稍后可手动删除：' + path.relative(root, dir));
    }
  }
}

main();
