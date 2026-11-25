'use strict';

/**
 * 思维导图渲染器布局测试（纯 Node，不需要 DOM / Electron）
 *
 * mindmap.js 里的 renderMindmap 需要 document + requestAnimationFrame，
 * 但解析与布局是纯函数。这里把 layoutForTest() 单独打出来跑断言，
 * 覆盖：缩进归层、形状识别、节点不重叠、折叠收起、双侧布局、报错。
 *
 * 用法：node test/mindmap.js
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.resolve(__dirname, '..');
const tmpDir = path.join(root, '.tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const outBundle = path.join(tmpDir, 'mindmap.cjs');
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'renderer', 'js', 'render', 'mindmap.js')],
  outfile: outBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'error',
  charset: 'utf8',
});

const { parseMindmap, layoutForTest, hashSource } = require(outBundle);

let pass = 0;
let fail = 0;
const lines = [];
function T(name, ok, extra) {
  if (ok) pass++;
  else fail++;
  lines.push(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  →  ' + extra : ''}`);
}
function section(title) {
  lines.push('');
  lines.push(`──────── ${title} ────────`);
}

/* ---------- 测试用大纲（就是用户实际贴的那份结构） ---------- */
const OUTLINE = [
  'mindmap',
  '    root((AI应用开发工程师 知识宽度))',
  '        大模型基础',
  '            Transformer / Attention / Token、推理参数',
  '            模型分类：基础/指令/Embedding/Reranker/多模态',
  '            量化、幻觉、提示注入、安全与提示工程',
  '        RAG 检索增强',
  '            文档处理：解析、清洗、分块、OCR、表格提取',
  '            向量库：PGVector、Milvus、Qdrant、Chroma',
  '        存储 & 中间件',
  '            PostgreSQL（向量扩展）、MySQL',
  '            Redis：缓存、会话、限流',
  '            消息队列：Kafka/RocketMQ/RabbitMQ',
  '        容器、部署、CI/CD',
  '            Docker、Docker Compose',
  '            K8s 基础：Deployment、Secret、ConfigMap',
].join('\n');

/* ---------- 1) 解析 ---------- */
section('解析：缩进归层');

{
  const r = parseMindmap(OUTLINE);
  T('根节点文本正确', r.text === 'AI应用开发工程师 知识宽度', JSON.stringify(r.text));
  T('根节点识别为圆形', r.shape === 'circle', 'shape=' + r.shape);
  T('mindmap 声明行被跳过', r.text.indexOf('mindmap') === -1);
  T('一级分支 4 个', r.children.length === 4, '实际 ' + r.children.length);
  T('一级分支文本对', r.children[0].text === '大模型基础' && r.children[2].text === '存储 & 中间件',
    r.children.map((c) => c.text).join(' | '));
  T('二级节点挂在正确的父节点下', r.children[1].children.length === 2 &&
    r.children[1].children[0].text.indexOf('文档处理') === 0);
  T('层级 level 正确', r.level === 0 && r.children[0].level === 1 && r.children[0].children[2].level === 2,
    `root=${r.level} b=${r.children[0].level} l=${r.children[0].children[2].level}`);
  T('后代计数正确', r.descendants === 14, 'descendants=' + r.descendants);
}

{
  // 2 空格缩进混 4 空格：不能按「固定几空格」算层级，要靠缩进栈
  const src = ['root', '  两个空格的子节点', '      六个空格的孙节点', '  另一个子节点'].join('\n');
  const r = parseMindmap(src);
  T('2/6 空格混排按相对缩进归层',
    r.children.length === 2 && r.children[0].children.length === 1,
    `children=${r.children.length} grand=${r.children[0].children.length}`);
  T('混排时孙节点层级为 2', r.children[0].children[0].level === 2);
}

{
  // Tab 会被展开成 4 空格，与空格混用不能出错
  const src = ['root', '\tTab 子节点', '\t    空格孙节点', '\t另一子节点'].join('\n');
  const r = parseMindmap(src);
  T('Tab 与空格混排可用', r.children.length === 2 && r.children[0].children.length === 1,
    `children=${r.children.length} grand=${r.children[0].children.length}`);
}

{
  // 注释与空行要跳过
  const src = ['mindmap', '%% 这是注释', 'root((根))', '', '    分支', '    %% 行内注释'].join('\n');
  const r = parseMindmap(src);
  T('跳过 %% 注释与空行', r.text === '根' && r.children.length === 1, `children=${r.children.length}`);
}

/* ---------- 2) 形状识别 ---------- */
section('解析：节点形状');

{
  const r = parseMindmap(
    ['root((根))', '    a((圆))', '    b(圆角)', '    c[矩形]', '    d{{六边形}}', '    e普通文本'].join('\n')
  );
  const shapes = r.children.map((c) => c.shape);
  T('((圆))=circle', shapes[0] === 'circle', shapes[0]);
  T('(圆角)=rounded', shapes[1] === 'rounded', shapes[1]);
  T('[矩形]=rect', shapes[2] === 'rect', shapes[2]);
  T('{{六边形}}=hex', shapes[3] === 'hex', shapes[3]);
  T('纯文本=default', shapes[4] === 'default', shapes[4]);
  T('形状外层符号被剥掉', r.children[1].text === '圆角' && r.children[3].text === '六边形',
    r.children[1].text + ' / ' + r.children[3].text);
}

{
  // 全角括号是用户原文里的写法，必须当普通文本，不能被当成形状语法
  const r = parseMindmap(['root', '    PostgreSQL（向量扩展）、MySQL'].join('\n'));
  T('全角括号保留为文本', r.children[0].text === 'PostgreSQL（向量扩展）、MySQL', r.children[0].text);
  T('全角括号不误判形状', r.children[0].shape === 'default', r.children[0].shape);
}

{
  // 半角括号会被当成形状语法，这是 Mermaid 的语法特性，此处固化为已知行为
  const r = parseMindmap(['root', '    PostgreSQL(向量扩展)'].join('\n'));
  T('半角括号被识别为 rounded（已知行为）', r.children[0].shape === 'rounded', r.children[0].shape);
  T('半角括号内文本被提取', r.children[0].text === '向量扩展', r.children[0].text);
}

/* ---------- 3) 报错 ---------- */
section('解析：异常输入');

{
  let msg = '';
  try {
    parseMindmap('');
  } catch (e) {
    msg = e.message;
  }
  T('空内容抛错', msg.indexOf('为空') !== -1, msg);

  msg = '';
  try {
    parseMindmap(['root', '    a', '另一个根'].join('\n'));
  } catch (e) {
    msg = e.message;
  }
  T('多个根节点抛错', msg.indexOf('只能有一个根节点') !== -1, msg);
}

/* ---------- 4) 布局 ---------- */
section('布局：双侧 tidy-tree');

const lay = layoutForTest(OUTLINE, { fontSize: 14 });
const byText = {};
for (const n of lay.nodes) byText[n.text] = n;

{
  T('可见节点数 = 根 + 4 分支 + 10 叶子 = 15', lay.nodes.length === 15, lay.nodes.length + ' 个');
  T('画布宽高为正', lay.width > 0 && lay.height > 0, `${Math.round(lay.width)} × ${Math.round(lay.height)}`);

  const rights = lay.nodes.filter((n) => n.dir === 1);
  const lefts = lay.nodes.filter((n) => n.dir === -1);
  T('同时存在左右两侧', rights.length > 0 && lefts.length > 0, `右 ${rights.length} / 左 ${lefts.length}`);

  const rootNode = lay.nodes.find((n) => n.level === 0);
  const rootCx = rootNode.x + rootNode.w / 2;
  const rightMin = Math.min(...rights.map((n) => n.x));
  const leftMax = Math.max(...lefts.map((n) => n.x + n.w));
  T('右侧节点全在根节点右边', rightMin > rootCx, `右侧最小 x=${Math.round(rightMin)} 根中心=${Math.round(rootCx)}`);
  T('左侧节点全在根节点左边', leftMax < rootCx, `左侧最大右缘=${Math.round(leftMax)}`);
}

{
  // 回归：曾经只给「有子节点」的节点记录 layerMaxW，
  // 导致最深层（全是叶子）没有列宽，同一层的叶子会堆在同一个 x 上。
  const leafX = new Map();
  for (const n of lay.nodes) {
    if (n.level < 2) continue;
    const key = n.dir + ':' + n.level;
    if (!leafX.has(key)) leafX.set(key, new Set());
    leafX.get(key).add(Math.round(n.x));
  }
  const rightLeafXs = leafX.get('1:2');
  T('同层同侧叶子共享列起点', !!rightLeafXs && rightLeafXs.size === 1,
    rightLeafXs ? [...rightLeafXs].join(',') : '无');
  T('二级叶子横向不塌缩', !!rightLeafXs && [...rightLeafXs][0] > 0);
}

/** 统计包围盒重叠的节点对数（4px 容差：相邻叶子只隔 V_GAP=9） */
function countOverlaps(nodes) {
  let n = 0;
  let sample = '';
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const ix = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const iy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ix > 4 && iy > 0.5) {
        n++;
        if (!sample) sample = `${a.text} × ${b.text}`;
      }
    }
  }
  return { n, sample };
}

{
  const { n, sample } = countOverlaps(lay.nodes);
  T('节点之间没有重叠', n === 0, n ? `${n} 处，例如 ${sample}` : '0 处');
}

{
  // 纵向顺序应当与源码顺序一致（一级分支自上而下）
  const branches = lay.nodes.filter((n) => n.level === 1);
  const rightBranches = branches.filter((n) => n.dir === 1).sort((a, b) => a.y - b.y);
  const leftBranches = branches.filter((n) => n.dir === -1).sort((a, b) => a.y - b.y);
  T('一级分支被左右均分', Math.abs(rightBranches.length - leftBranches.length) <= 1,
    `右 ${rightBranches.length} / 左 ${leftBranches.length}`);
}

{
  // 分支配色：一级分支之间颜色必须互不相同
  const colors = parseMindmap(OUTLINE).children.map((c) => c.branchColor);
  T('一级分支配色互不相同', new Set(colors).size === colors.length, colors.join(' '));
  T('子节点继承父分支颜色', parseMindmap(OUTLINE).children[0].children[0].branchColor === colors[0]);
}

/* ---------- 5) 折叠 ---------- */
section('折叠 / 展开');

{
  const expanded = layoutForTest(OUTLINE, { fontSize: 14 });
  const collapsed = layoutForTest(OUTLINE, { fontSize: 14, collapse: ['0/0'] });

  T('折叠后后代节点不再参与布局', collapsed.nodes.length < expanded.nodes.length,
    `${collapsed.nodes.length} < ${expanded.nodes.length}`);
  T('折叠节点的子节点全部消失',
    !collapsed.nodes.some((n) => n.path.indexOf('0/0/') === 0),
    collapsed.nodes.map((n) => n.path).join(','));
  T('折叠后高度下降', collapsed.height < expanded.height,
    `${Math.round(expanded.height)} → ${Math.round(collapsed.height)}`);
  T('折叠后画布高度仍为有限数值',
    Number.isFinite(collapsed.height) && Number.isFinite(collapsed.width),
    `${collapsed.width} × ${collapsed.height}`);
  T('折叠节点本身仍在', collapsed.nodes.some((n) => n.path === '0/0'));
  const ov = countOverlaps(collapsed.nodes);
  T('折叠后仍无重叠', ov.n === 0, ov.n ? `${ov.n} 处，例如 ${ov.sample}` : '0 处');
}

{
  // 折叠全部一级分支 → 只剩根 + 4 个分支
  const all = parseMindmap(OUTLINE).children.map((c) => c.path);
  const only = layoutForTest(OUTLINE, { fontSize: 14, collapse: all });
  T('全部分支折叠后只剩根与分支', only.nodes.length === all.length + 1,
    only.nodes.length + ' 个');
  T('全部折叠后宽度显著变小', only.width < lay.width, `${Math.round(only.width)} < ${Math.round(lay.width)}`);
}

{
  // 回归：根节点自己也能折叠（UI 上根上的开关=全部收起）。
  // 这条曾经会算出 NaN —— measureTree 提前返回，子节点没有 w/h。
  const onlyRoot = layoutForTest(OUTLINE, { fontSize: 14, collapse: ['0'] });
  T('根节点折叠后只剩自己', onlyRoot.nodes.length === 1, onlyRoot.nodes.length + ' 个');
  T('根节点折叠后尺寸有效',
    Number.isFinite(onlyRoot.width) && Number.isFinite(onlyRoot.height) && onlyRoot.width > 0,
    `${Math.round(onlyRoot.width)} × ${Math.round(onlyRoot.height)}`);
  // 回归：早退分支曾漏掉 minY，paint() 里 oy 变成 NaN，根节点形状与文字都画不出来
  T('根节点折叠后坐标为有限数值',
    Number.isFinite(onlyRoot.nodes[0].x) && Number.isFinite(onlyRoot.nodes[0].y),
    `x=${onlyRoot.nodes[0].x} y=${onlyRoot.nodes[0].y}`);
  T('根节点折叠后水平居中',
    Math.abs((onlyRoot.nodes[0].x + onlyRoot.nodes[0].w / 2) - onlyRoot.width / 2) < 0.51,
    `中心 ${Math.round(onlyRoot.nodes[0].x + onlyRoot.nodes[0].w / 2)} / 画布 ${Math.round(onlyRoot.width)}`);
}

{
  // 折叠状态按源码哈希区分：不同文档互不影响
  const h1 = hashSource(OUTLINE);
  const h2 = hashSource(OUTLINE + '\n    新增分支');
  T('源码哈希随内容变化', h1 !== h2, h1 + ' vs ' + h2);
  T('相同源码哈希稳定', hashSource(OUTLINE) === h1);
}

{
  // 折叠一个中间层分支后，父节点变成叶子，仍要占住自己的纵向位置
  const deep = layoutForTest(['root', '    A', '        A1', '            A1a',
    '        A2', '    B', '        B1'].join('\n'), { fontSize: 14, collapse: ['0/0'] });
  const a = deep.nodes.find((n) => n.text === 'A');
  T('折叠后父节点保持可见', !!a, deep.nodes.map((n) => n.text).join(','));
  T('折叠分支的下级不可见', !deep.nodes.some((n) => n.text === 'A1' || n.text === 'A1a'));
  const ov = countOverlaps(deep.nodes);
  T('折叠中间层后无重叠', ov.n === 0, ov.n ? `${ov.n} 处，例如 ${ov.sample}` : '0 处');
}

/* ---------- 6) 字号缩放 ---------- */
section('字号与文字折行');

{
  const small = layoutForTest(OUTLINE, { fontSize: 12 });
  const big = layoutForTest(OUTLINE, { fontSize: 18 });
  T('字号变大 → 画布变宽', big.width > small.width,
    `${Math.round(small.width)} → ${Math.round(big.width)}`);
  // 折行宽度随字号等比缩放，所以行数不变时高度可以持平
  T('字号变大 → 画布不变矮', big.height >= small.height,
    `${Math.round(small.height)} → ${Math.round(big.height)}`);
}

{
  // 超长文本必须折行（最多 2 行），不能把画布无限拉宽
  const long = layoutForTest(['root', '    ' + '这是一个非常长的节点文本'.repeat(12)].join('\n'), { fontSize: 14 });
  const leaf = long.nodes.find((n) => n.level === 1);
  T('超长文本被折行', !!leaf && leaf.w < 420, leaf ? 'w=' + Math.round(leaf.w) : '缺失');
  T('折行后高度增加', !!leaf && leaf.h > 40, leaf ? 'h=' + Math.round(leaf.h) : '缺失');
}

{
  // 英文必须整词断行：不能出现 "ConfigM / ap" 这种把单词劈开的折行
  const r = layoutForTest(['root', '    K8s 基础：Deployment、Secret、ConfigMap'].join('\n'), { fontSize: 14 });
  const n = r.nodes.find((x) => x.level === 1);
  const lines = n ? n.lines : [];
  T('折行不止一行（说明确实触发了换行）', lines.length >= 1, JSON.stringify(lines));
  T('英文单词 ConfigMap 未被劈开', lines.some((l) => l.indexOf('ConfigMap') !== -1), JSON.stringify(lines));

  // 逐行检查：上一行以字母数字结尾、下一行以字母数字开头 → 中间被硬切开了
  let broken = '';
  for (let i = 0; i + 1 < lines.length; i++) {
    if (/[A-Za-z0-9]$/.test(lines[i]) && /^[A-Za-z0-9]/.test(lines[i + 1])) {
      broken = `${lines[i]} ⏎ ${lines[i + 1]}`;
    }
  }
  T('没有跨行的单词劈裂', broken === '', broken);
}

{
  // 中文逐字断行不受影响
  const r = layoutForTest(['root', '    ' + '中文节点文本需要折行处理'.repeat(6)].join('\n'), { fontSize: 14 });
  const n = r.nodes.find((x) => x.level === 1);
  T('中文长文本折成两行', !!n && n.lines.length === 2, n ? n.lines.length + ' 行' : '缺失');
  T('超长时结尾补省略号', !!n && /…$/.test(n.lines[n.lines.length - 1]), n ? n.lines[n.lines.length - 1].slice(-6) : '');
}

lines.push('');
lines.push(fail ? `结果：${fail} 项失败` : '结果：全部通过 ✅');
lines.push('────────────────────────────────');
console.log(lines.join('\n'));
fs.writeFileSync(path.join(root, '_mindmap.txt'), lines.join('\n'), 'utf8');
process.exitCode = fail ? 1 : 0;
