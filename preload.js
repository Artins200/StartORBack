const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('StartORBack', {
  // безопасный API для рендера
  getApps: () => ipcRenderer.invoke('get-apps'),
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),
  getTheme: () => ipcRenderer.invoke('get-theme'),
  launchApp: (p) => ipcRenderer.invoke('launch-app', p),
  openLocation: (p) => ipcRenderer.invoke('open-location', p),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  hideMenu: () => ipcRenderer.send('hide-menu'),
  toggleMenu: () => ipcRenderer.send('toggle-menu'),
  setTheme: (t) => ipcRenderer.send('set-theme', t),
  setAccent: (c) => ipcRenderer.send('set-accent', c),
  onThemeChanged: (cb) => ipcRenderer.on('theme-changed', (e, t) => cb(t)),
  onAccentChanged: (cb) => ipcRenderer.on('accent-changed', (e, c) => cb(c)),
  onMenuShow: (cb) => ipcRenderer.on('menu-show', cb),
  onMenuHide: (cb) => ipcRenderer.on('menu-hide', cb),
  isElectron: true
});
