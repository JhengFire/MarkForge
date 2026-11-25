'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // 外观
  theme: 'light',                 // light | dark
  editorFontSize: 15,
  previewFontSize: 16,
  previewFontFamily: 'system',    // system | serif | sans | mono
  fontSizeUnit: 'px',
  lineHeight: 1.75,
  contentWidth: 860,
  // 编辑器
  editorLineNumbers: true,
  editorLineWrapping: true,
  spellcheck: false,
  tabSize: 2,
  // 预览
  syncScroll: true,
  renderKaTeX: true,
  renderMermaid: true,
  renderPlantUML: true,
  singleDollarMath: true,
  mermaidTheme: 'default',        // default | dark | neutral | forest
  mindmapFontSize: 14,            // 思维导图节点字号（px）
  plantumlMode: 'remote',         // remote | local
  plantumlServer: 'https://www.plantuml.com/plantuml',
  codeHighlight: true,
  codeTheme: 'github',
  // 导出
  pdfPageSize: 'A4',
  pdfMargin: 18,
  pdfLandscape: false,
  pdfHeaderFooter: true,
  pdfPrintBackground: true,
  docxCodeFont: 'Consolas',
  docxBodyFont: '等线',
  // 会话
  lastDir: '',
  recentFiles: [],
  windowBounds: null,
  // 安全
  allowRemotePlantUML: true,
};

class Store {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      this.data = { ...DEFAULTS, ...parsed };
    } catch {
      this.data = { ...DEFAULTS };
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch {
      /* ignore */
    }
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(patch) {
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  pushRecent(file) {
    const list = (this.data.recentFiles || []).filter((f) => f !== file);
    list.unshift(file);
    this.data.recentFiles = list.slice(0, 12);
    this.save();
  }
}

module.exports = { Store, DEFAULTS };
