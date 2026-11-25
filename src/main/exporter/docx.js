'use strict';

/**
 * Markdown token 树 -> DOCX
 * 公式 / Mermaid / PlantUML 由渲染进程栅格化成 PNG 后内嵌，保证 Word 里也是所见即所得。
 */

const fs = require('fs');
const path = require('path');
const d = require('docx');

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  LevelFormat,
  ShadingType,
  ExternalHyperlink,
  InternalHyperlink,
  PageBreak,
  TableLayoutType,
  VerticalAlign,
} = d;

const PLACEHOLDER = /\uE000([MBD])(\d+)\uE001/g;

const MONO_FALLBACK = 'Consolas';
const MAX_IMG_WIDTH = 660;      // px @96dpi，对应 A4 约 17.5cm
const CODE_FILL = 'F6F8FA';     // 与预览 --code-bg 一致
const CODE_TITLE_FILL = 'EEF1F5';
const CODE_BORDER = 'D8DEE4';   // 与预览 --border 一致
const CODE_FG = '24292F';       // 与预览 --code-fg 一致
const QUOTE_FILL = 'FAFAFA';
const BORDER_COLOR = 'D0D5DD';

const TAB_SIZE = 4;
/** 制表符按列展开，避免 Word 里 tab 宽度不可控导致缩进错乱 */
function expandTabs(line, size = TAB_SIZE) {
  if (line.indexOf('\t') === -1) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = size - (col % size);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col += 1;
    }
  }
  return out;
}

/** 去掉 Word 不接受的控件字符（保留换行/制表，换行已在上游按行切分） */
function stripControlChars(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
}

function dataUrlToBuffer(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(String(dataUrl || ''));
  if (!m) return null;
  if (m[2]) return Buffer.from(m[3], 'base64');
  return Buffer.from(decodeURIComponent(m[3]), 'utf8');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

function fit(w, h, maxW) {
  if (!w || !h) return { width: maxW, height: maxW / 2 };
  if (w <= maxW) return { width: w, height: h };
  const k = maxW / w;
  return { width: maxW, height: Math.round(h * k) };
}

class DocxBuilder {
  constructor(payload = {}) {
    this.p = payload;
    this.meta = payload.meta || {};
    this.images = payload.images || {};
    this.math = payload.math || {};
    this.diagrams = payload.diagrams || {};
    this.baseDir = payload.baseDir || process.cwd();
    this.bodyFont = this.meta.bodyFont || '等线';
    this.codeFont = this.meta.codeFont || MONO_FALLBACK;
    this.baseSize = Number(this.meta.fontSize) || 21; // half-points => 10.5pt
    this.footnotes = [];
    this.warnings = [];
  }

  /** 从 token 的 attrs 里取属性 */
  static attr(tok, name) {
    if (!tok || !tok.attrs) return null;
    for (const [k, v] of tok.attrs) if (k === name) return v;
    return null;
  }

  imageRun(kind, key) {
    const store = kind === 'M' || kind === 'B' ? this.math : kind === 'D' ? this.diagrams : this.images;
    const item = store[key];
    if (!item || !item.dataUrl) return null;
    const buf = dataUrlToBuffer(item.dataUrl);
    if (!buf) return null;
    const isInline = kind === 'M';
    // 行内公式上限放宽到 520px：260px 会把稍长的行内公式压得过小
    let box = isInline
      ? fit(item.width || 0, item.height || 0, 520)
      : fit(item.width || 0, item.height || 0, MAX_IMG_WIDTH);
    if (isInline) box = { width: box.width * 0.9, height: box.height * 0.9 };
    try {
      return new ImageRun({
        type: 'png',
        data: buf,
        transformation: {
          width: Math.max(1, Math.round(box.width)),
          height: Math.max(1, Math.round(box.height)),
        },
      });
    } catch (e) {
      this.warnings.push('图片嵌入失败：' + e.message);
      return null;
    }
  }

  /** 把一段文本按公式/图表占位符切成 run 序列 */
  contentToRuns(text, style = {}) {
    const runs = [];
    let last = 0;
    PLACEHOLDER.lastIndex = 0;
    let m;
    while ((m = PLACEHOLDER.exec(text))) {
      if (m.index > last) {
        runs.push(this.textRun(text.slice(last, m.index), style));
      }
      const img = this.imageRun(m[1], m[2]);
      if (img) {
        runs.push(img);
      } else {
        // 宁可显式提示，也不要把 \uE000M0\uE001 这类私有区占位符塞进正文，
        // 那在 Word 里只会显示成乱码/空白方块，完全看不出问题出在哪。
        const kind = m[1];
        if (kind === 'M' || kind === 'B') {
          this.warnings.push(`第 ${Number(m[2]) + 1} 个公式未能转成图片，已用占位标记替代`);
          runs.push(this.textRun('〖公式〗', { ...style, color: 'C0392B' }));
        } else if (kind === 'D') {
          this.warnings.push(`第 ${Number(m[2]) + 1} 个图表未能转成图片`);
          runs.push(this.textRun('〖图表〗', { ...style, color: 'C0392B' }));
        } else {
          runs.push(this.textRun(text.slice(m.index, m.index + m[0].length), style));
        }
      }
      last = m.index + m[0].length;
    }
    if (last < text.length) runs.push(this.textRun(text.slice(last), style));
    return runs.filter(Boolean);
  }

  textRun(text, style = {}) {
    if (text === '') return null;
    const base = {
      text,
      font: style.code ? this.codeFont : style.font || this.bodyFont,
      size: style.size || this.baseSize,
      bold: !!style.bold,
      italics: !!style.italics,
      strike: !!style.strike,
    };
    if (style.code) base.shading = { type: ShadingType.CLEAR, fill: CODE_FILL };
    if (style.color) base.color = style.color;
    if (style.underline) base.underline = {};
    return new TextRun(base);
  }

  /** inline token 序列 -> runs */
  inlineRuns(children, style = {}) {
    const runs = [];
    if (!children) return runs;
    const st = { ...style };
    for (let i = 0; i < children.length; i++) {
      const t = children[i];
      switch (t.type) {
        case 'text':
          runs.push(...this.contentToRuns(t.content || '', st));
          break;
        case 'strong_open':
          st.bold = true;
          break;
        case 'strong_close':
          st.bold = false;
          break;
        case 'em_open':
          st.italics = true;
          break;
        case 'em_close':
          st.italics = false;
          break;
        case 's_open':
          st.strike = true;
          break;
        case 's_close':
          st.strike = false;
          break;
        case 'mark_open':
          st.color = '9A6700';
          break;
        case 'mark_close':
          st.color = undefined;
          break;
        case 'code_inline':
          runs.push(this.textRun(t.content || '', { ...st, code: true }));
          break;
        case 'softbreak':
          runs.push(this.textRun(' ', st));
          break;
        case 'hardbreak':
          runs.push(new TextRun({ break: 1 }));
          break;
        case 'html_inline':
          if (t.content) runs.push(this.contentToRuns(stripHtml(t.content), st));
          break;
        case 'image': {
          const src = DocxBuilder.attr(t, 'src') || '';
          const img = this.imageRun('I', src);
          if (img) runs.push(img);
          else runs.push(this.textRun('[' + (t.content || DocxBuilder.attr(t, 'alt') || '图片') + ']', st));
          break;
        }
        case 'link_open': {
          const href = DocxBuilder.attr(t, 'href') || '';
          let depth = 1;
          const inner = [];
          let j = i + 1;
          for (; j < children.length; j++) {
            if (children[j].type === 'link_open') depth++;
            if (children[j].type === 'link_close') {
              depth--;
              if (depth === 0) break;
            }
            inner.push(children[j]);
          }
          const innerRuns = this.inlineRuns(inner, { ...st, underline: true, color: '0B69C7' });
          if (/^https?:/i.test(href)) {
            runs.push(new ExternalHyperlink({ children: innerRuns, link: href }));
          } else {
            runs.push(...innerRuns);
          }
          i = j;
          break;
        }
        case 'link_close':
          break;
        case 'emoji':
          runs.push(this.textRun(t.content || '', st));
          break;
        case 'footnote_ref': {
          const idx = this.footnotes.length + 1;
          this.footnotes.push({
            id: t.meta && t.meta.id != null ? t.meta.id : t.meta && t.meta.label,
            content: (t.meta && t.meta.content) || '',
            sub: t.meta && t.meta.subId,
            n: idx,
          });
          runs.push(new TextRun({ text: `[${idx}]`, font: this.bodyFont, size: this.baseSize, superScript: true }));
          break;
        }
        default:
          if (t.content && t.type !== 'html_block') runs.push(...this.contentToRuns(t.content, st));
          break;
      }
    }
    return runs.filter(Boolean);
  }

  /** 找到与之配对的 close token 的下标 */
  findClose(tokens, i, openType, closeType) {
    let depth = 0;
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === openType) depth++;
      else if (tokens[j].type === closeType) {
        depth--;
        if (depth === 0) return j;
      }
    }
    return tokens.length - 1;
  }

  paragraph(children, opts = {}) {
    return new Paragraph({
      children: children && children.length ? children : [new TextRun('')],
      spacing: { before: opts.before == null ? 60 : opts.before, after: opts.after == null ? 120 : opts.after, line: opts.line || 300 },
      alignment: opts.alignment,
      indent: opts.indent,
      border: opts.border,
      shading: opts.shading,
      numbering: opts.numbering,
      heading: opts.heading,
      pageBreakBefore: opts.pageBreakBefore,
    });
  }

  /** 主流程：tokens -> docx 元素数组 */
  build() {
    const tokens = this.p.tokens || [];
    const out = [];
    let i = 0;
    let listStack = [];

    while (i < tokens.length) {
      const t = tokens[i];

      if (t.type === 'heading_open') {
        const close = this.findClose(tokens, i, 'heading_open', 'heading_close');
        const inline = tokens[i + 1];
        const level = Number(String(t.tag || 'h1').replace(/\D/g, '')) || 1;
        const hMap = [
          HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3,
          HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6,
        ];
        const runs = this.inlineRuns(inline && inline.children, {
          size: level === 1 ? 32 : level === 2 ? 28 : level === 3 ? 25 : 23,
          bold: true,
          font: this.meta.headingFont || this.bodyFont,
        });
        out.push(
          new Paragraph({
            children: runs.length ? runs : [new TextRun('')],
            heading: hMap[level - 1],
            spacing: { before: level <= 2 ? 280 : 220, after: 120 },
          })
        );
        i = close + 1;
        continue;
      }

      if (t.type === 'paragraph_open') {
        const close = this.findClose(tokens, i, 'paragraph_open', 'paragraph_close');
        const inline = tokens[i + 1];
        const runs = this.inlineRuns(inline && inline.children);
        const insideQuote = t._quote;
        out.push(
          this.paragraph(runs, {
            indent: insideQuote ? { left: 300 } : undefined,
            shading: insideQuote ? { type: ShadingType.CLEAR, fill: QUOTE_FILL } : undefined,
            border: insideQuote
              ? { left: { style: BorderStyle.SINGLE, size: 18, color: BORDER_COLOR, space: 10 } }
              : undefined,
          })
        );
        i = close + 1;
        continue;
      }

      if (t.type === 'bullet_list_open' || t.type === 'ordered_list_open') {
        const ordered = t.type === 'ordered_list_open';
        const start = t.attrs ? Number(DocxBuilder.attr(t, 'start')) || 1 : 1;
        const close = this.findClose(
          tokens, i,
          ordered ? 'ordered_list_open' : 'bullet_list_open',
          ordered ? 'ordered_list_close' : 'bullet_list_close'
        );
        const level = listStack.length;
        listStack.push(ordered ? 'ordered' : 'bullet');
        const inner = this.buildRange(tokens, i + 1, close, listStack, start);
        listStack.pop();
        out.push(...inner);
        i = close + 1;
        continue;
      }

      if (t.type === 'list_item_open') {
        // 兜底（正常由列表整体处理）
        i++;
        continue;
      }

      if (t.type === 'table_open') {
        const close = this.findClose(tokens, i, 'table_open', 'table_close');
        out.push(this.buildTable(tokens, i + 1, close));
        i = close + 1;
        continue;
      }

      if (t.type === 'fence' || t.type === 'code_block') {
        const dg = this.diagramParagraph(t);
        if (dg) out.push(dg);
        else out.push(...this.buildCode(t.content || '', { lang: t.info }));
        i++;
        continue;
      }

      if (t.type === 'blockquote_open') {
        const close = this.findClose(tokens, i, 'blockquote_open', 'blockquote_close');
        for (let j = i + 1; j < close; j++) tokens[j]._quote = true;
        const inner = this.buildRange(tokens, i + 1, close, listStack);
        out.push(...inner);
        i = close + 1;
        continue;
      }

      if (t.type === 'hr') {
        out.push(
          new Paragraph({
            children: [new TextRun('')],
            border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: BORDER_COLOR, space: 1 } },
            spacing: { before: 160, after: 160 },
          })
        );
        i++;
        continue;
      }

      if (t.type === 'html_block') {
        const text = stripHtml(t.content || '').trim();
        if (text) out.push(this.paragraph([this.textRun(text, { color: '666666' })]));
        i++;
        continue;
      }

      if (t.type === 'footnote_block_open') {
        i++;
        continue;
      }

      i++;
    }

    // 脚注
    if (this.footnotes.length) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: '—— 脚注 ——', size: 18, color: '888888' })],
          border: { top: { style: BorderStyle.SINGLE, size: 6, color: BORDER_COLOR, space: 6 } },
          spacing: { before: 320, after: 120 },
        })
      );
      for (const fn of this.footnotes) {
        out.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${fn.n}. `, size: 18, color: '666666' }),
              ...this.contentToRuns(fn.content || '', { size: 18 }),
            ],
            indent: { left: 260, hanging: 260 },
            spacing: { before: 0, after: 60 },
          })
        );
      }
    }

    return out;
  }

  /** 处理 [start, end) 区间的 token（用于列表 / 引用内部） */
  buildRange(tokens, start, end, listStack, orderedStart) {
    const out = [];
    let i = start;
    let itemIndex = orderedStart || 1;
    let level = Math.max(0, (listStack ? listStack.length : 1) - 1);
    const ordered = listStack && listStack[listStack.length - 1] === 'ordered';

    while (i < end) {
      const t = tokens[i];

      if (t.type === 'list_item_open') {
        const close = this.findClose(tokens, i, 'list_item_open', 'list_item_close');
        // 收集 item 内首个块的 inline 文本，后续块单独成段
        let firstDone = false;
        let j = i + 1;
        while (j < close) {
          const tt = tokens[j];
          if (tt.type === 'paragraph_open') {
            const pClose = this.findClose(tokens, j, 'paragraph_open', 'paragraph_close');
            const runs = this.inlineRuns(tokens[j + 1] && tokens[j + 1].children);
            out.push(
              this.paragraph(runs, {
                numbering: firstDone || true
                  ? { reference: ordered ? 'md-ordered' : 'md-bullet', level: Math.min(level, 2) }
                  : undefined,
                indent: undefined,
                before: 0,
                after: 40,
              })
            );
            j = pClose + 1;
            continue;
          }
          if (tt.type === 'fence' || tt.type === 'code_block') {
            const dg = this.diagramParagraph(tt);
            if (dg) out.push(dg);
            else out.push(...this.buildCode(tt.content || '', { indent: { left: 420 + level * 240 }, lang: tt.info }));
            j++;
            continue;
          }
          if (tt.type === 'bullet_list_open' || tt.type === 'ordered_list_open') {
            const o = tt.type === 'ordered_list_open';
            const sub = this.findClose(
              tokens, j,
              o ? 'ordered_list_open' : 'bullet_list_open',
              o ? 'ordered_list_close' : 'bullet_list_close'
            );
            const nextStack = (listStack || []).concat(o ? 'ordered' : 'bullet');
            out.push(...this.buildRange(tokens, j + 1, sub, nextStack, 1));
            j = sub + 1;
            continue;
          }
          if (tt.type === 'blockquote_open') {
            const bc = this.findClose(tokens, j, 'blockquote_open', 'blockquote_close');
            for (let k = j + 1; k < bc; k++) tokens[k]._quote = true;
            out.push(...this.buildRange(tokens, j + 1, bc, listStack));
            j = bc + 1;
            continue;
          }
          j++;
        }
        itemIndex++;
        i = close + 1;
        continue;
      }

      if (t.type === 'paragraph_open') {
        const close = this.findClose(tokens, i, 'paragraph_open', 'paragraph_close');
        out.push(this.paragraph(this.inlineRuns(tokens[i + 1] && tokens[i + 1].children)));
        i = close + 1;
        continue;
      }

      if (t.type === 'fence' || t.type === 'code_block') {
        const dg = this.diagramParagraph(t);
        if (dg) out.push(dg);
        else out.push(...this.buildCode(t.content || '', { lang: t.info }));
        i++;
        continue;
      }

      i++;
    }
    return out;
  }

  /** 图表代码块 -> 居中图片段落；不是图表则返回 null */
  diagramParagraph(token) {
    const di = token && token.meta ? token.meta.diagramIndex : null;
    if (di == null) return null;
    const img = this.imageRun('D', String(di));
    if (!img) {
      const kind = token.meta && token.meta.kind === 'mermaid' ? 'Mermaid' : 'PlantUML';
      return this.paragraph([this.textRun(`[${kind} 图：栅格化失败，未嵌入]`, { color: '999999', size: 18 })]);
    }
    return this.paragraph([img], { alignment: AlignmentType.CENTER, before: 140, after: 180 });
  }

  /**
   * 代码块 → 「代码框」
   *
   * 用单格（有语言时两格）表格来做：表格单元格自带底纹与内边距，
   * 才能得到四周留白的整块背景。用段落底纹的话，首末行会紧贴色块边缘，
   * 段间距又不着色，看起来就是「一坨被压扁的灰条」。
   *
   * 每行源码独立成一个段落：
   *   - 长行由 Word 自动折行；
   *   - indent{left,hanging} 让折行的续行缩进，和正文区分开；
   *   - 保留源码原本的前导空格，制表符先按列展开成空格。
   *
   * @param {string} code
   * @param {{ indent?: {left:number}, lang?: string }} [opts]
   */
  buildCode(code, opts = {}) {
    const raw = String(code == null ? '' : code)
      .replace(/\r\n?/g, '\n')
      .replace(/\n+$/, '');
    const srcLines = raw === '' ? [''] : raw.split('\n');
    const lang = String(opts.lang || '').trim().split(/\s+/)[0].toLowerCase();
    const indentTwips = (opts.indent && opts.indent.left) || 0;

    const codeParas = srcLines.map((line) => {
      const text = stripControlChars(expandTabs(line)).replace(/\s+$/, '');
      return new Paragraph({
        // 空行也要占一行高度，否则代码块会被压扁
        children: [new TextRun({ text: text === '' ? ' ' : text, font: this.codeFont, size: 18, color: CODE_FG })],
        spacing: { before: 0, after: 0, line: 300, lineRule: 'auto' },
        // hanging = left 时首行归零，折行的续行缩进 240 twips（≈0.42cm）
        indent: { left: 240, hanging: 240 },
      });
    });

    if (!codeParas.length) {
      codeParas.push(new Paragraph({ children: [new TextRun({ text: ' ', font: this.codeFont, size: 18 })] }));
    }

    const rows = [];
    if (lang) {
      rows.push(
        new TableRow({
          children: [
            new TableCell({
              children: [
                new Paragraph({
                  children: [new TextRun({ text: lang, font: this.codeFont, size: 15, color: '6E7781' })],
                  spacing: { before: 0, after: 0, line: 240, lineRule: 'auto' },
                }),
              ],
              shading: { type: ShadingType.CLEAR, fill: CODE_TITLE_FILL },
              margins: { top: 60, bottom: 60, left: 200, right: 200 },
            }),
          ],
        })
      );
    }

    rows.push(
      new TableRow({
        children: [
          new TableCell({
            children: codeParas,
            shading: { type: ShadingType.CLEAR, fill: CODE_FILL },
            margins: { top: 160, bottom: 160, left: 200, right: 200 },
          }),
        ],
      })
    );

    const line = { style: BorderStyle.SINGLE, size: 4, color: CODE_BORDER, space: 0 };
    const table = new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.FIXED,
      indent: indentTwips ? { size: indentTwips, type: WidthType.DXA } : undefined,
      borders: {
        top: line,
        bottom: line,
        left: line,
        right: line,
        insideHorizontal: line,
        insideVertical: line,
      },
    });

    // 表格后面必须垫一个极小段落。
    // OOXML 里两个相邻且属性相同的表格会被 Word 自动合并成一张表，
    // 于是「两个紧挨着的代码块」会长成一个连体大框。
    const spacer = new Paragraph({
      children: [new TextRun({ text: '', size: 2 })],
      spacing: { before: 0, after: 0, line: 60, lineRule: 'exact' },
    });

    return [table, spacer];
  }

  buildTable(tokens, start, end) {
    const rows = [];
    let i = start;
    let headerRows = 0;
    while (i < end) {
      if (tokens[i].type === 'thead_open') headerRows = 1;
      if (tokens[i].type === 'tr_open') {
        const trClose = this.findClose(tokens, i, 'tr_open', 'tr_close');
        const cells = [];
        let j = i + 1;
        while (j < trClose) {
          if (tokens[j].type === 'th_open' || tokens[j].type === 'td_open') {
            const isTh = tokens[j].type === 'th_open';
            const cellClose = this.findClose(tokens, j, isTh ? 'th_open' : 'td_open', isTh ? 'th_close' : 'td_close');
            const inline = tokens[j + 1] && tokens[j + 1].type === 'inline' ? tokens[j + 1] : null;
            const align = DocxBuilder.attr(tokens[j], 'style') || '';
            const runs = this.inlineRuns(inline && inline.children, { bold: isTh, size: 19 });
            cells.push(
              new TableCell({
                children: [
                  new Paragraph({
                    children: runs.length ? runs : [new TextRun('')],
                    spacing: { before: 20, after: 20 },
                    alignment: /center/i.test(align)
                      ? AlignmentType.CENTER
                      : /right/i.test(align)
                        ? AlignmentType.RIGHT
                        : AlignmentType.LEFT,
                  }),
                ],
                shading: isTh ? { type: ShadingType.CLEAR, fill: 'EEF2F6' } : undefined,
                verticalAlign: VerticalAlign.CENTER,
                margins: { top: 60, bottom: 60, left: 100, right: 100 },
              })
            );
            j = cellClose + 1;
            continue;
          }
          j++;
        }
        rows.push(new TableRow({ children: cells, tableHeader: rows.length < headerRows }));
        i = trClose + 1;
        continue;
      }
      i++;
    }
    if (!rows.length) rows.push(new TableRow({ children: [new TableCell({ children: [new Paragraph('')] })] }));
    return new Table({
      rows,
      width: { size: 100, type: WidthType.PERCENTAGE },
      layout: TableLayoutType.AUTOFIT,
      borders: {
        top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        left: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        right: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
        insideVertical: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR },
      },
    });
  }

  numberingConfig() {
    const bulletTexts = ['•', '◦', '▪'];
    const bullet = {
      reference: 'md-bullet',
      levels: [0, 1, 2].map((lv) => ({
        level: lv,
        format: LevelFormat.BULLET,
        text: bulletTexts[lv],
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360 + lv * 360, hanging: 260 } } },
      })),
    };
    const ordered = {
      reference: 'md-ordered',
      levels: [0, 1, 2].map((lv) => ({
        level: lv,
        format: LevelFormat.DECIMAL,
        text: `%${lv + 1}.`,
        alignment: AlignmentType.LEFT,
        style: { paragraph: { indent: { left: 360 + lv * 360, hanging: 260 } } },
      })),
    };
    return { config: [bullet, ordered] };
  }

  async toBuffer() {
    const children = this.build();
    const doc = new Document({
      creator: this.meta.author || 'MDView',
      title: this.meta.title || '未命名文档',
      description: '由 MDView 导出',
      numbering: this.numberingConfig(),
      styles: {
        default: {
          document: {
            run: { font: this.bodyFont, size: this.baseSize },
            paragraph: { spacing: { line: 300 } },
          },
        },
        paragraphStyles: [
          {
            id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 32, bold: true, font: this.meta.headingFont || this.bodyFont, color: '1F2937' },
            paragraph: { spacing: { before: 300, after: 140 } },
          },
          {
            id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 28, bold: true, font: this.meta.headingFont || this.bodyFont, color: '1F2937' },
            paragraph: { spacing: { before: 260, after: 120 } },
          },
          {
            id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true,
            run: { size: 25, bold: true, font: this.meta.headingFont || this.bodyFont, color: '374151' },
            paragraph: { spacing: { before: 220, after: 100 } },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: {
              margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 }, // twips ≈ 2cm
            },
          },
          children,
        },
      ],
    });
    return { buffer: await Packer.toBuffer(doc), warnings: this.warnings };
  }
}

async function buildDocx(payload) {
  const b = new DocxBuilder(payload);
  return b.toBuffer();
}

module.exports = { buildDocx, DocxBuilder };
