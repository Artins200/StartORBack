'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// Белый список каналов
const ALLOWED_INVOKE = new Set(['get-apps','get-system-info','get-theme','launch-app','open-location','open-external']);
const ALLOWED_SEND = new Set(['hide-menu','set-theme','set-accent','toggle-menu']);
const ALLOWED_ON = new Set(['theme-changed','accent-changed','menu-show','menu-hide']);

function validateInvoke(channel, args) {
  if (!ALLOWED_INVOKE.has(channel)) throw new Error('invoke not allowed: '+channel);
  // доп. валидация аргументов по каналу
  if (channel === 'launch-app' || channel === 'open-location') {
    const p = args[0];
    if (p !== undefined && (typeof p !== 'string' || p.length > 1024 || p.includes('\0'))) throw new Error('invalid path arg');
  }
  if (channel === 'open-external') {
    const u = args[0];
    if (typeof u !== 'string' || u.length > 2048) throw new Error('invalid url');
  }
}

function validateSend(channel, args) {
  if (!ALLOWED_SEND.has(channel)) throw new Error('send not allowed: '+channel);
  if (channel === 'set-theme') {
    const t = args[0];
    if (typeof t !== 'string' || !['win11','win10','win7'].includes(t)) throw new Error('invalid theme');
  }
  if (channel === 'set-accent') {
    const c = args[0];
    if (typeof c !== 'string' || !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) throw new Error('invalid color');
  }
}

const api = {
  getApps: () => {
    validateInvoke('get-apps', []);
    return ipcRenderer.invoke('get-apps');
  },
  getSystemInfo: () => {
    validateInvoke('get-system-info', []);
    return ipcRenderer.invoke('get-system-info');
  },
  getTheme: () => {
    validateInvoke('get-theme', []);
    return ipcRenderer.invoke('get-theme');
  },
  launchApp: (p) => {
    validateInvoke('launch-app', [p]);
    return ipcRenderer.invoke('launch-app', p);
  },
  openLocation: (p) => {
    validateInvoke('open-location', [p]);
    return ipcRenderer.invoke('open-location', p);
  },
  openExternal: (url) => {
    validateInvoke('open-external', [url]);
    return ipcRenderer.invoke('open-external', url);
  },
  hideMenu: () => {
    validateSend('hide-menu', []);
    ipcRenderer.send('hide-menu');
  },
  toggleMenu: () => {
    validateSend('toggle-menu', []);
    ipcRenderer.send('toggle-menu');
  },
  setTheme: (t) => {
    validateSend('set-theme', [t]);
    ipcRenderer.send('set-theme', t);
  },
  setAccent: (c) => {
    validateSend('set-accent', [c]);
    ipcRenderer.send('set-accent', c);
  },
  onThemeChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const ch = 'theme-changed';
    if (!ALLOWED_ON.has(ch)) return () => {};
    const handler = (_e, t) => {
      // валидация входящих данных
      if (typeof t === 'string' && ['win11','win10','win7'].includes(t)) try { cb(t); } catch {}
    };
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  onAccentChanged: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const ch = 'accent-changed';
    const handler = (_e, c) => {
      if (typeof c === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(c)) try { cb(c); } catch {}
    };
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  onMenuShow: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const ch = 'menu-show';
    const handler = () => { try { cb(); } catch {} };
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  onMenuHide: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const ch = 'menu-hide';
    const handler = () => { try { cb(); } catch {} };
    ipcRenderer.on(ch, handler);
    return () => ipcRenderer.removeListener(ch, handler);
  },
  isElectron: true
};

try {
  Object.freeze(api);
  contextBridge.exposeInMainWorld('StartORBack', api);
} catch (e) {
  console.error('contextBridge expose failed', e);
}
