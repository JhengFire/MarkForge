'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('mdv', {
  info: () => invoke('app:info'),
  /** 领取启动参数里待打开的文件（双击文件关联启动 / 第二实例转交） */
  initialFile: () => invoke('app:initialFile'),

  settings: {
    get: () => invoke('settings:get'),
    set: (patch) => invoke('settings:set', patch),
  },

  file: {
    openDialog: () => invoke('file:openDialog'),
    openPath: (p) => invoke('file:openPath', p),
    save: (path, content) => invoke('file:save', { path, content }),
    saveAsDialog: (opts) => invoke('file:saveAsDialog', opts),
    readText: (p) => invoke('file:readText', p),
    readDataUrl: (p) => invoke('file:readDataUrl', p),
    exists: (p) => invoke('file:exists', p),
    stat: (p) => invoke('file:stat', p),
    join: (parts) => invoke('path:join', parts),
    dirname: (p) => invoke('path:dirname', p),
    basename: (p) => invoke('path:basename', p),
    reveal: (p) => invoke('shell:reveal', p),
    /** 由拖拽的 File 对象得到绝对路径 */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file);
      } catch {
        return (file && file.path) || '';
      }
    },
  },

  exporter: {
    html: (payload) => invoke('export:html', payload),
    pdf: (payload) => invoke('export:pdf', payload),
    docx: (payload) => invoke('export:docx', payload),
    katexCss: () => invoke('assets:katexCss'),
  },

  closeWindow: () => invoke('window:forceClose'),

  draft: {
    read: () => invoke('draft:read'),
    write: (text) => invoke('draft:write', text),
    clear: () => invoke('draft:clear'),
  },

  printer: {
    preview: (payload) => invoke('print:preview', payload),
    now: (payload) => invoke('print:now', payload),
    list: () => invoke('print:listPrinters'),
  },

  plantuml: {
    status: () => invoke('plantuml:status'),
    render: (payload) => invoke('plantuml:render', payload),
    downloadJar: () => invoke('plantuml:downloadJar'),
  },

  dialog: {
    message: (opts) => invoke('dialog:message', opts),
    confirmSave: (name) => invoke('dialog:confirmSave', name),
  },

  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
  },

  /** 主进程（菜单 / 文件关联）下发命令 */
  onCommand: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('menu:command', handler);
    return () => ipcRenderer.removeListener('menu:command', handler);
  },
  onOpenFile: (cb) => {
    const handler = (_e, payload) => cb(payload);
    ipcRenderer.on('app:openFile', handler);
    return () => ipcRenderer.removeListener('app:openFile', handler);
  },
});
