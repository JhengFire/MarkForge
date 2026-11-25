'use strict';

/** PlantUML 渲染：本地 java + jar 优先，远程 HTTP 服务兜底 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { plantumlJarCandidates, findJava, exists } = require('./paths');

function detect(userDataPath) {
  const java = findJava();
  let jar = null;
  for (const p of plantumlJarCandidates(userDataPath)) {
    if (exists(p)) {
      jar = p;
      break;
    }
  }
  return { java, jar, ready: !!jar };
}

/** 本地渲染：java -jar plantuml.jar -tsvg -pipe */
function renderLocal(source, { java, jar, timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    if (!jar) return resolve({ ok: false, error: '未找到 plantuml.jar' });
    let child;
    try {
      child = spawn(java || 'java', [
        '-Djava.awt.headless=true',
        '-Dfile.encoding=UTF-8',
        '-jar', jar,
        '-tsvg',
        '-pipe',
        '-charset', 'UTF-8',
      ], { windowsHide: true });
    } catch (e) {
      return resolve({ ok: false, error: 'Java 启动失败：' + e.message });
    }
    let out = Buffer.alloc(0);
    let err = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, error: 'PlantUML 本地渲染超时' });
    }, timeout);

    child.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: '无法执行 java：' + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.toString('utf8').replace(/^\uFEFF/, '').trim();
      if (code === 0 && text.startsWith('<')) {
        resolve({ ok: true, svg: text, mode: 'local' });
      } else {
        resolve({ ok: false, error: (err || text || 'exit ' + code).slice(0, 800) });
      }
    });
    try {
      child.stdin.write(Buffer.from(String(source), 'utf8'));
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      resolve({ ok: false, error: '写入 PlantUML 源失败：' + e.message });
    }
  });
}

/** 远程渲染：返回 SVG 文本（失败时由调用方退化为 <img>） */
async function renderRemote(source, server = 'https://www.plantuml.com/plantuml', timeout = 20000) {
  const encode = require('plantuml-encoder');
  const url = String(server).replace(/\/+$/, '') + '/svg/' + encode.encode(String(source));
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, error: 'HTTP ' + res.status, url };
    const text = await res.text();
    if (!/^\s*<(\?xml|svg)/i.test(text)) return { ok: false, error: '返回内容不是 SVG', url };
    return { ok: true, svg: text, mode: 'remote', url };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? '请求超时' : e.message, url };
  }
}

/** 下载 plantuml.jar 到目标路径 */
async function downloadJar(destPath, onProgress) {
  const mirrors = [
    'https://github.com/plantuml/plantuml/releases/latest/download/plantuml.jar',
    'https://mirrors.aliyun.com/maven/repository/central/net/sourceforge/plantuml/plantuml/1.2024.7/plantuml-1.2024.7.jar',
    'https://repo1.maven.org/maven2/net/sourceforge/plantuml/plantuml/1.2024.7/plantuml-1.2024.7.jar',
  ];
  let lastErr = '';
  for (const url of mirrors) {
    try {
      if (typeof onProgress === 'function') onProgress('正在下载 ' + url);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) { lastErr = 'HTTP ' + res.status; continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 500000) { lastErr = '文件过小，可能下载失败'; continue; }
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, buf);
      return { ok: true, path: destPath, size: buf.length };
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, error: lastErr || '下载失败' };
}

module.exports = { detect, renderLocal, renderRemote, downloadJar };
