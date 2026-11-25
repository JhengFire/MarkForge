/** 通用小工具 */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

export function debounce(fn, wait = 160) {
  let timer = 0;
  const wrapped = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  wrapped.flush = (...args) => {
    clearTimeout(timer);
    fn(...args);
  };
  wrapped.cancel = () => clearTimeout(timer);
  wrapped.wait = wait;
  return wrapped;
}

export function throttle(fn, wait = 60) {
  let last = 0;
  let timer = 0;
  return (...args) => {
    const now = Date.now();
    const rest = wait - (now - last);
    if (rest <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = 0;
        last = Date.now();
        fn(...args);
      }, rest);
    }
  };
}

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

/** 中文友好的 slug：保留中文/字母/数字，其余转连字符 */
export function slugify(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5\u3040-\u30ff-]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

/** 把可能是 Windows/相对路径的图片地址解析成 file:// URL */
export function resolveLocalUrl(src, baseDir) {
  const s = String(src || '').trim();
  if (!s) return s;
  if (/^(https?:|data:|blob:|file:)/i.test(s)) return s;
  if (!baseDir) return s;
  const base = String(baseDir).replace(/\\/g, '/').replace(/\/+$/, '');
  let p = s.replace(/\\/g, '/');
  if (/^[a-zA-Z]:\//.test(p)) return 'file:///' + encodeURI(p).replace(/#/g, '%23');
  if (p.startsWith('/')) return 'file://' + encodeURI(p).replace(/#/g, '%23');
  return 'file:///' + encodeURI(base + '/' + p).replace(/#/g, '%23');
}

export function fileUrlToPath(url) {
  let u = String(url || '');
  if (!u.startsWith('file://')) return u;
  u = u.slice(7);
  try {
    u = decodeURIComponent(u);
  } catch {
    /* ignore */
  }
  return u.replace(/^\/([A-Za-z]:)/, '$1');
}

export function formatBytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

export function formatTime(ts) {
  const d = new Date(ts);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 统计中英文混排的字数 */
export function countWords(text) {
  const s = String(text || '');
  const cjk = (s.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const words = (s.replace(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g, ' ').match(/[A-Za-z0-9_'-]+/g) || []).length;
  return { chars: s.length, cjk, words, total: cjk + words };
}

export function nextFrame() {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 把 </script> 之类破坏性内容转义，用于内联脚本 */
export function safeInlineJson(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
