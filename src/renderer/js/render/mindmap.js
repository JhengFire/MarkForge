/**
 * 思维导图渲染器（纯 SVG，无第三方依赖）
 *
 * 为什么不用 Mermaid 自带的 mindmap：
 *  1) 它输出静态 SVG，无法展开/折叠。节点一多（这份大纲 40+ 个）必然糊成一片；
 *  2) 布局固定为左右交替，节点多时横向过宽，且没有层级配色，辨识度差；
 *  3) 样式只能靠 Mermaid 主题配置，节点、连线、间距都调不动。
 *
 * 这里按 Mermaid mindmap 的**输入语法**自行解析并渲染，因此已有文档不用改写：
 *
 *   mindmap
 *       root((根节点))
 *           一级分支
 *               二级节点
 *           另一个分支[矩形]
 *
 * 支持 `((圆形))`、`(圆角)`、`[矩形]`、`{{六边形}}` 四种形状，其余按纯文本处理。
 * 布局为双侧 tidy-tree：根居中，一级分支左右各半，叶子按行均分纵向空间。
 * 折叠状态按源码哈希缓存，编辑文档时不会丢掉展开/收起的状态。
 *
 * 输出是纯 <rect>/<path>/<text>，没有 <foreignObject> —— 导出 Word 时栅格化最稳。
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ---------------- 视觉参数 ---------------- */
const PAD_X = 11;
const PAD_Y = 6;
const LINE_H = 19;
const H_GAP = 44; // 父子横向间距
const V_GAP = 9; // 叶子纵向间距
const MAX_TEXT_W = 250; // 单个节点文本折行宽度
const MAX_LINES = 2;
const TOGGLE_R = 7;
const ROOT_PAD_X = 18;

/** 一级分支配色（按出现顺序轮换） */
const BRANCH_COLORS = [
  '#3B6FF5', '#0EA47A', '#E8890C', '#D6336C',
  '#7048E8', '#0C8599', '#E8590C', '#2F9E44',
  '#C2255C', '#5C7CFA', '#0B7285', '#A61E4D',
];

/* ---------------- 折叠状态缓存 ---------------- */

/** key: 源码哈希；value: 被折叠节点的路径集合（如 "0/2"） */
const COLLAPSE_STATE = new Map();

function hashSource(src) {
  let h = 5381;
  for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + ':' + src.length;
}

/* ---------------- 解析 ---------------- */

/**
 * 解析 Mermaid mindmap 缩进语法。
 * 层级不按「每级固定几空格」计算，而是用缩进栈 —— 2 空格、4 空格、Tab 混排都能正确归层。
 */
export function parseMindmap(source) {
  const raw = String(source == null ? '' : source)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/);

  const lines = [];
  for (const line of raw) {
    if (!line.trim()) continue;
    if (/^\s*%%/.test(line)) continue; // Mermaid 注释
    lines.push(line.replace(/\t/g, '    '));
  }

  // 去掉首行的 `mindmap` 声明
  if (lines.length && lines[0].trim().toLowerCase() === 'mindmap') lines.shift();
  if (!lines.length) throw new Error('思维导图内容为空');

  const root = { text: '', shape: 'default', children: [], path: '' };
  const stack = [{ indent: -1, node: root }];

  for (const line of lines) {
    const indent = /^ */.exec(line)[0].length;
    const parsed = parseNodeLine(line.trim());

    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1].node;

    const node = {
      text: parsed.text,
      shape: parsed.shape,
      children: [],
      parent,
      path: parent.path ? parent.path + '/' + parent.children.length : String(parent.children.length),
      collapsed: false,
    };
    parent.children.push(node);
    stack.push({ indent, node });
  }

  // 根节点是那个虚拟节点唯一的子节点
  if (root.children.length !== 1) {
    throw new Error(
      root.children.length === 0
        ? '思维导图需要一个根节点'
        : '思维导图只能有一个根节点（第一行不要写两个同级节点）'
    );
  }

  const real = root.children[0];
  real.parent = null;
  real.level = 0;
  annotate(real, 0);
  return real;
}

/** Mermaid 的节点 id 只允许 ASCII 标识符 */
const ID_RE = /^[A-Za-z0-9_.\-]+$/;

/**
 * 拆出节点形状与文本。
 *
 * Mermaid mindmap 允许「id + 形状」的写法，id 只是内部标识、不参与显示：
 *     root((AI应用开发工程师 知识宽度))   → 显示「AI应用开发工程师 知识宽度」
 *     node1[矩形]                        → 显示「矩形」
 *
 * 所以形状必须出现在**行尾**；只有它前面那段是纯 ASCII id 时才被丢弃，
 * 否则括号就属于正文（例如 `PostgreSQL（向量扩展）` 用的是全角括号，本就不会命中）。
 */
function parseNodeLine(text) {
  const shapes = [
    { re: /^(.*?)\s*\(\(([\s\S]*)\)\)$/, shape: 'circle' },
    { re: /^(.*?)\s*\)\)([\s\S]*)\(\($/, shape: 'circle' }, // bang 形式 ))text((
    { re: /^(.*?)\s*\{\{([\s\S]*)\}\}$/, shape: 'hex' },
    { re: /^(.*?)\s*\(([\s\S]*)\)$/, shape: 'rounded' },
    { re: /^(.*?)\s*\[([\s\S]*)\]$/, shape: 'rect' },
  ];

  for (const { re, shape } of shapes) {
    const m = re.exec(text);
    if (!m) continue;
    const head = m[1].trim();
    const body = m[2].trim();
    if (!head) return { text: body, shape };
    if (ID_RE.test(head) && body) return { text: body, shape };
    break; // 前缀不是 id → 括号属于正文，按纯文本处理
  }
  return { text: text.trim(), shape: 'default' };
}

/** 补上层级、分支色、后代数量 */
function annotate(node, level, branchColor, branchIndex) {
  node.level = level;
  node.branchIndex = branchIndex == null ? -1 : branchIndex;
  node.branchColor = branchColor || '#3B6FF5';
  node.descendants = 0;
  node.children.forEach((c, i) => {
    const isBranch = level === 0;
    annotate(c, level + 1, isBranch ? BRANCH_COLORS[i % BRANCH_COLORS.length] : branchColor, isBranch ? i : branchIndex);
    node.descendants += 1 + c.descendants;
  });
}

/* ---------------- 文本测量与折行 ---------------- */

function makeMeasure(fontFamily, baseSize) {
  // 测试环境（纯 Node，没有 document）直接用字符估算分支
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
  const ctx = canvas && canvas.getContext && canvas.getContext('2d');

  if (!ctx) {
    // 没有 canvas 2D 上下文时（测试环境 / 极端受限环境）退化为按字符估算：
    // 中日韩字符约 1em 宽，西文约 0.55em。宁可略宽，也不要文字溢出节点。
    return (text, weight, size) => {
      let w = 0;
      for (const ch of text) {
        w += /[\u3400-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.55;
      }
      return Math.max(w, text.length * size * 0.5);
    };
  }

  return (text, weight, size) => {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    const w = ctx.measureText(text).width;
    // 中日韩字符在部分字体下 measureText 偏窄，按字符数兜一下，避免文字溢出节点
    const cjk = (text.match(/[\u3400-\u9fff\uff00-\uffef]/g) || []).length;
    return Math.max(w, cjk * size * 0.92);
  };
}

/** 中日韩字符：每个字都可以单独断行 */
const CJK_RE = /[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef\uf900-\ufaff]/;
/** 断行机会：空白与这些符号之后可以换行，用于拆分长串的英文词 */
const BREAK_RE = /[\s/、，,：:；;|·—\-]/;

/**
 * 把文本切成「不可再分」的断行单元。
 *
 * 逐字符硬切会把英文单词劈开（`ConfigMap` → `ConfigM` / `ap`），
 * 所以拉丁字母要整词保留，只在空白、斜杠、顿号等位置留断点；
 * 中文本身可以逐字断行。
 */
function tokenize(text) {
  const tokens = [];
  let buf = '';
  for (const ch of text) {
    if (CJK_RE.test(ch)) {
      if (buf) {
        tokens.push(buf);
        buf = '';
      }
      tokens.push(ch);
    } else if (BREAK_RE.test(ch)) {
      buf += ch;
      tokens.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) tokens.push(buf);
  return tokens;
}

function wrapText(measure, text, maxW, weight, size) {
  if (measure(text, weight, size) <= maxW) return [text];

  const lines = [];
  let cur = '';

  const hardSplit = (tok) => {
    // 单个词就宽过整行（长 URL、巨长的英文标识符）→ 只能硬切
    while (measure(tok, weight, size) > maxW && tok.length > 1) {
      let cut = tok.length - 1;
      while (cut > 1 && measure(tok.slice(0, cut), weight, size) > maxW) cut--;
      lines.push(tok.slice(0, cut));
      tok = tok.slice(cut);
    }
    return tok;
  };

  for (const tk of tokenize(text)) {
    const next = cur + tk;
    if (cur && measure(next, weight, size) > maxW) {
      lines.push(cur.replace(/\s+$/, ''));
      cur = hardSplit(tk.replace(/^\s+/, ''));
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length <= MAX_LINES) return lines;

  // 超出两行：第二行吃掉剩余内容，再按宽度回退并补省略号
  let rest = lines.slice(1).join('');
  while (rest.length > 1 && measure(rest + '…', weight, size) > maxW) rest = rest.slice(0, -1);
  return [lines[0], rest + '…'];
}

/* ---------------- 布局 ---------------- */

function nodeFont(level, baseSize) {
  if (level === 0) return { weight: 600, size: baseSize + 2 };
  if (level === 1) return { weight: 600, size: baseSize };
  return { weight: 400, size: baseSize - 1 };
}

/**
 * 测量所有可见节点，写入 w/h/lines。
 * 被折叠的子树不参与测量，避免影响宽度计算。
 */
function measureTree(node, measure, baseSize) {
  const f = nodeFont(node.level, baseSize);
  const padX = node.level === 0 ? ROOT_PAD_X : PAD_X;
  // 折行宽度按字号等比缩放：放大字号时每行的字数不变，不会因为变宽而被迫塞更多字
  const maxW = Math.round((MAX_TEXT_W * baseSize) / 14);
  // 行高与纵向内边距同样按字号缩放，否则字号调大后折行文本会叠在一起
  const scale = baseSize / 14;
  node.lines = wrapText(measure, node.text, maxW, f.weight, f.size);
  node.truncated = node.lines.length > 0 && /…$/.test(node.lines[node.lines.length - 1]);
  node.fw = f.weight;
  node.fs = f.size;
  node.padX = padX;
  node.lh = Math.round(LINE_H * scale);
  node.padY = Math.round(PAD_Y * scale);
  node.w = Math.max(...node.lines.map((l) => measure(l, f.weight, f.size))) + padX * 2;
  node.h = node.lines.length * node.lh + node.padY * 2;
  if (node.level === 0) node.h += Math.round(6 * scale);
  if (node.collapsed) return;
  for (const c of node.children) measureTree(c, measure, baseSize);
}

/** 单侧布局：dir=1 向右，dir=-1 向左。返回该侧总高。 */
function layoutSide(nodes, dir, layerMaxW) {
  let cursor = 0;

  const walk = (node, depth) => {
    node.depth = depth;
    node.dir = dir;
    // 必须在这里记录宽度：叶子节点的 depth 往往是最深的一层，
    // 如果只在「有子节点」的分支里记录，最深层就没有列宽，所有叶子会堆到同一个 x 上。
    layerMaxW[depth] = Math.max(layerMaxW[depth] || 0, node.w);

    const kids = node.collapsed ? [] : node.children;
    if (!kids.length) {
      node.y = cursor + node.h / 2;
      cursor += node.h + V_GAP;
      return;
    }
    for (const c of kids) walk(c, depth + 1);
    node.y = (kids[0].y + kids[kids.length - 1].y) / 2;
  };

  for (const n of nodes) walk(n, 1);
  return Math.max(0, cursor - V_GAP);
}

function collectByDepth(nodes, out = []) {
  for (const n of nodes) {
    out.push(n);
    if (!n.collapsed) collectByDepth(n.children, out);
  }
  return out;
}

/**
 * 完整布局：根居中，一级分支左右对半分。
 * 返回 { nodes, width, height, minX }
 */
function layoutTree(root) {
  const edge = TOGGLE_R + 12;

  // 根节点被折叠（= 全部收起）时必须单独返回，否则子节点没被 measure，
  // 后面的 layerMaxW / layerX 会算出 NaN。
  if (root.collapsed || !root.children.length) {
    root.y = root.h / 2;
    root.ax = 0;
    root.depth = 0;
    root.dir = 0;
    return {
      nodes: [root],
      minX: -root.w / 2 - edge,
      maxX: root.w / 2 + edge,
      // 与下方通用布局保持一致：上下各留 14px 余量。
      // 少了 minY，paint() 里的 oy 会算成 NaN，根节点文字与形状都会画不出来。
      minY: -14,
      maxY: root.h + 14,
      width: root.w + edge * 2,
      height: root.h + 28,
    };
  }

  const kids = root.children;
  const half = Math.ceil(kids.length / 2);
  const rightGroup = kids.slice(0, half);
  const leftGroup = kids.slice(half);

  const layerMaxW = {};
  layerMaxW[1] = Math.max(0, ...kids.map((k) => k.w));

  const hR = rightGroup.length ? layoutSide(rightGroup, 1, layerMaxW) : 0;
  const hL = leftGroup.length ? layoutSide(leftGroup, -1, layerMaxW) : 0;

  // 根节点单独占一行：它自己有多高就多高
  const contentH = Math.max(hR, hL, root.h);
  const offsetR = (contentH - hR) / 2;
  const offsetL = (contentH - hL) / 2;

  if (rightGroup.length) shiftY(rightGroup, offsetR);
  if (leftGroup.length) shiftY(leftGroup, offsetL);

  root.y = contentH / 2;
  root.depth = 0;
  root.dir = 0;

  // 横向：按层累加列宽，左右对称
  const rootEdge = root.w / 2 + H_GAP;
  const layerX = { 1: rootEdge };
  const maxDepth = Math.max(1, ...Object.keys(layerMaxW).map(Number));
  for (let d = 2; d <= maxDepth; d++) {
    layerX[d] = layerX[d - 1] + (layerMaxW[d - 1] || 0) + H_GAP;
  }

  const all = [root, ...collectByDepth(kids)];
  for (const n of all) {
    if (n === root) {
      n.ax = 0;
    } else {
      const x = layerX[n.depth] || rootEdge;
      n.ax = n.dir === 1 ? x : -x;
    }
  }

  // 计算包围盒（左侧节点的 ax 是右边缘）
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const n of all) {
    const left = n === root ? n.ax - n.w / 2 : n.dir === 1 ? n.ax : n.ax - n.w;
    const right = n === root ? n.ax + n.w / 2 : n.dir === 1 ? n.ax + n.w : n.ax;
    minX = Math.min(minX, left);
    maxX = Math.max(maxX, right);
    minY = Math.min(minY, n.y - n.h / 2);
    maxY = Math.max(maxY, n.y + n.h / 2);
  }

  // 折叠按钮占的横向余量
  minX -= TOGGLE_R + 12;
  maxX += TOGGLE_R + 12;
  minY -= 14;
  maxY += 14;

  return { nodes: all, minX, minY, width: maxX - minX, height: maxY - minY };
}

function shiftY(nodes, dy) {
  for (const n of nodes) {
    n.y += dy;
    if (!n.collapsed) shiftY(n.children, dy);
  }
}

/* ---------------- 渲染 ---------------- */

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  if (attrs) for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  return el;
}

function nodeBox(n, ox, oy) {
  if (n.level === 0) {
    return { x: ox + n.ax - n.w / 2, y: oy + n.y - n.h / 2, w: n.w, h: n.h };
  }
  return { x: ox + (n.dir === 1 ? n.ax : n.ax - n.w), y: oy + n.y - n.h / 2, w: n.w, h: n.h };
}

function roundRectPath(x, y, w, h, r) {
  const rr = Math.min(r, h / 2, w / 2);
  return (
    `M${x + rr},${y}` +
    `H${x + w - rr}` +
    `A${rr},${rr} 0 0 1 ${x + w},${y + rr}` +
    `V${y + h - rr}` +
    `A${rr},${rr} 0 0 1 ${x + w - rr},${y + h}` +
    `H${x + rr}` +
    `A${rr},${rr} 0 0 1 ${x},${y + h - rr}` +
    `V${y + rr}` +
    `A${rr},${rr} 0 0 1 ${x + rr},${y}` +
    'Z'
  );
}

function drawNode(group, n, ox, oy, onToggle) {
  const box = nodeBox(n, ox, oy);
  const isRoot = n.level === 0;
  const isBranch = n.level === 1;

  const fill = isRoot ? '#1F2933' : isBranch ? n.branchColor : '#FFFFFF';
  const stroke = isRoot ? '#1F2933' : n.branchColor;
  const color = isRoot || isBranch ? '#FFFFFF' : '#26323D';

  // 形状与文字放进同一个 <g>，省略提示挂在这个 <g> 的 <title> 上。
  // 只挂在 <rect> 上时，上层的 <text> 会挡住鼠标，移到文字上就看不到提示。
  const nodeGroup = svgEl('g', { class: 'mm-node-group' });
  if (n.truncated) {
    const tip = svgEl('title');
    tip.textContent = n.text;
    nodeGroup.appendChild(tip);
  }
  group.appendChild(nodeGroup);

  const shape = document.createElementNS(SVG_NS, 'rect');
  const radius = n.shape === 'circle' ? box.h / 2 : isRoot ? 9 : 6;
  shape.setAttribute('x', box.x);
  shape.setAttribute('y', box.y);
  shape.setAttribute('width', box.w);
  shape.setAttribute('height', box.h);
  shape.setAttribute('rx', String(radius));
  shape.setAttribute('fill', fill);
  shape.setAttribute('stroke', stroke);
  shape.setAttribute('stroke-width', isRoot ? '0' : isBranch ? '0' : '1.2');
  shape.setAttribute('class', 'mm-node');
  nodeGroup.appendChild(shape);

  // 文本：根与一级分支居中，其余左对齐（左侧分支右对齐）
  const anchor = isRoot ? 'middle' : n.dir === 1 ? 'start' : 'end';
  const tx = isRoot
    ? ox + n.ax
    : n.dir === 1
      ? box.x + n.padX
      : box.x + box.w - n.padX;

  const text = svgEl('text', {
    x: tx,
    y: oy + n.y - (n.lines.length - 1) * (n.lh / 2) + Math.round(n.fs * 0.36),
    'text-anchor': anchor,
    'font-size': n.fs,
    'font-weight': n.fw,
    fill: color,
    class: 'mm-label',
  });
  for (let i = 0; i < n.lines.length; i++) {
    const tspan = svgEl('tspan', { x: tx, dy: i === 0 ? 0 : n.lh });
    tspan.textContent = n.lines[i];
    text.appendChild(tspan);
  }
  nodeGroup.appendChild(text);

  // 折叠开关：只给有子节点的节点画
  if (n.children.length) {
    const cx = n.dir === 1 || isRoot ? box.x + box.w + TOGGLE_R + 4 : box.x - TOGGLE_R - 4;
    const cy = oy + n.y;

    const hit = svgEl('circle', {
      cx,
      cy,
      r: TOGGLE_R + 4,
      fill: 'transparent',
      class: 'mm-toggle-hit',
    });
    const dot = svgEl('circle', {
      cx,
      cy,
      r: TOGGLE_R,
      fill: '#FFFFFF',
      stroke: n.branchColor,
      'stroke-width': '1.2',
      class: 'mm-toggle',
    });
    const sign = svgEl('path', {
      d: n.collapsed
        ? `M${cx - 3.2},${cy}H${cx + 3.2}M${cx},${cy - 3.2}V${cy + 3.2}`
        : `M${cx - 3.2},${cy}H${cx + 3.2}`,
      stroke: n.branchColor,
      'stroke-width': '1.6',
      'stroke-linecap': 'round',
      class: 'mm-toggle-sign',
    });

    // 折叠后提示被收起的后代数量
    let badge = null;
    if (n.collapsed) {
      badge = svgEl('text', {
        x: n.dir === 1 || isRoot ? cx - TOGGLE_R - 6 : cx + TOGGLE_R + 6,
        y: cy + 4,
        'text-anchor': n.dir === 1 || isRoot ? 'end' : 'start',
        'font-size': '11',
        fill: '#7B8794',
        class: 'mm-badge',
      });
      badge.textContent = `${n.descendants}`;
      group.appendChild(badge);
    }

    const toggleGroup = svgEl('g', { class: 'mm-toggle-group', style: 'cursor:pointer' });
    toggleGroup.appendChild(hit);
    toggleGroup.appendChild(dot);
    toggleGroup.appendChild(sign);
    toggleGroup.addEventListener('click', (e) => {
      e.stopPropagation();
      n.collapsed = !n.collapsed;
      onToggle();
    });
    // 键盘可达：可聚焦 + 回车/空格切换
    toggleGroup.setAttribute('tabindex', '0');
    toggleGroup.setAttribute('role', 'button');
    toggleGroup.setAttribute('aria-label', n.collapsed ? '展开 ' + n.text : '收起 ' + n.text);
    toggleGroup.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        n.collapsed = !n.collapsed;
        onToggle();
      }
    });
    group.appendChild(toggleGroup);
  }
}

/**
 * 渲染到容器。
 *
 * @param {HTMLElement} container
 * @param {string} source       Mermaid mindmap 源码
 * @param {object} opts         { fontFamily, fontSize, dark }
 * @returns {{ width:number, height:number, nodeCount:number }}
 */
export function renderMindmap(container, source, opts = {}) {
  const fontFamily =
    opts.fontFamily || '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
  const baseSize = Number(opts.fontSize) || 14;
  const measure = makeMeasure(fontFamily, baseSize);

  const root = parseMindmap(source);

  // 恢复上次的折叠状态（按源码哈希；内容一改就重置）
  const stateKey = hashSource(source);
  const collapsed = COLLAPSE_STATE.get(stateKey);
  if (collapsed) {
    const apply = (n) => {
      if (collapsed.has(n.path)) n.collapsed = true;
      if (!n.collapsed) n.children.forEach(apply);
    };
    // 也要能恢复「根节点被折叠」的状态（根上的开关等于全部收起）
    apply(root);
  } else {
    COLLAPSE_STATE.set(stateKey, new Set());
  }

  /* ---- 画布视图：适配宽度 + 拖动平移 + Ctrl+滚轮缩放 ---- */
  const view = { scale: 0, tx: 0, ty: 0, fit: 1, userAdjusted: false };
  let wrapEl = null;
  let zoomLabel = null;
  let natW = 0;
  let natH = 0;
  let baseH = 0;

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const MIN_SCALE = (fit) => fit * 0.6;
  const MAX_SCALE = 3;

  /**
   * 画布可用宽度：取预览窗格宽度，而不是正文栏宽度。
   * 正文栏有 860px 上限和左右内边距，画布跟着它缩会明显比预览框窄；
   * 这里把画布撑到窗格宽度，并用负外边距抵消正文栏的内边距。
   */
  const fitWidth = () => {
    const pane = wrapEl.closest ? wrapEl.closest('.preview-scroll') : null;
    const box = wrapEl.parentElement;
    const outer = box ? box.clientWidth : 0;
    if (pane && outer) {
      const paneW = pane.clientWidth;
      const gutter = Math.max(0, Math.round((paneW - outer) / 2));
      wrapEl.style.width = paneW + 'px';
      wrapEl.style.marginLeft = -gutter + 'px';
      return paneW;
    }
    return wrapEl.clientWidth || natW || 1;
  };

  /** 把当前平移/缩放写到 CSS 变量上（SVG 本身保持自然坐标，导出不受影响） */
  const applyView = (refit = false) => {
    if (!wrapEl) return;
    const vw = fitWidth();
    if (refit || !view.scale) {
      view.fit = Math.min(1, vw / natW);
      view.scale = view.fit;
      view.tx = (vw - natW * view.scale) / 2;
      view.ty = 0;
      baseH = Math.max(60, Math.round(natH * view.scale));
    }
    const scaledW = natW * view.scale;
    const scaledH = natH * view.scale;
    // 比视口小就居中，比视口大就限制在边界内拖动
    view.tx = scaledW <= vw ? (vw - scaledW) / 2 : clamp(view.tx, vw - scaledW, 0);
    view.ty = scaledH <= baseH ? (baseH - scaledH) / 2 : clamp(view.ty, baseH - scaledH, 0);

    wrapEl.style.height = baseH + 'px';
    wrapEl.style.setProperty('--mm-tx', view.tx.toFixed(2) + 'px');
    wrapEl.style.setProperty('--mm-ty', view.ty.toFixed(2) + 'px');
    wrapEl.style.setProperty('--mm-scale', String(view.scale));
    if (zoomLabel) updateZoomLabel();
  };

  /** 缩放百分比（相对「适配宽度」的 100%） */
  const updateZoomLabel = () => {
    if (!zoomLabel || !view.fit) return;
    zoomLabel.textContent = Math.round((view.scale / view.fit) * 100) + '%';
  };

  /** 以画布内某个点为中心缩放 */
  const zoomAt = (factor, px, py) => {
    const next = clamp(view.scale * factor, MIN_SCALE(view.fit), MAX_SCALE);
    if (!Number.isFinite(next) || Math.abs(next - view.scale) < 1e-4) return;
    const cx = (px - view.tx) / view.scale;
    const cy = (py - view.ty) / view.scale;
    view.scale = next;
    view.tx = px - cx * next;
    view.ty = py - cy * next;
    view.userAdjusted = true;
    applyView();
  };

  /** 滚轮增量归一化：鼠标一格通常 ±100，触摸板可能是 ±1，按不同系数换算 */
  const wheelFactor = (e) => {
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 16; // 行
    else if (e.deltaMode === 2) d *= 400; // 页
    const k = Math.abs(d) < 20 ? 0.012 : 0.0015;
    return Math.exp(-d * k);
  };

  /** 画布右上角的缩放控件：滚轮被系统截走时也能用 */
  const buildZoomBar = (wrap) => {
    const bar = document.createElement('div');
    bar.className = 'mm-zoom';

    const btn = (act, text, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('data-mm', act);
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const vw = wrap.clientWidth;
        if (act === 'reset') {
          view.userAdjusted = false;
          applyView(true);
          return;
        }
        zoomAt(act === 'in' ? 1.25 : 0.8, vw / 2, baseH / 2);
      });
      return b;
    };

    const label = document.createElement('span');
    label.className = 'mm-zoom-val';
    label.textContent = '100%';

    bar.appendChild(btn('out', '−', '缩小'));
    bar.appendChild(label);
    bar.appendChild(btn('in', '+', '放大'));
    bar.appendChild(btn('reset', '重置', '恢复适配宽度'));
    wrap.appendChild(bar);
    zoomLabel = label;
  };

  /** 空白处拖动平移；Ctrl+滚轮以指针为中心缩放 */
  const bindViewport = (wrap) => {
    let drag = null;

    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const t = e.target;
      // 节点、折叠按钮、缩放控件上的按下不参与拖动画布
      if (t && typeof t.closest === 'function' && t.closest('.mm-node-group, .mm-toggle-group, .mm-zoom')) return;
      drag = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
      view.userAdjusted = true;
      wrap.classList.add('mm-dragging');
      try { wrap.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      e.preventDefault();
    });

    wrap.addEventListener('pointermove', (e) => {
      if (!drag) return;
      view.tx = drag.tx + (e.clientX - drag.x);
      view.ty = drag.ty + (e.clientY - drag.y);
      applyView();
    });

    const endDrag = (e) => {
      if (!drag) return;
      drag = null;
      wrap.classList.remove('mm-dragging');
      try { wrap.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    };
    wrap.addEventListener('pointerup', endDrag);
    wrap.addEventListener('pointercancel', endDrag);

    wrap.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey && !e.metaKey) return; // 不按 Ctrl 时交还给页面滚动
        e.preventDefault();
        const rect = wrap.getBoundingClientRect();
        zoomAt(wheelFactor(e), e.clientX - rect.left, e.clientY - rect.top);
      },
      { passive: false }
    );
  };

  const paint = () => {
    measureTree(root, measure, baseSize);
    const lay = layoutTree(root);

    const svg = svgEl('svg', {
      xmlns: SVG_NS,
      viewBox: `0 0 ${Math.round(lay.width)} ${Math.round(lay.height)}`,
      width: Math.round(lay.width),
      height: Math.round(lay.height),
      'data-mindmap': '1',
      style: `font-family:${fontFamily}`,
    });
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const ox = -lay.minX;
    const oy = -lay.minY;

    const edgeLayer = svgEl('g', { class: 'mm-edges' });
    const nodeLayer = svgEl('g', { class: 'mm-nodes' });
    svg.appendChild(edgeLayer);
    svg.appendChild(nodeLayer);

    // 连线：父节点出口 → 子节点入口的三次贝塞尔
    // 只要父节点是展开的就画连线 —— 节点自己折叠了也要连到父节点，
    // 否则收起一级分支后，根与一级分支之间会整段断开。
    for (const n of lay.nodes) {
      if (!n.parent || n.parent.collapsed) continue;
      const pb = nodeBox(n.parent, ox, oy);
      const cb = nodeBox(n, ox, oy);
      const x1 = n.dir === 1 ? pb.x + pb.w : pb.x;
      const y1 = oy + n.parent.y;
      const x2 = n.dir === 1 ? cb.x : cb.x + cb.w;
      const y2 = oy + n.y;
      const mx = (x1 + x2) / 2;
      edgeLayer.appendChild(
        svgEl('path', {
          d: `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`,
          fill: 'none',
          stroke: n.branchColor,
          'stroke-width': '1.4',
          'stroke-opacity': '0.45',
          'stroke-linecap': 'round',
        })
      );
    }

    for (const n of lay.nodes) drawNode(nodeLayer, n, ox, oy, redraw);

    const wrap = document.createElement('div');
    wrap.className = 'mm-viewport';
    wrap.appendChild(svg);

    container.innerHTML = '';
    container.appendChild(wrap);

    wrapEl = wrap;
    natW = Math.round(lay.width);
    natH = Math.round(lay.height);
    bindViewport(wrap);
    buildZoomBar(wrap);
    // 用户没手动缩放/平移过时跟随容器宽度重新适配
    applyView(!view.userAdjusted);

    return svg;
  };

  let raf = 0;
  const redraw = () => {
    // 合并同一帧内的多次点击
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      const store = COLLAPSE_STATE.get(stateKey);
      if (store) {
        store.clear();
        const walk = (n) => {
          if (n.collapsed) store.add(n.path);
          if (!n.collapsed) n.children.forEach(walk);
        };
        walk(root);
      }
      paint();
    });
  };

  const svg = paint();

  // 容器宽度变化（切换分栏 / 窗口缩放）时重新适配，除非用户已经手动缩放或平移过
  if (typeof ResizeObserver === 'function') {
    let lastW = wrapEl ? wrapEl.clientWidth : 0;
    const ro = new ResizeObserver(() => {
      const w = wrapEl ? wrapEl.clientWidth : 0;
      if (!w || w === lastW) return;
      lastW = w;
      if (!view.userAdjusted) applyView(true);
    });
    ro.observe(container);
  }

  return {
    width: Number(svg.getAttribute('width')),
    height: Number(svg.getAttribute('height')),
    nodeCount: countAll(root),
  };
}

/**
 * 导出前把思维导图的可视窗口拆掉，还原成裸 SVG。
 *
 * 画布的平移/缩放只作用在 `.mm-viewport` 的 CSS 变量上，SVG 本身仍是自然坐标；
 * 拆掉窗口后，HTML / PDF / 打印拿到的就是完整、未缩放的图。
 * 返回的函数用于恢复页面结构。
 */
export function prepareMindmapExport(rootEl) {
  if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return () => {};
  const saved = [];
  for (const wrap of Array.from(rootEl.querySelectorAll('.mm-viewport'))) {
    const svg = wrap.querySelector('svg');
    if (!svg || !wrap.parentNode) continue;
    saved.push({ wrap, svg, parent: wrap.parentNode, next: wrap.nextSibling });
    wrap.parentNode.replaceChild(svg, wrap);
  }
  return () => {
    for (let i = saved.length - 1; i >= 0; i--) {
      const { wrap, svg, parent, next } = saved[i];
      parent.insertBefore(wrap, next && next.parentNode === parent ? next : null);
      wrap.appendChild(svg);
    }
  };
}

function countAll(node) {
  let n = 1;
  for (const c of node.children) n += countAll(c);
  return n;
}

/** 供测试使用：不依赖 DOM 的纯解析结果 */
export { hashSource };

/**
 * 仅供测试：解析 + 布局，返回每个可见节点的包围盒（不生成 SVG）。
 *
 * @param {string} source
 * @param {{fontSize?:number, fontFamily?:string, collapse?:string[]}} opts
 *        collapse 是要折叠的节点路径数组，如 ['0', '0/2']
 */
export function layoutForTest(source, opts = {}) {
  const baseSize = Number(opts.fontSize) || 14;
  const measure = makeMeasure(opts.fontFamily || 'sans-serif', baseSize);
  const root = parseMindmap(source);

  if (opts.collapse && opts.collapse.length) {
    const apply = (n) => {
      if (opts.collapse.includes(n.path)) n.collapsed = true;
      if (!n.collapsed) n.children.forEach(apply);
    };
    apply(root);
  }

  measureTree(root, measure, baseSize);
  const lay = layoutTree(root);
  const ox = -lay.minX;
  const oy = -lay.minY;

  return {
    width: lay.width,
    height: lay.height,
    root,
    nodes: lay.nodes.map((n) => {
      const b = nodeBox(n, ox, oy);
      return {
        text: n.text,
        level: n.level,
        path: n.path,
        dir: n.dir,
        x: b.x,
        y: b.y,
        w: b.w,
        h: b.h,
        lines: n.lines.slice(),
      };
    }),
  };
}
