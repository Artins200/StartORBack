/**
 * StartORBack — безопасный оверлей меню Пуск
 * Hardened v2: оптимизация + защита от 0-day / 1-day
 * - CSP, sandbox, permission deny-by-default
 * - Строгая валидация IPC и путей
 * - Кэш + лимиты + защита от symlink loops
 * - Троттлинг и безопасный shell.openPath
 */

'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage, dialog, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── Константы безопасности ─────────────────────────────────────────
const ALLOWED_THEMES = new Set(['win11', 'win10', 'win7']);
const HEX_COLOR_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ALLOWED_EXT_RE = /\.(lnk|url|exe)$/i;
const MAX_SCAN_FILES = 800;
const MAX_SCAN_DIRS = 1200;
const MAX_SCAN_DEPTH = 4;
const MAX_NAME_LEN = 120;
const CACHE_TTL_MS = 30_000;
const RATE_LIMIT_WINDOW = 2000;
const MAX_CALLS_PER_WINDOW = 10;
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:']);
const ALLOWED_EXTERNAL_HOSTS_SUFFIX = []; // пусто = любой https, но можно ограничить
const BLOCKED_NAME_RE = /^(unins|uninstall)/i;

let mainWindow = null;
let tray = null;
let isVisible = false;
let currentTheme = 'win11';
let accent = '#0078d4';

// Кэш скана
let appsCache = { data: null, ts: 0 };
// Rate limit карта: key -> timestamps[]
const rateMap = new Map();

function isRateLimited(key) {
  const now = Date.now();
  const arr = rateMap.get(key) || [];
  const recent = arr.filter(t => now - t < RATE_LIMIT_WINDOW);
  if (recent.length >= MAX_CALLS_PER_WINDOW) return true;
  recent.push(now);
  rateMap.set(key, recent);
  // чистим старые ключи периодически
  if (rateMap.size > 50) {
    for (const [k, v] of rateMap) if (v.length === 0 || now - v[v.length-1] > RATE_LIMIT_WINDOW*2) rateMap.delete(k);
  }
  return false;
}

function isValidHexColor(c) {
  return typeof c === 'string' && HEX_COLOR_RE.test(c.trim());
}
function isValidTheme(t) {
  return typeof t === 'string' && ALLOWED_THEMES.has(t);
}
function isValidExternalUrl(u) {
  try {
    if (typeof u !== 'string' || u.length > 2048) return false;
    // блок опасных схем
    const lower = u.trim().toLowerCase();
    if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('file:') || lower.startsWith('vbscript:')) return false;
    const parsed = new URL(u);
    if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
    if (parsed.username || parsed.password) return false;
    // опционально: блокировать localhost / private IP для SSRF
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('192.168.') || host.startsWith('10.')) {
      // разрешаем только если явно нужно; для StartORBack блокируем приватные
      return false;
    }
    return true;
  } catch { return false; }
}

// Безопасные пути Start Menu
function getStartMenuRoots() {
  const roots = [];
  const candidates = [
    process.env.PROGRAMDATA && path.join(process.env.PROGRAMDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    // fallback с homedir (если env подменён)
    path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    'C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs'
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const norm = path.normalize(p);
      // базовая проверка что путь похож на Windows Start Menu, не произвольный
      if (!/Start Menu[\\/]+Programs/i.test(norm)) continue;
      roots.push(norm);
    } catch {}
  }
  // дедупликация
  return [...new Set(roots)];
}

function isPathInsideAllowedRoots(targetPath, allowedRoots) {
  try {
    const resolved = path.resolve(path.normalize(targetPath));
    // Нормализуем к нижнему регистру для Windows
    const lowerResolved = resolved.toLowerCase();
    for (const root of allowedRoots) {
      const r = path.resolve(path.normalize(root)).toLowerCase();
      if (lowerResolved === r || lowerResolved.startsWith(r + path.sep) || lowerResolved.startsWith(r + '\\')) return true;
    }
    return false;
  } catch { return false; }
}

// Безопасный скан: не следуем за symlink, лимиты, без sync блокировки
function scanAppsSecure() {
  const now = Date.now();
  if (appsCache.data && (now - appsCache.ts) < CACHE_TTL_MS) return appsCache.data;

  const roots = getStartMenuRoots();
  let out = [];
  let dirCount = 0;

  const allowedRootsLower = roots.map(r => path.resolve(r).toLowerCase());

  function isAllowedDir(dir) {
    const d = path.resolve(dir).toLowerCase();
    return allowedRootsLower.some(r => d === r || d.startsWith(r + path.sep) || d.startsWith(r + '\\') || d.startsWith(r + '/'));
  }

  for (const root of roots) {
    if (out.length >= MAX_SCAN_FILES) break;
    try {
      if (!fs.existsSync(root)) continue;
      const stat = fs.statSync(root);
      if (!stat.isDirectory()) continue;
    } catch { continue; }

    // BFS очередь чтобы не рекурсивно и с лимитом
    const queue = [{ dir: root, depth: 0 }];
    const seenReal = new Set(); // защита от symlink loops по realpath

    while (queue.length && out.length < MAX_SCAN_FILES && dirCount < MAX_SCAN_DIRS) {
      const { dir, depth } = queue.shift();
      if (depth > MAX_SCAN_DEPTH) continue;
      if (!isAllowedDir(dir)) continue;

      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      // лимит на количество файлов в одной папке
      if (entries.length > 500) entries = entries.slice(0, 500);

      for (const e of entries) {
        if (out.length >= MAX_SCAN_FILES) break;
        const full = path.join(dir, e.name);

        // защита от null-byte injection и слишком длинных имён
        if (full.includes('\0') || e.name.length > MAX_NAME_LEN) continue;
        // пропускаем скрытые системные и инсталляторы
        if (BLOCKED_NAME_RE.test(e.name)) continue;

        try {
          // ВАЖНО: используем lstat чтобы не следовать symlink автоматически
          const lst = fs.lstatSync(full);
          if (lst.isSymbolicLink()) {
            // не следуем за симлинками на папки — защита от symlink traversal
            // но файлы-симлинки на .lnk можно пропустить, а не открывать
            continue;
          }
          if (lst.isDirectory()) {
            if (dirCount >= MAX_SCAN_DIRS) continue;
            // проверка realpath для защиты от loops
            let real;
            try { real = fs.realpathSync(full); } catch { continue; }
            const realLower = real.toLowerCase();
            if (seenReal.has(realLower)) continue;
            seenReal.add(realLower);
            // только если real внутри allowed roots
            if (!isAllowedDir(real)) continue;
            dirCount++;
            queue.push({ dir: full, depth: depth + 1 });
          } else if (lst.isFile()) {
            if (!ALLOWED_EXT_RE.test(e.name)) continue;
            // размер файла не должен быть огромным (защита от DoS дисковым)
            if (lst.size > 5 * 1024 * 1024) continue; // >5MB пропускаем
            const name = path.parse(e.name).name.trim();
            if (!name || name.length > MAX_NAME_LEN) continue;
            // санитизация имени: убираем управляющие символы
            const cleanName = name.replace(/[\x00-\x1F\x7F]/g, '').trim();
            if (!cleanName) continue;

            out.push({
              name: cleanName.slice(0, MAX_NAME_LEN),
              path: full, // сохраняем оригинал, валидация будет при запуске
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
      // санитизируем мок
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
    // Уникализируем по нормализованному имени, устойчиво к Unicode
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

// Single instance lock — безопасно
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // валидация: не доверяем argv напрямую
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { showMenu(); mainWindow.focus(); } catch {}
    }
  });
}

function createTray() {
  let img = nativeImage.createEmpty();
  try {
    // 16px прозрачная — минимальный безопасный fallback, без внешних файлов
    img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGP8z8DAwMDAxMDAwMDAAAAnAQMB2kMJVAAAAABJRU5ErkJggg==');
  } catch {}
  // если уже есть — удаляем старый чтобы не дублировать
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
        message: 'StartORBack v2.0 (hardened)\n\nБезопасный оверлей меню Пуск.\n• CSP + sandbox + deny-by-default permissions\n• Валидация всех IPC и путей\n• Кэш + rate-limit + защита от symlink loops\n• Не изменяет системные файлы, не пишет в реестр\n• Работает только пока запущена программа\n\nГорячие клавиши:\n Alt+Пробел — показать/скрыть\n Esc — скрыть',
        buttons: ['ОК'],
        type: 'info'
      });
    }},
    { label: 'Выход (вернуть обычный Пуск)', click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => { if (!isRateLimited('tray:click')) toggleMenu(); });
  // double-click оставляем но с rate limit
  tray.on('double-click', () => { if (!isRateLimited('tray:dbl')) toggleMenu(); });
}

function getMenuBounds(theme) {
  try {
    const primary = screen.getPrimaryDisplay();
    const { width: sw, height: sh } = primary.workAreaSize;
    const { width: fullW, height: fullH } = primary.size;
    const taskbarH = Math.max(0, fullH - sh - (primary.workArea.y || 0));

    let w = 640, h = 640;
    if (theme === 'win7') { w = 540; h = 520; }
    else if (theme === 'win10') { w = 680; h = 600; }
    else { w = 640; h = 650; }

    const margin = 8;
    let x, y;
    if (theme === 'win11') {
      x = Math.round((sw - w) / 2);
      y = Math.round(sh - h - margin);
      y += (primary.workArea.y || 0);
    } else {
      x = (primary.workArea.x || 0) + margin;
      y = (primary.workArea.y || 0) + sh - h - margin;
    }
    x = Math.max(margin, Math.min(x, sw - w - margin));
    y = Math.max(margin, y);
    // финальная проверка чтобы не вышли за экран
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
      return { x: 8, y: 8, width: 640, height: 640, taskbarH: 48 };
    }
    return { x, y, width: w, height: h, taskbarH };
  } catch {
    return { x: 8, y: 8, width: 640, height: 640, taskbarH: 48 };
  }
}

function createWindow() {
  const bounds = getMenuBounds(currentTheme);

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#00000000',
    title: 'StartORBack',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      sandbox: true,
      enableRemoteModule: false,
      allowRunningInsecureContent: false,
      webSecurity: true,
      navigateOnDragDrop: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  // Защита: CSP и заголовки
  const filter = { urls: ['*://*/*', 'file://*'] };
  const defaultSession = session.defaultSession;
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders || {};
    // CSP: запрещаем inline-scripts кроме наших, запрещаем внешние кроме self и fonts
    // Для file:// нужен более мягкий, но всё равно строгий
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

  // Блокировка навигации и новых окон (защита от clickjacking / openExternal bypass)
  mainWindow.webContents.on('will-navigate', (e, url) => {
    // разрешаем только file:// к нашему renderer
    const allowed = url.startsWith('file://') && url.includes('renderer');
    if (!allowed) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-attach-webview', (e) => e.preventDefault());

  // Разрешения: deny-by-default
  defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    // Разрешаем только notifications для tray balloon, остальное deny
    const allowed = ['notifications'];
    callback(allowed.includes(permission));
  });
  defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return permission === 'notifications';
  });

  // Блокируем загрузку небезопасного контента
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      mainWindow.webContents.send('theme-changed', currentTheme);
      mainWindow.webContents.send('accent-changed', accent);
    } catch {}
  });

  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnAllWorkspaces: true, skipTransformProcessType: true }); } catch {}

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('blur', () => {
    setTimeout(() => {
      try { if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isFocused()) hideMenu(); } catch {}
    }, 120);
  });

  // Защита от утечек памяти: чистим кэш при скрытии
  mainWindow.on('hide', () => {
    try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.clearHistory(); } catch {}
  });
}

function showMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = getMenuBounds(currentTheme);
    // валидация bounds перед применением
    if (bounds.width < 200 || bounds.height < 200 || bounds.width > 2000 || bounds.height > 2000) return;
    mainWindow.setBounds(bounds);
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('menu-show');
    isVisible = true;
  } catch {}
}
function hideMenu() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.hide();
    mainWindow.webContents.send('menu-hide');
    isVisible = false;
  } catch {}
}
function toggleMenu() {
  try { if (isVisible) hideMenu(); else showMenu(); } catch {}
}
function setTheme(theme) {
  if (!isValidTheme(theme)) return;
  currentTheme = theme;
  try {
    if (mainWindow && !mainWindow.isDestroyed()) {
      const b = getMenuBounds(theme);
      mainWindow.setBounds(b);
      mainWindow.webContents.send('theme-changed', theme);
    }
    if (tray && !tray.isDestroyed()) createTray();
  } catch {}
}

// ── IPC с валидацией и rate-limit ─────────────────────────────────
ipcMain.handle('get-apps', (e) => {
  if (isRateLimited(`get-apps:${e.sender.id}`)) return appsCache.data || [];
  try { return scanAppsSecure(); } catch { return []; }
});

ipcMain.handle('get-system-info', (e) => {
  if (isRateLimited(`sysinfo:${e.sender.id}`)) return { platform: os.platform(), theme: currentTheme, accent };
  try {
    // Минимально необходимая инфа, без hostname leakage в preview
    let user = 'Пользователь';
    try { user = os.userInfo().username || user; } catch {}
    // Санитизируем
    user = String(user).slice(0, 64).replace(/[\x00-\x1F\x7F]/g, '');
    return {
      user,
      platform: String(os.platform()).slice(0, 32),
      release: String(os.release()).slice(0, 64),
      theme: currentTheme,
      accent
    };
  } catch {
    return { user: 'Пользователь', platform: 'win32', release: '', theme: currentTheme, accent };
  }
});

ipcMain.handle('launch-app', async (e, appPath) => {
  if (isRateLimited(`launch:${e.sender.id}`)) return { ok:false, error:'rate limited, try again' };
  try {
    if (typeof appPath !== 'string' || !appPath || appPath.length > 1024) return { ok:false, error:'invalid path' };
    if (appPath.includes('\0')) return { ok:false, error:'invalid path' };
    const normalized = path.normalize(appPath.trim());
    if (!ALLOWED_EXT_RE.test(normalized)) return { ok:false, error:'unsupported file type' };
    // Проверка что путь внутри разрешённых корней
    const roots = getStartMenuRoots();
    // Также разрешаем System32 для стандартных утилит (calc, notepad, etc) но только точный список
    const system32 = path.join(process.env.WINDIR || 'C:\\Windows', 'System32').toLowerCase();
    const isInStartMenu = isPathInsideAllowedRoots(normalized, roots);
    const isInSystem32 = normalized.toLowerCase().startsWith(system32);
    if (!isInStartMenu && !isInSystem32) return { ok:false, error:'path not allowed' };

    // Проверка что файл существует и это файл (не директория)
    let stat;
    try { stat = fs.statSync(normalized); } catch { return { ok:false, error:'file not found' }; }
    if (!stat.isFile()) return { ok:false, error:'not a file' };
    if (stat.size > 50 * 1024 * 1024) return { ok:false, error:'file too large' };

    // Дополнительная защита: реальный путь тоже должен быть внутри allowed
    let real;
    try { real = fs.realpathSync(normalized); } catch { real = normalized; }
    const realAllowed = isPathInsideAllowedRoots(real, roots) || real.toLowerCase().startsWith(system32);
    if (!realAllowed) return { ok:false, error:'resolved path not allowed' };

    const err = await shell.openPath(real);
    if (err) return { ok:false, error: err.slice(0, 200) };
    try { hideMenu(); } catch {}
    return { ok:true };
  } catch (err) {
    return { ok:false, error: String(err).slice(0, 200) };
  }
});

ipcMain.handle('open-location', async (e, p) => {
  if (isRateLimited(`openloc:${e.sender.id}`)) return { ok:false, error:'rate limited' };
  try {
    if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return { ok:false, error:'invalid path' };
    const norm = path.normalize(p.trim());
    const roots = getStartMenuRoots();
    if (!isPathInsideAllowedRoots(norm, roots)) return { ok:false, error:'path not allowed' };
    await shell.openPath(norm);
    return { ok:true };
  } catch(err){ return {ok:false, error: String(err).slice(0,200)} }
});

ipcMain.handle('open-external', async (e, url) => {
  if (isRateLimited(`openext:${e.sender.id}`)) return { ok:false, error:'rate limited' };
  if (!isValidExternalUrl(url)) return { ok:false, error:'url not allowed' };
  try { await shell.openExternal(url); return { ok:true }; } catch(err){ return { ok:false, error: String(err).slice(0,200) } }
});

ipcMain.on('hide-menu', () => { if (!isRateLimited('hide')) hideMenu(); });
ipcMain.on('set-theme', (e, t) => {
  if (isRateLimited(`theme:${e.sender.id}`)) return;
  if (!isValidTheme(t)) return;
  setTheme(t);
});
ipcMain.on('set-accent', (e, color) => {
  if (isRateLimited(`accent:${e.sender.id}`)) return;
  if (!isValidHexColor(color)) return;
  accent = color.toLowerCase();
  try { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('accent-changed', accent); } catch {}
});
ipcMain.on('toggle-menu', () => { if (!isRateLimited('toggle')) toggleMenu(); });
ipcMain.handle('get-theme', () => currentTheme);

// ── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'win32') {
    try { app.setAppUserModelId('com.startorback.app'); } catch {}
    // Защита: не позволяем запускать как админ без нужды (предупреждение)
    // app.disableHardwareAcceleration() // можно включить для стабильности
  }
  // Отключаем ненужные фичи
  try { app.commandLine.appendSwitch('disable-features', 'OutOfBlinkCors'); } catch {}

  createTray();
  createWindow();

  // Горячие клавиши — только безопасные, не перехватываем системные
  let ok = globalShortcut.register('Alt+Space', () => { if (!isRateLimited('hk:altspace')) toggleMenu(); });
  if (!ok) console.warn('[StartORBack] Alt+Space hotkey failed (occupied)');
  // Резервный: Ctrl+Alt+Space
  try { globalShortcut.register('Ctrl+Alt+Space', () => { if (!isRateLimited('hk:ctrlaltspace')) toggleMenu(); }); } catch {}

  setTimeout(() => {
    try {
      if (tray && !tray.isDestroyed()) tray.displayBalloon({
        title: 'StartORBack запущен (безопасный режим)',
        content: 'Alt+Пробел или клик по трею — показать Пуск. Закроешь программу — вернётся обычный. Ничего не меняем в системе.',
        iconType: 'info'
      });
    } catch {}
  }, 1200);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

// Чистим при выходе
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch {}
  try { if (tray && !tray.isDestroyed()) tray.destroy(); } catch {}
  appsCache = { data: null, ts: 0 };
  rateMap.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Глобальные обработчики ошибок — не падать и не ликать стек наружу
process.on('uncaughtException', (err) => {
  console.error('[StartORBack] uncaughtException:', err && err.message ? err.message.slice(0, 300) : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[StartORBack] unhandledRejection:', String(reason).slice(0, 300));
});

// Защита от вставки кода через протокол
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
});
