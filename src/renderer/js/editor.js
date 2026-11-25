/**
 * CodeMirror 6 编辑器封装
 */

import { EditorState, Compartment, Prec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, highlightSpecialChars, rectangularSelection, crosshairCursor,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap,
} from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { searchKeymap, openSearchPanel, search, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';

const lightHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.35em', fontWeight: '700', color: '#1a56db' },
  { tag: t.heading2, fontSize: '1.22em', fontWeight: '700', color: '#1a56db' },
  { tag: t.heading3, fontSize: '1.12em', fontWeight: '650', color: '#2563eb' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650', color: '#3b82f6' },
  { tag: t.strong, fontWeight: '750', color: '#111827' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#0f766e' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#9ca3af' },
  { tag: t.link, color: '#2563eb' },
  { tag: t.url, color: '#7c3aed', textDecoration: 'underline' },
  { tag: t.monospace, color: '#b91c1c', background: 'rgba(0,0,0,0.045)' },
  { tag: t.quote, color: '#6b7280', fontStyle: 'italic' },
  { tag: t.list, color: '#d97706', fontWeight: '650' },
  { tag: t.contentSeparator, color: '#9ca3af', fontWeight: '700' },
  { tag: t.processingInstruction, color: '#d97706' },
  { tag: [t.keyword, t.operatorKeyword], color: '#7c3aed' },
  { tag: [t.string, t.special(t.string)], color: '#059669' },
  { tag: [t.number, t.bool, t.null], color: '#d97706' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#9ca3af', fontStyle: 'italic' },
  { tag: t.variableName, color: '#1f2937' },
  { tag: t.typeName, color: '#0e7490' },
  { tag: t.tagName, color: '#dc2626' },
  { tag: t.attributeName, color: '#7c3aed' },
  { tag: t.invalid, color: '#ef4444', textDecoration: 'underline wavy' },
]);

const darkHighlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: '1.35em', fontWeight: '700', color: '#7dd3fc' },
  { tag: t.heading2, fontSize: '1.22em', fontWeight: '700', color: '#7dd3fc' },
  { tag: t.heading3, fontSize: '1.12em', fontWeight: '650', color: '#93c5fd' },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: '650', color: '#a5b4fc' },
  { tag: t.strong, fontWeight: '750', color: '#ffffff' },
  { tag: t.emphasis, fontStyle: 'italic', color: '#5eead4' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: '#6b7280' },
  { tag: t.link, color: '#60a5fa' },
  { tag: t.url, color: '#c4b5fd', textDecoration: 'underline' },
  { tag: t.monospace, color: '#fca5a5', background: 'rgba(255,255,255,0.06)' },
  { tag: t.quote, color: '#9ca3af', fontStyle: 'italic' },
  { tag: t.list, color: '#fbbf24', fontWeight: '650' },
  { tag: t.contentSeparator, color: '#6b7280', fontWeight: '700' },
  { tag: t.processingInstruction, color: '#fbbf24' },
  { tag: [t.keyword, t.operatorKeyword], color: '#c4b5fd' },
  { tag: [t.string, t.special(t.string)], color: '#6ee7b7' },
  { tag: [t.number, t.bool, t.null], color: '#fbbf24' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b7280', fontStyle: 'italic' },
  { tag: t.variableName, color: '#e5e7eb' },
  { tag: t.typeName, color: '#67e8f9' },
  { tag: t.tagName, color: '#fca5a5' },
  { tag: t.attributeName, color: '#c4b5fd' },
  { tag: t.invalid, color: '#f87171', textDecoration: 'underline wavy' },
]);

const baseTheme = (dark) =>
  EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: 'var(--cm-font-size, 15px)',
        backgroundColor: 'transparent',
        color: dark ? '#e5e7eb' : '#1f2328',
      },
      '.cm-scroller': {
        fontFamily: 'var(--ui-mono)',
        lineHeight: '1.72',
        overflow: 'auto',
      },
      '.cm-content': {
        padding: '18px 0 42vh',
        caretColor: dark ? '#60a5fa' : '#2563eb',
      },
      '.cm-line': { padding: '0 18px 0 8px' },
      '.cm-gutters': {
        backgroundColor: dark ? '#161a1f' : '#fafbfc',
        color: dark ? '#5b6472' : '#9aa3ad',
        border: 'none',
        borderRight: `1px solid ${dark ? '#2c3138' : '#eaedf1'}`,
        paddingRight: '4px',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '34px' },
      '.cm-activeLine': { backgroundColor: dark ? 'rgba(96,165,250,0.07)' : 'rgba(37,99,235,0.045)' },
      '.cm-activeLineGutter': {
        backgroundColor: dark ? 'rgba(96,165,250,0.1)' : 'rgba(37,99,235,0.06)',
        color: dark ? '#93c5fd' : '#2563eb',
        fontWeight: '600',
      },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: dark ? 'rgba(96,165,250,0.3)' : 'rgba(37,99,235,0.2)',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftWidth: '2px' },
      '.cm-foldGutter span': { color: dark ? '#6b7280' : '#9ca3af', cursor: 'pointer' },
      '.cm-panels': {
        backgroundColor: dark ? '#1a1d22' : '#ffffff',
        color: dark ? '#e5e7eb' : '#1f2328',
        borderColor: dark ? '#2c3138' : '#e3e7ec',
      },
      '.cm-panels input, .cm-panels button': { fontSize: '12.5px' },
      '.cm-searchMatch': { backgroundColor: dark ? 'rgba(251,191,36,0.28)' : 'rgba(250,204,21,0.45)' },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: dark ? 'rgba(251,146,60,0.5)' : 'rgba(251,146,60,0.55)',
      },
      '.cm-tooltip': {
        backgroundColor: dark ? '#1f242b' : '#ffffff',
        border: `1px solid ${dark ? '#363c45' : '#dfe3e8'}`,
        borderRadius: '8px',
        boxShadow: '0 8px 26px rgba(10,15,25,.18)',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: dark ? '#2b3138' : '#eef2ff',
        color: 'inherit',
      },
      '.cm-placeholder': { color: dark ? '#5b6472' : '#b3bac2' },
    },
    { dark }
  );

export class MdEditor {
  /**
   * @param {HTMLElement} host
   * @param {object} opts { doc, onChange, onCursor, onScroll, onReady }
   */
  constructor(host, opts = {}) {
    this.host = host;
    this.opts = opts;
    this.settings = { theme: 'light', lineNumbers: true, lineWrapping: true, tabSize: 2, spellcheck: false, fontSize: 15 };
    this.themeComp = new Compartment();
    this.wrapComp = new Compartment();
    this.gutterComp = new Compartment();
    this.attrComp = new Compartment();
    this.tabComp = new Compartment();

    const state = EditorState.create({
      doc: opts.doc || '',
      extensions: [
        this.gutterComp.of(this.settings.lineNumbers ? lineNumbers() : []),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, closeOnBlur: true }),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        highlightSelectionMatches(),
        search({ top: true }),
        foldGutter({ openText: '⌄', closedText: '›' }),
        markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
        Prec.highest(keymap.of(markdownKeymap)),
        Prec.high(keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, ...completionKeymap])),
        keymap.of([indentWithTab]),
        this.tabComp.of(EditorState.tabSize.of(2)),
        this.wrapComp.of(this.settings.lineWrapping ? EditorView.lineWrapping : []),
        this.attrComp.of(EditorView.contentAttributes.of({ spellcheck: 'false' })),
        cmPlaceholder('在这里写下你的 Markdown…\n\n支持 Mermaid / PlantUML 图表与 $LaTeX$ 公式'),
        this.themeComp.of([baseTheme(false), syntaxHighlighting(lightHighlight)]),
        EditorView.updateListener.of((u) => {
          if (u.docChanged && this.opts.onChange) this.opts.onChange(u.state.doc.toString());
          if (u.selectionSet || u.docChanged) this.emitCursor(u.state);
        }),
        EditorView.domEventHandlers({
          scroll: () => {
            if (this.opts.onScroll) this.opts.onScroll();
            return false;
          },
        }),
      ],
    });

    this.view = new EditorView({ state, parent: host });
    this.emitCursor(this.view.state);
    if (opts.onReady) opts.onReady(this);
  }

  emitCursor(state) {
    if (!this.opts.onCursor) return;
    const sel = state.selection.main;
    const line = state.doc.lineAt(sel.head);
    this.opts.onCursor({ line: line.number, col: sel.head - line.from + 1, selected: sel.to - sel.from });
  }

  get doc() {
    return this.view.state.doc.toString();
  }

  setDoc(text, { keepHistory = false } = {}) {
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text || '' },
      selection: { anchor: 0 },
      scrollIntoView: true,
    });
  }

  focus() {
    this.view.focus();
  }

  applySettings(s) {
    const prev = this.settings;
    this.settings = { ...prev, ...s };
    const effects = [];
    if (s.theme && s.theme !== prev.theme) {
      effects.push(this.themeComp.reconfigure([baseTheme(s.theme === 'dark'), syntaxHighlighting(s.theme === 'dark' ? darkHighlight : lightHighlight)]));
    }
    if (s.lineNumbers != null && s.lineNumbers !== prev.lineNumbers) {
      effects.push(this.gutterComp.reconfigure(s.lineNumbers ? lineNumbers() : []));
    }
    if (s.lineWrapping != null && s.lineWrapping !== prev.lineWrapping) {
      effects.push(this.wrapComp.reconfigure(s.lineWrapping ? EditorView.lineWrapping : []));
    }
    if (s.spellcheck != null && s.spellcheck !== prev.spellcheck) {
      effects.push(this.attrComp.reconfigure(EditorView.contentAttributes.of({ spellcheck: String(!!s.spellcheck) })));
    }
    if (s.tabSize != null && s.tabSize !== prev.tabSize) {
      effects.push(this.tabComp.reconfigure(EditorState.tabSize.of(Number(s.tabSize) || 2)));
    }
    if (s.fontSize != null && s.fontSize !== prev.fontSize) {
      this.host.style.setProperty('--cm-font-size', Number(s.fontSize) + 'px');
    }
    if (effects.length) this.view.dispatch({ effects });
  }

  /** 当前选区（含为空的情况） */
  selection() {
    const sel = this.view.state.selection.main;
    return {
      from: sel.from,
      to: sel.to,
      text: this.view.state.doc.sliceString(sel.from, sel.to),
    };
  }

  /** 包裹 / 插入 */
  wrap(prefix, suffix = prefix, hint = '') {
    const sel = this.selection();
    if (sel.text) {
      this.view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: prefix + sel.text + suffix },
        selection: { anchor: sel.from + prefix.length, head: sel.from + prefix.length + sel.text.length },
      });
    } else {
      const insert = prefix + hint + suffix;
      this.view.dispatch({
        changes: { from: sel.from, insert },
        selection: { anchor: sel.from + prefix.length, head: sel.from + prefix.length + hint.length },
      });
    }
    this.focus();
  }

  /** 在光标处插入文本块 */
  insertBlock(text, { selectInner = null } = {}) {
    const sel = this.selection();
    const line = this.view.state.doc.lineAt(sel.from);
    const needsNL = line.text.trim().length > 0;
    const payload = (needsNL ? '\n' : '') + text;
    this.view.dispatch({
      changes: { from: sel.to, insert: payload },
      selection: { anchor: sel.to + payload.length },
    });
    this.focus();
  }

  /** 行前缀开关（标题 / 列表 / 引用） */
  toggleLinePrefix(prefix, { exclusive = /^#{1,6}\s/ } = {}) {
    const sel = this.view.state.selection.main;
    const startLine = this.view.state.doc.lineAt(sel.from);
    const endLine = this.view.state.doc.lineAt(sel.to);
    const changes = [];
    let allHave = true;
    const lines = [];
    for (let n = startLine.number; n <= endLine.number; n++) lines.push(this.view.state.doc.line(n));
    for (const ln of lines) {
      const rest = exclusive ? ln.text.replace(exclusive, '') : ln.text;
      if (!rest.startsWith(prefix)) {
        allHave = false;
        break;
      }
    }
    for (const ln of lines) {
      if (allHave) {
        changes.push({ from: ln.from, to: ln.from + prefix.length, insert: '' });
      } else {
        const stripped = exclusive ? ln.text.replace(exclusive, '') : ln.text;
        changes.push({ from: ln.from, to: ln.from + ln.text.length, insert: prefix + stripped });
      }
    }
    this.view.dispatch({ changes });
    this.focus();
  }

  /** 设置标题级别（0 = 正文） */
  setHeading(level) {
    const sel = this.view.state.selection.main;
    const line = this.view.state.doc.lineAt(sel.from);
    const text = line.text.replace(/^#{1,6}\s+/, '');
    const insert = level > 0 ? '#'.repeat(level) + ' ' + text : text;
    this.view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
    });
    this.focus();
  }

  gotoLine(lineNo, { focus = true } = {}) {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Number(lineNo) || 1));
    const line = doc.line(n);
    this.view.dispatch({
      selection: { anchor: line.from },
      effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 60 }),
    });
    if (focus) this.focus();
  }

  scrollToLine(lineNo) {
    const doc = this.view.state.doc;
    const n = Math.max(1, Math.min(doc.lines, Number(lineNo) || 1));
    const line = doc.line(n);
    this.view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'start', yMargin: 40 }) });
  }

  /** 滚动位置对应的一行行号 */
  topLine() {
    const top = this.view.scrollDOM.scrollTop;
    try {
      const block = this.view.lineBlockAtHeight(top + 8);
      return this.view.state.doc.lineAt(block.from).number;
    } catch {
      return 1;
    }
  }

  openSearch() {
    openSearchPanel(this.view);
  }

  get scrollDOM() {
    return this.view.scrollDOM;
  }

  destroy() {
    this.view.destroy();
  }
}
