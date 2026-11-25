/**
 * 栅格化：把 SVG / HTML 片段转成 PNG data URL
 * 用途：导出 Word 时把公式、Mermaid、PlantUML 变成图片
 */

/** 从 SVG 文本里推算内禀尺寸 */
export function svgSize(svgText, fallback = { width: 600, height: 320 }) {
  const vb = /viewBox\s*=\s*["']\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*["']/i.exec(svgText);
  if (vb) {
    const w = parseFloat(vb[3]);
    const h = parseFloat(vb[4]);
    if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  }
  const wAttr = /\bwidth\s*=\s*["']([\d.]+)/i.exec(svgText);
  const hAttr = /\bheight\s*=\s*["']([\d.]+)/i.exec(svgText);
  if (wAttr && hAttr) {
    const w = parseFloat(wAttr[1]);
    const h = parseFloat(hAttr[1]);
    if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
  }
  return fallback;
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error('图片解码失败'));
    img.src = url;
  });
}

/**
 * SVG 文本 → PNG
 * @returns {Promise<{dataUrl:string,width:number,height:number}>}
 */
export async function svgToPng(svgText, opts = {}) {
  const scale = opts.scale || 2;
  const natural = svgSize(svgText, opts.fallback);
  const width = Math.max(1, Math.round(opts.width || natural.width));
  const height = Math.max(1, Math.round(opts.height || natural.height));

  // 补上显式尺寸，避免 Chromium 按 100% 计算导致 0 尺寸
  let svg = svgText.replace(/<svg\b([^>]*)>/i, (m, attrs) => {
    let a = attrs
      .replace(/\swidth\s*=\s*["'][^"']*["']/i, '')
      .replace(/\sheight\s*=\s*["'][^"']*["']/i, '');
    if (!/viewBox/i.test(a)) a += ` viewBox="0 0 ${width} ${height}"`;
    return `<svg${a} width="${width}" height="${height}">`;
  });
  svg = svg.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, at, css) => `<style${at}>${css}</style>`);

  const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return await drawToPng(img, width, height, scale, opts.background !== false);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function drawToPng(source, width, height, scale, bg) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d');
  if (bg) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

/**
 * 构造 `<foreignObject>` 包装的 SVG 文本。
 *
 * 关键实现要点：SVG 必须由 DOM + XMLSerializer 序列化生成，不能拼字符串。
 * KaTeX 输出的 MathML `<annotation>` 里带着原始 TeX，公式里的 `&`、`<`
 * 会让手工拼接的 SVG 变成非法 XML，`<img>` 解码便直接失败 —— 公式就会在
 * Word 里凭空消失。走 XMLSerializer 则所有文本/属性都会被正确转义。
 *
 * 单独导出，方便离线单测（不需要 canvas 也能校验 XML 合法性）。
 *
 * @param {string|Element} content HTML 字符串或待栅格化的元素
 * @returns {{ svg: string, width: number, height: number }}
 */
export function buildRasterSvg(content, { width, height, css = '', padding = 6 } = {}) {
  const w = Math.max(2, Math.round((width || 200) + padding * 2));
  const h = Math.max(2, Math.round((height || 40) + padding * 2));

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const XHTML_NS = 'http://www.w3.org/1999/xhtml';

  // 注意：不要手动 setAttribute('xmlns', ...)。
  // XMLSerializer 会依据 createElementNS 的命名空间自动补上 xmlns，
  // 再手工设一次就会变成重复属性（Attribute xmlns redefined），
  // 浏览器解析 SVG 时会直接判为非法文档。
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);

  const fo = document.createElementNS(SVG_NS, 'foreignObject');
  fo.setAttribute('x', '0');
  fo.setAttribute('y', '0');
  fo.setAttribute('width', String(w));
  fo.setAttribute('height', String(h));

  const box = document.createElementNS(XHTML_NS, 'div');
  box.setAttribute(
    'style',
    `margin:0;padding:${padding}px;width:${width || 200}px;box-sizing:content-box;` +
      'background:#fff;color:#000;display:flex;align-items:center;justify-content:center;'
  );

  if (css) {
    const style = document.createElementNS(XHTML_NS, 'style');
    style.textContent = css;
    box.appendChild(style);
  }

  const holder = document.createElementNS(XHTML_NS, 'span');
  holder.setAttribute('style', 'display:inline-block;white-space:nowrap;');
  if (content && typeof content === 'object' && content.nodeType === 1) {
    holder.appendChild(content.cloneNode(true));
  } else {
    holder.innerHTML = String(content == null ? '' : content);
  }
  box.appendChild(holder);
  fo.appendChild(box);
  svg.appendChild(fo);

  return { svg: new XMLSerializer().serializeToString(svg), width: w, height: h };
}

/**
 * 把一段 HTML 或一个 DOM 元素（配合内联 CSS + 内嵌字体）渲染成 PNG。
 * 用于把 KaTeX 公式搬进 Word。
 *
 * @param {string|Element} content HTML 字符串或待栅格化的元素
 */
export async function htmlToPng(content, { width, height, css = '', scale = 3, padding = 6 } = {}) {
  const built = buildRasterSvg(content, { width, height, css, padding });
  const w = built.width;
  const h = built.height;
  const blob = new Blob([built.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const out = await drawToPng(img, w, h, scale, true);
    return { dataUrl: out.dataUrl, width: w, height: h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * 清掉 SVG 根上「屏幕布局专用」的内联样式。
 *
 * 预览里为了让图表自适应，renderDiagramNode 会给 SVG 加
 * `max-width:100%; height:auto`。这些声明随 clone 序列化进 `<img>` 之后，
 * 会和 svgToPng 写死的 width/height 属性互相压制 —— 思维导图这类宽图
 * 会因此被压扁或按错误比例拉伸。导出前必须去掉。
 *
 * 只删尺寸类声明，颜色等其它内联样式原样保留。
 */
export function stripLayoutStyle(el) {
  if (!el || typeof el.getAttribute !== 'function') return el;
  const inline = el.getAttribute('style');
  if (!inline) return el;
  const cleaned = inline
    .replace(/(^|;)\s*(max-width|max-height|min-width|min-height|height|width)\s*:[^;]*/gi, '$1')
    .replace(/;;+/g, ';')
    .replace(/^[\s;]+|[\s;]+$/g, '');
  if (cleaned) el.setAttribute('style', cleaned);
  else el.removeAttribute('style');
  return el;
}

/** 把 DOM 元素里的 SVG 转成 PNG */
export async function domSvgToPng(svgEl, opts = {}) {
  if (!svgEl) throw new Error('缺少 SVG 元素');
  const clone = svgEl.cloneNode(true);
  // 去掉交互相关的属性，避免导出后跳动
  clone.querySelectorAll('[style*="cursor"]').forEach((n) => n.removeAttribute('style'));
  stripLayoutStyle(clone);

  const rect = svgEl.getBoundingClientRect();
  const vb = svgEl.viewBox && svgEl.viewBox.baseVal;
  const naturalW = (vb && vb.width) || rect.width || 600;
  const naturalH = (vb && vb.height) || rect.height || 320;
  const text = new XMLSerializer().serializeToString(clone);
  return svgToPng(text, { width: Math.round(naturalW), height: Math.round(naturalH), scale: opts.scale || 2 });
}
