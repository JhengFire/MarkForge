'use strict';

/**
 * 只为离线测试提供入口：直接用 Node 的 require 加载 docx 导出器。
 * docx.js 是纯 CommonJS、不依赖 DOM，所以可以原样引用。
 */

module.exports = require('../src/main/exporter/docx.js');
