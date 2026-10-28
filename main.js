/**
 * StartORBack — безопасный оверлей меню Пуск
 * Hardened v3: фиксы всех 🔴🟠🟡
 */

'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { pathToFileURL } = require('url');

// ── Константы безопасности ─────────────────────────────────────────
const ALLOWED_THEMES = new Set(['win11', 'win10', 'win7']);
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ALLOWED_EXT_RE = /\.(lnk|url|exe)$/i;
const ALLOWED_URI_SCHEMES = new Set(['ms-settings:', 'ms-weather:', 'ms-screenclip:', 'ms-screensketch:', 'ms-get-started:']);
const MAX_SCAN_FILES = 800;
const MAX_SCAN_DIRS = 1200;
const MAX_SCAN_DEPTH = 4;
const MAX_NAME_LEN = 120;
const CACHE_TTL_MS = 30_000;
const RATE_LIMIT_WINDOW = 2000;
const MAX_CALLS_PER_WINDOW = 10;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);
const BLOCKED_NAME_RE = /^(unins|uninstall)/i;

let mainWindow = null;
let tray = null;
let isVisible = false;
let currentTheme = 'win11';
let accent = '#0078d4';

// Кэш скана
let appsCache = { data: null, ts: 0 };
const rateMap = new Map();
let headersRegistered = false;

function isRateLimited(key) {
  const now = Date.now();
  const arr = rateMap.get(key) || [];
  const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= MAX_CALLS_PER_WINDOW) return true;
  recent.push(now);
  rateMap.set(key, recent);
  // чистим старые ключи — теперь чистим всегда, не только при size>50
  for (const [k, v] of rateMap) {
    if (v.length === 0 || now - v[v.length-1] > RATE_LIMIT_WINDOW*2) rateMap.delete(k);
    if (rateMap.size > 200) break;
  }
  return false;
}

function isValidHexColor(c) { return typeof c === 'string' && HEX_COLOR_RE.test(c.trim()); }
function isValidTheme(t) { return typeof t === 'string' && ALLOWED_THEMES.has(t); }

// ── SSRF защита — п.4 (фикс v4) ───────────────────────────────────
function isPrivateHost(host) {
  if (!host) return false;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  const lower = host.toLowerCase();
  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower === '::') return true;
    if (lower.startsWith('::ffff:')) return true; // IPv4-mapped, в т.ч. private
    if (lower.startsWith('ff')) return true; // multicast ff00::/8 (все)
    if (/^f[cd]/i.test(lower)) return true; // ULA fc00::/7
    if (/^fe[89ab]/i.test(lower)) return true; // link-local fe80::/10
    return false;
  }
  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(Number);
    const [a,b] = parts;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  return lower === 'localhost' || lower.endsWith('.localhost');
}

function isValidExternalUrl(u) {
  try {
    if (typeof u !== 'string' || u.length > 2048) return false;
    const lower = u.trim().toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('file:') || lower.startsWith('vbscript:') || lower.startsWith('blob:')) return false;
    const parsed = new URL(u);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    if (isPrivateHost(parsed.hostname)) return false;
    return true;
  } catch { return false; }
}

// ── IPC sender проверка — п.9 ─────────────────────────────────────
function isSenderAllowed(e) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return false;
    // Разрешаем только наш единственный webContents
    return e.sender && e.sender.id === mainWindow.webContents.id;
  } catch { return false; }
}

// ── Безопасные пути Start Menu — п.10 доверие env ─────────────────
function getStartMenuRoots() {
  // Хардкодим C:\Windows\System32 как надежный fallback, не зависим только от WINDIR
  const FALLBACK_SYSTEM32 = 'C:\\Windows\\System32';
  const FALLBACK_PROGRAMDATA = 'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs';
  const hardCodedStartMenu = FALLBACK_PROGRAMDATA;

  const candidates = [
    // Доверяем env, но валидируем через паттерн Start Menu\Programs
    process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    hardCodedStartMenu
  ].filter(Boolean);

  const roots = [];
  for (const p of candidates) {
    try {
      const norm = path.normalize(p);
      if (!/Start Menu[\\/]+Programs/i.test(norm)) continue;
      if (!path.isAbsolute(norm)) continue;
      // defense-in-depth: проверяем что корень похож на реальный Start Menu
      // должен существовать хотя бы один из типичных маркеров
      const mustExistMarkers = ['desktop.ini', 'Startup', 'Accessories', 'Administrative Tools', 'System Tools'];
      try {
        const hasMarker = mustExistMarkers.some(n => {
          try { return fs.existsSync(path.join(norm, n)); } catch { return false; }
        });
        // если вообще ничего не найдено и папка существует — считаем подозрительным env-инъекцией, пропускаем только если хардкод
        if (!hasMarker && fs.existsSync(norm)) {
          const isHardcoded = norm.toLowerCase() === 'c:\\programdata\\microsoft\\windows\\start menu\\programs';
          if (!isHardcoded) continue;
        }
      } catch {}
      roots.push(norm);
    } catch {}
  }
  return [...new Set(roots)];
}

function getSystem32Path() {
  const envWindir = process.env.WINDIR;
  let windir = 'C:\\Windows';
  if (typeof envWindir === 'string' && envWindir.length > 3 && path.isAbsolute(envWindir) && !envWindir.includes('\0')) {
    // Строгая проверка: только C:\Windows или C:\Windows\...
    if (/^[a-z]:\\windows(\\|$)/i.test(envWindir)) {
      // defense-in-depth: проверяем что реально есть System32\cmd.exe
      try {
        const cand = path.join(envWindir, 'System32', 'cmd.exe');
        // на Linux проверки не будет файла — тогда fallback, но на Windows проверим
        if (process.platform === 'win32') {
          if (fs.existsSync(cand)) windir = envWindir;
        } else {
          windir = envWindir; // на не-Windows доверяем формату
        }
      } catch { /* fallback */ }
    }
  }
  return path.join(windir, 'System32');
}

function isPathInsideAllowedRoots(targetPath, allowedRoots) {
  try {
    const resolved = path.resolve(path.normalize(targetPath));
    const lowerResolved = resolved.toLowerCase();
    for (const root of allowedRoots) {
      const r = path.resolve(path.normalize(root)).toLowerCase();
      const rSep = r.endsWith(path.sep) || r.endsWith('\\') ? r : r + path.sep;
      if (lowerResolved === r || lowerResolved.startsWith(rSep)) return true;
      // Для Windows также проверяем с \
      const rWinSep = r.endsWith('\\') ? r : r + '\\';
      if (lowerResolved.startsWith(rWinSep)) return true;
    }
    return false;
  } catch { return false; }
}

// ── п.1 фикс System32 bypass ──────────────────────────────────────
function isInSystem32(normalizedPath) {
  const system32 = getSystem32Path().toLowerCase();
  const lower = normalizedPath.toLowerCase();
  const sys32WithSep = system32.endsWith('\\') || system32.endsWith(path.sep) ? system32 : system32 + '\\';
  return lower === system32 || lower.startsWith(sys32WithSep);
}

// ── Скан ──────────────────────────────────────────────────────────
function scanAppsSecure() {
  const now = Date.now();
  if (appsCache.data && (now - appsCache.ts) < CACHE_TTL_MS) return appsCache.data;

  const roots = getStartMenuRoots();
  let out = [];
  let dirCount = 0;
  const allowedRootsLower = roots.map(r => path.resolve(r).toLowerCase());

  function isAllowedDir(dir) {
    const d = path.resolve(dir).toLowerCase();
    return allowedRootsLower.some(r => {
      const rSep = r.endsWith(path.sep) ? r : r + path.sep;
      const rWin = r.endsWith('\\') ? r : r + '\\';
      return d === r || d.startsWith(rSep) || d.startsWith(rWin) || d.startsWith(r + '/');
    });
  }

  for (const root of roots) {
    if (out.length >= MAX_SCAN_FILES) break;
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    const queue = [{ dir: root, depth: 0 }];
    const seenReal = new Set();
    while (queue.length && out.length < MAX_SCAN_FILES && dirCount < MAX_SCAN_DIRS) {
      const { dir, depth } = queue.shift();
      if (depth > MAX_SCAN_DEPTH) continue;
      if (!isAllowedDir(dir)) continue;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      if (entries.length > 500) entries = entries.slice(0, 500);
      for (const e of entries) {
        if (out.length >= MAX_SCAN_FILES) break;
        const full = path.join(dir, e.name);
        if (full.includes('\0') || e.name.length > MAX_NAME_LEN) continue;
        if (BLOCKED_NAME_RE.test(e.name)) continue;
        try {
          const lst = fs.lstatSync(full);
          if (lst.isSymbolicLink()) continue;
          if (lst.isDirectory()) {
            if (dirCount >= MAX_SCAN_DIRS) continue;
            let real; try { real = fs.realpathSync(full); } catch { continue; }
            const realLower = real.toLowerCase();
            if (seenReal.has(realLower)) continue;
            seenReal.add(realLower);
            if (!isAllowedDir(real)) continue;
            dirCount++;
            queue.push({ dir: full, depth: depth + 1 });
          } else if (lst.isFile()) {
            if (!ALLOWED_EXT_RE.test(e.name)) continue;
            if (lst.size > 5 * 1024 * 1024) continue;
            const name = path.parse(e.name).name.trim();
            if (!name || name.length > MAX_NAME_LEN) continue;
            const cleanName = name.replace(/[\x00-\x1F\x7F]/g, '').trim();
            if (!cleanName) continue;
            out.push({
              name: cleanName.slice(0, MAX_NAME_LEN),
              path: full,
              dir: path.relative(root, path.dirname(full)).slice(0, 260),
              type: e.name.toLowerCase().endsWith('.lnk') ? 'lnk' : e.name.toLowerCase().endsWith('.url') ? 'url' : 'exe',
              size: lst.size,
              mtimeMs: lst.mtimeMs
            });
          }
        } catch {}
      }
    }
  }

  if (out.length === 0) {
    try {
      const mock = require('./src/mockApps')();
      out = mock.map(m => ({
        name: String(m.name).slice(0, MAX_NAME_LEN).replace(/[\x00-\x1F\x7F]/g, ''),
        path: String(m.path || '').slice(0, 512),
        type: m.type || 'lnk',
        icon: m.icon || '📦',
        category: m.category || '',
        pinned: !!m.pinned,
        recent: !!m.recent,
        mtime: m.mtime || null
      }));
    } catch { out = []; }
  } else {
    const seen = new Set();
    const uniq = [];
    for (const a of out) {
      const key = a.name.toLowerCase().normalize('NFKC');
      if (!seen.has(key)) { seen.add(key); uniq.push(a); }
    }
    uniq.sort((a,b) => a.name.localeCompare(b.name, 'ru', { sensitivity: 'base', numeric: true }));
    out = uniq.slice(0, MAX_SCAN_FILES);
  }
  appsCache = { data: out, ts: now };
  return out;
}

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { showMenu(); mainWindow.focus(); } catch {}
    }
  });
}

function createTray() {
  let img = nativeImage.createEmpty();
  try { img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGP8z8DAwMDAxMDAwMDAAAAnAQMB2kMJVAAAAABJRU5ErkJggg=='); } catch {}
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  tray = new Tray(img);
  tray.setToolTip('StartORBack — клик чтобы показать Пуск (Alt+Пробел)');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Показать Пуск', click: () => { if (!isRateLimited('tray:show')) toggleMenu(); }, accelerator: 'Alt+Space' },
    { type: 'separator' },
    { label: 'Тема: Windows 11 (центр)', type: 'radio', checked: currentTheme==='win11', click: () => setTheme('win11') },
    { label: 'Тема: Windows 10 (плитки)', type: 'radio', checked: currentTheme==='win10', click: () => setTheme('win10') },
    { label: 'Тема: Windows 7 (классика)', type: 'radio', checked: currentTheme==='win7', click: () => setTheme('win7') },
    { type: 'separator' },
    { label: 'О StartORBack', click: () => {
      dialog.showMessageBox({
        title: 'StartORBack',
        message: 'StartORBack v3.0 (hardened)\n\n• CSP + sandbox + deny-by-default\n• Фикс System32 bypass, SSRF, traversal\n• Не изменяет систему, работает только пока запущена',
        buttons: ['ОК'], type: 'info'
      });
    }},
    { label: 'Выход (вернуть обычный Пуск)', click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { if (!isRateLimited('tray:click')) toggleMenu(); });
  tray.on('double-click', () => { if (!isRateLimited('tray:dbl')) toggleMenu(); });
}

function getMenuBounds(theme) {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primary.workAreaSize;
    const { width: fullW, height: fullH } = primary.size;
    const taskbarH = Math.max(0, fullH - sh - (primary.workArea.y || 0));
    let w = 640, h = 640;
    if (theme === 'win7') { w = 540; h = 520; } else if (theme === 'win10') { w = 680; h = 600; } else { w = 640; h = 650; }
    const margin = 8;
    let x, y;
    if (theme === 'win11') { x = Math.round((sw - w) / 2); y = Math.round(sh - h - margin); y += (primary.workArea.y || 0); }
    else { x = (primary.workArea.x || 0) + margin; y = (primary.workArea.y || 0) + sh - h - margin; }
    x = Math.max(margin, Math.min(x, sw - w - margin)); y = Math.max(margin, y);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return { x: 8, y: 8, width: 640, height: 640, taskbarH: 48 };
    return { x, y, width: w, height: h, taskbarH };
  } catch { return { x: 8, y: 8, width: 640, height: 640, taskbarH: 48 }; }
}

function registerSecurityHandlers() {
  if (headersRegistered) return;
  headersRegistered = true;
  const ses = session.defaultSession;
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    const csp = [
      "default-src 'self' file:",
      "script-src 'self' file:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "img-src 'self' file: data: https:",
      "connect-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join('; ');
    headers['Content-Security-Policy'] = [csp];
    headers['X-Content-Type-Options'] = ['nosniff'];
    headers['Referrer-Policy'] = ['no-referrer'];
    headers['Permissions-Policy'] = ['geolocation=(), microphone=(), camera=()'];
    callback({ responseHeaders: headers });
  });
  ses.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(permission === 'notifications');
  });
  ses.setPermissionCheckHandler((webContents, permission) => permission === 'notifications');
}

function createWindow() {
  const bounds = getMenuBounds(currentTheme);
  mainWindow = new BrowserWindow({
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    show: false, frame: false, transparent: true, resizable: false, movable: false,
    hasShadow: true, skipTaskbar: true, alwaysOnTop: true, focusable: true,
    fullscreenable: false, maximizable: false, minimizable: false, backgroundColor: '#00000000', title: 'StartORBack',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
      sandbox: true, enableRemoteModule: false, allowRunningInsecureContent: false,
      webSecurity: true, navigateOnDragDrop: false, spellcheck: false, backgroundThrottling: false
    }
  });

  // ── п.6 фикс will-navigate — точное сравнение ────────────────────
  const allowedUrl = pathToFileURL(path.join(__dirname, 'renderer', 'index.html')).href;
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // Разрешаем только наш index.html (и с query/hash)
    if (url !== allowedUrl && !url.startsWith(allowedUrl + '?') && !url.startsWith(allowedUrl + '#')) {
      e.preventDefault();
    }
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  mainWindow.webContents.on('did-finish-load', () => {
    try { mainWindow.webContents.send('theme-changed', currentTheme); mainWindow.webContents.send('accent-changed', accent); } catch {}
  });

  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnAllWorkspaces: true, skipTransformProcessType: true }); } catch {}
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // авто-показ для демо — через 400мс чтобы юзер увидел что работает
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => { try { showMenu(); } catch {} }, 400);
  });
  mainWindow.on('blur', () => {
    setTimeout(() => { try { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) hideMenu(); } catch {} }, 120);
  });
  mainWindow.on('hide', () => { try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.clearHistory(); } catch {} });
}

function showMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = getMenuBounds(currentTheme);
    if (bounds.width < 200 || bounds.height < 200 || bounds.width > 2000 || bounds.height > 2000) return;
    mainWindow.setBounds(bounds); mainWindow.show(); mainWindow.focus();
    mainWindow.webContents.send('menu-show'); isVisible = true;
  } catch {}
}
function hideMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try { mainWindow.hide(); mainWindow.webContents.send('menu-hide'); isVisible = false; } catch {}
}
function toggleMenu() { try { if (isVisible) hideMenu(); else showMenu(); } catch {} }
function setTheme(theme) {
  if (!isValidTheme(theme)) return;
  currentTheme = theme;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = getMenuBounds(theme); mainWindow.setBounds(b); mainWindow.webContents.send('theme-changed', theme);
    }
    if (tray && !tray.isDestroyed()) createTray();
  } catch {}
}

// ── IPC с sender проверкой — п.9 ──────────────────────────────────
ipcMain.handle('get-apps', (e) => {
  if (!isSenderAllowed(e)) return { ok:false, code:'forbidden_sender' };
  if (isRateLimited(`get-apps:${e.sender.id}`)) return { ok:false, code:'rate_limited' };
  try { return scanAppsSecure(); } catch { return { ok:false, code:'scan_failed' }; }
});
ipcMain.handle('get-system-info', (e) => {
  if (!isSenderAllowed(e)) return { platform: os.platform(), theme: currentTheme, accent };
  if (isRateLimited(`sysinfo:${e.sender.id}`)) return { platform: os.platform(), theme: currentTheme, accent };
  try {
    let user = 'Пользователь';
    try { user = os.userInfo().username || user; } catch {}
    user = String(user).slice(0, 64).replace(/[\x00-\x1F\x7F]/g, '');
    return { user, platform: String(os.platform()).slice(0, 32), release: String(os.release()).slice(0, 64), theme: currentTheme, accent };
  } catch { return { user: 'Пользователь', platform: 'win32', release: '', theme: currentTheme, accent }; }
});
ipcMain.handle('launch-app', async (e, appPath) => {
  if (!isSenderAllowed(e)) return { ok:false, error:'forbidden sender' };
  if (isRateLimited(`launch:${e.sender.id}`)) return { ok:false, error:'rate limited, try again' };
  try {
    if (typeof appPath !== 'string' || !appPath || appPath.length > 1024) return { ok:false, error:'invalid path' };
    if (appPath.includes('\0')) return { ok:false, error:'invalid path' };
    const trimmed = appPath.trim();
    const lowerTrim = trimmed.toLowerCase();

    // 1) URI-схемы (не пути) — можно сразу, до path-валидации
    for (const scheme of ALLOWED_URI_SCHEMES) {
      if (lowerTrim.startsWith(scheme)) {
        if (!/^ms-[a-z-]+:.*$/i.test(trimmed)) return { ok:false, error:'invalid uri scheme' };
        try { await shell.openExternal(trimmed); try { hideMenu(); } catch {} return { ok:true }; }
        catch (err) { return { ok:false, error: String(err).slice(0,200) }; }
      }
    }

    // 2) Теперь пути: сначала path-валидация, потом любые чтения
    const normalized = path.normalize(trimmed);
    if (!ALLOWED_EXT_RE.test(normalized)) return { ok:false, error:'unsupported file type' };
    const roots = getStartMenuRoots();
    if (!isPathInsideAllowedRoots(normalized, roots) && !isInSystem32(normalized))
      return { ok:false, error:'path not allowed' };

    let stat; try { stat = fs.statSync(normalized); } catch { return { ok:false, error:'file not found' }; }
    if (!stat.isFile()) return { ok:false, error:'not a file' };
    if (stat.size > 50 * 1024 * 1024) return { ok:false, error:'file too large' };
    let real; try { real = fs.realpathSync(normalized); } catch { real = normalized; }
    if (!isPathInsideAllowedRoots(real, roots) && !isInSystem32(real))
      return { ok:false, error:'resolved path not allowed' };

    // 3) Только теперь читаем .url — путь уже проверен
    if (real.toLowerCase().endsWith('.url')) {
      try {
        const content = fs.readFileSync(real, 'utf8').slice(0, 2048);
        const m = content.match(/^\s*URL\s*=\s*(.+)\s*$/im);
        if (!m) return { ok:false, error:'invalid .url' };
        const target = m[1].trim();
        if (!isValidExternalUrl(target)) return { ok:false, error:'url in .url not allowed' };
        await shell.openExternal(target);
        try { hideMenu(); } catch {}
        return { ok:true };
      } catch { return { ok:false, error:'cannot read .url' }; }
    }

    const err = await shell.openPath(real);
    if (err) return { ok:false, error: err.slice(0, 200) };
    try { hideMenu(); } catch {}
    return { ok:true };
  } catch (err) { return { ok:false, error: String(err).slice(0, 200) }; }
});
ipcMain.handle('open-location', async (e, p) => {
  if (!isSenderAllowed(e)) return { ok:false, error:'forbidden sender' };
  if (isRateLimited(`openloc:${e.sender.id}`)) return { ok:false, error:'rate limited' };
  try {
    if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return { ok:false, error:'invalid path' };
    const norm = path.normalize(p.trim());
    const roots = getStartMenuRoots();
    if (!isPathInsideAllowedRoots(norm, roots)) return { ok:false, error:'path not allowed' };
    // Показываем в проводнике, а не запускаем ярлык
    shell.showItemInFolder(norm); return { ok:true };
  } catch(err){ return {ok:false, error: String(err).slice(0,200)} }
});
ipcMain.handle('open-external', async (e, url) => {
  if (!isSenderAllowed(e)) return { ok:false, error:'forbidden sender' };
  if (isRateLimited(`openext:${e.sender.id}`)) return { ok:false, error:'rate limited' };
  if (!isValidExternalUrl(url)) return { ok:false, error:'url not allowed' };
  try { await shell.openExternal(url); return { ok:true }; } catch(err){ return { ok:false, error: String(err).slice(0,200) } }
});
ipcMain.on('hide-menu', (e) => { if (!isSenderAllowed(e)) return; if (!isRateLimited('hide')) hideMenu(); });
ipcMain.on('set-theme', (e, t) => {
  if (!isSenderAllowed(e)) return;
  if (isRateLimited(`theme:${e.sender.id}`)) return;
  if (!isValidTheme(t)) return;
  setTheme(t);
});
ipcMain.on('set-accent', (e, color) => {
  if (!isSenderAllowed(e)) return;
  if (isRateLimited(`accent:${e.sender.id}`)) return;
  if (!isValidHexColor(color)) return;
  accent = color.toLowerCase();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accent-changed', accent); } catch {}
});
ipcMain.on('toggle-menu', (e) => { if (!isSenderAllowed(e)) return; if (!isRateLimited('toggle')) toggleMenu(); });
ipcMain.handle('get-theme', (e) => { if (!isSenderAllowed(e)) return null; return currentTheme; });

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'win32') { try { app.setAppUserModelId('com.startorback.app'); } catch {} }
  // п.5 удалено: OutOfBlinkCors больше не трогаем
  registerSecurityHandlers();
  createTray();
  createWindow();
  let ok = globalShortcut.register('Alt+Space', () => { if (!isRateLimited('hk:altspace')) toggleMenu(); });
  if (!ok) console.warn('[StartORBack] Alt+Space hotkey failed (occupied)');
  try { globalShortcut.register('Ctrl+Alt+Space', () => { if (!isRateLimited('hk:ctrlaltspace')) toggleMenu(); }); } catch {}
  setTimeout(() => {
    try { if (tray && !tray.isDestroyed()) tray.displayBalloon({ title: 'StartORBack запущен (безопасный режим)', content: 'Alt+Пробел или клик по трею — показать Пуск. Закроешь программу — вернётся обычный. Ничего не меняем в системе.', iconType: 'info' }); } catch {}
  }, 1200);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  appsCache = { data: null, ts: 0 }; rateMap.clear();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
process.on('uncaughtException', (err) => { console.error('[StartORBack] uncaughtException:', err && err.message ? err.message.slice(0, 300) : err); });
process.on('unhandledRejection', (reason) => { console.error('[StartORBack] unhandledRejection:', String(reason).slice(0, 300)); });
app.on('web-contents-created', (_e, contents) => { contents.on('will-attach-webview', (e) => e.preventDefault()); });
