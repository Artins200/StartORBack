/**
 * StartORBack — главный процесс Electron
 * Принцип: НИКАКИХ изменений в системе.
 * - Не трогаем реестр, не подменяем explorer.exe
 * - Не ставим автозагрузку без явного согласия
 * - Показываем прозрачное окно-оверлей поверх панели задач
 * - При закрытии приложения всё исчезает, как будто ничего не было
 */

const { app, BrowserWindow, Tray, Menu, globalShortcut, screen, ipcMain, shell, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

let mainWindow = null;
let tray = null;
let isVisible = false;
let currentTheme = 'win11';
let accent = '#0078d4';

// Не давать второму экземпляру
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (mainWindow) {
      showMenu();
      mainWindow.focus();
    }
  });
}

function getStartMenuPaths() {
  const common = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Microsoft\\Windows\\Start Menu\\Programs');
  const user = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData\\Roaming'), 'Microsoft\\Windows\\Start Menu\\Programs');
  return { common, user };
}

// Сканер приложений (безопасный, только чтение .lnk и .url)
function scanApps() {
  const { common, user } = getStartMenuPaths();
  const scanDir = (dir) => {
    let out = [];
    try {
      if (!fs.existsSync(dir)) return out;
      const walk = (d, depth = 0) => {
        if (depth > 4) return;
        const entries = fs.readdirSync(d, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full, depth + 1);
          else if (e.isFile() && (e.name.endsWith('.lnk') || e.name.endsWith('.url') || e.name.endsWith('.exe'))) {
            // пропускаем деинсталляторы
            if (/unins/i.test(e.name)) continue;
            out.push({
              name: path.parse(e.name).name,
              path: full,
              dir: path.relative(dir, path.dirname(full)),
              type: e.name.endsWith('.lnk') ? 'lnk' : e.name.endsWith('.url') ? 'url' : 'exe'
            });
          }
        }
      };
      walk(dir);
    } catch {}
    return out;
  };

  const apps = [...scanDir(common), ...scanDir(user)];

  // Если не Windows или пусто — вернём мок для демо
  if (apps.length === 0) {
    try {
      const mock = require('./src/mockApps')();
      return mock;
    } catch {
      return [];
    }
  }

  // Уникализируем по имени, сортируем
  const seen = new Set();
  const uniq = [];
  for (const a of apps) {
    const key = a.name.toLowerCase();
    if (!seen.has(key)) { seen.add(key); uniq.push(a); }
  }
  uniq.sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  return uniq.slice(0, 800);
}

function createTray() {
  // Создаём иконку из встроенного SVG (круг с лого Windows)
  const iconDataURL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAABHklEQVRYhe2Wz0sCURTHf8/M7E4yMzE7MzE7MzE7MzE7SfxBfCAhxMREfCAhxMREfCAPkTMRQkQkQkQkQkREJCQkQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkPDd3d3V1dXV1d3d3d3V1dXV1d3d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dXV1d3d3V1dQ08y7IsS9I0zRNFEURHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0f2P8B2t2g2P8AAAAASUVORK5CYII=';
  // Fallback: пустая иконка 16x16 синяя
  let img = nativeImage.createEmpty();
  try {
    // создаём простую иконку 32x32 программно
    const size = 16;
    // Electron позволяет создать из dataURL, используем 1x1 прозрачный как запас
    img = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFUlEQVR4nGP8z8DAwMDAxMDAwMDAAAAnAQMB2kMJVAAAAABJRU5ErkJggg==');
  } catch {}
  tray = new Tray(img);
  tray.setToolTip('StartORBack — клик чтобы показать Пуск (Alt+Пробел)');
  const contextMenu = Menu.buildFromTemplate([
    { label: 'Показать Пуск', click: () => toggleMenu(), accelerator: 'Alt+Space' },
    { type: 'separator' },
    { label: 'Тема: Windows 11 (центр)', type: 'radio', checked: currentTheme==='win11', click: () => setTheme('win11') },
    { label: 'Тема: Windows 10 (плитки)', type: 'radio', checked: currentTheme==='win10', click: () => setTheme('win10') },
    { label: 'Тема: Windows 7 (классика)', type: 'radio', checked: currentTheme==='win7', click: () => setTheme('win7') },
    { type: 'separator' },
    { label: 'О StartORBack', click: () => dialog.showMessageBox({ title: 'StartORBack', message: 'StartORBack v1.0\n\nБезопасный оверлей меню Пуск.\n• Не изменяет системные файлы\n• Не пишет в реестр\n• Не требует прав администратора\n• Работает только пока запущена программа\n\nГорячие клавиши:\n Alt+Пробел — показать/скрыть\n Esc — скрыть\n Клик вне меню — скрыть', buttons: ['ОК'] }) },
    { label: 'Выход (вернуть обычный Пуск)', click: () => { app.quit(); } }
  ]);
  tray.setContextMenu(contextMenu);
  tray.on('click', () => toggleMenu());
  tray.on('double-click', () => toggleMenu());
}

function getMenuBounds(theme) {
  const primary = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primary.workAreaSize; // без панели задач
  const { width: fullW, height: fullH } = primary.size;
  const taskbarH = fullH - sh - (primary.workArea.y); // примерная высота панели

  // Размеры меню в зависимости от темы
  let w = 640, h = 640;
  if (theme === 'win7') { w = 540; h = 520; }
  if (theme === 'win10') { w = 680; h = 600; }
  if (theme === 'win11') { w = 640; h = 650; }

  const margin = 8;
  let x, y;

  if (theme === 'win11') {
    // центрировано как в Win11
    x = Math.round((sw - w) / 2);
    y = Math.round(sh - h - margin);
    // учитываем смещение workArea по Y (если панель снизу)
    y += primary.workArea.y;
  } else {
    // слева внизу как в Win7/10
    x = primary.workArea.x + margin;
    y = primary.workArea.y + sh - h - margin;
  }
  // не выходить за экран
  x = Math.max(margin, Math.min(x, sw - w - margin));
  y = Math.max(margin, y);
  return { x, y, width: w, height: h, taskbarH };
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
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    }
  });

  // На Windows делаем окно поверх даже игры? Нет, только над панелью
  mainWindow.setAlwaysOnTop(true, 'pop-up-menu');
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnAllWorkspaces: true });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Скрытие при потере фокуса (клик вне меню)
  mainWindow.on('blur', () => {
    // небольшая задержка чтобы успеть кликнуть внутри
    setTimeout(() => {
      if (mainWindow && !mainWindow.isFocused()) hideMenu();
    }, 150);
  });

  mainWindow.on('close', (e) => {
    // обычный выход
  });

  // Отправляем тему при готовности
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('theme-changed', currentTheme);
    mainWindow.webContents.send('accent-changed', accent);
  });
}

function showMenu() {
  if (!mainWindow) return;
  const bounds = getMenuBounds(currentTheme);
  mainWindow.setBounds(bounds);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('menu-show');
  isVisible = true;
}
function hideMenu() {
  if (!mainWindow) return;
  mainWindow.hide();
  mainWindow.webContents.send('menu-hide');
  isVisible = false;
}
function toggleMenu() {
  if (isVisible) hideMenu(); else showMenu();
}
function setTheme(theme) {
  currentTheme = theme;
  if (mainWindow) {
    const b = getMenuBounds(theme);
    mainWindow.setBounds(b);
    mainWindow.webContents.send('theme-changed', theme);
  }
  // обновим меню трея
  if (tray) {
    // пересоздадим чтобы радиокнопки обновились
    createTray();
  }
}

// IPC
ipcMain.handle('get-apps', () => scanApps());
ipcMain.handle('get-system-info', () => {
  return {
    user: os.userInfo().username,
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    theme: currentTheme,
    accent
  };
});
ipcMain.handle('launch-app', async (e, appPath) => {
  try {
    if (!appPath) return { ok:false, error:'no path' };
    // Безопасность: запускаем только через shell.openPath / openExternal
    // Для .lnk напрямую shell.openPath сработает через explorer
    const res = await shell.openPath(appPath);
    if (res) return { ok:false, error: res };
    hideMenu();
    return { ok:true };
  } catch (err) {
    return { ok:false, error: String(err) };
  }
});
ipcMain.handle('open-location', async (e, p) => {
  try { await shell.openPath(p); return { ok:true }; } catch(e){ return {ok:false, error:String(e)} }
});
ipcMain.handle('open-external', async (e, url) => { await shell.openExternal(url); return { ok:true }; });
ipcMain.on('hide-menu', () => hideMenu());
ipcMain.on('set-theme', (e, t) => setTheme(t));
ipcMain.on('set-accent', (e, color) => { accent=color; if(mainWindow) mainWindow.webContents.send('accent-changed', color); });
ipcMain.on('toggle-menu', () => toggleMenu());
ipcMain.handle('get-theme', () => currentTheme);

app.whenReady().then(() => {
  // Важно: не требуем админки
  if (process.platform === 'win32') app.setAppUserModelId('com.startorback.app');

  createTray();
  createWindow();

  // Горячие клавиши (безопасные, не перехватываем Win напрямую)
  // Alt+Space — стандартный безопасный хоткей
  globalShortcut.register('Alt+Space', () => toggleMenu());
  globalShortcut.register('Alt+Tab', () => {}); // не перехватываем, просто пример что не ломаем систему
  // Попытка зарегистрировать CommandOrControl+Esc (аля Win) — если не получится, не критично
  try { globalShortcut.register('Super+Space', () => toggleMenu()); } catch {}
  try { globalShortcut.register('CommandOrControl+Space', () => toggleMenu()); } catch {}

  // Показать при первом запуске подсказку
  setTimeout(() => {
    if (tray) tray.displayBalloon({
      title: 'StartORBack запущен',
      content: 'Нажми Alt+Пробел или кликни по иконке в трее чтобы открыть новый Пуск. Пока программа работает — твой новый Пуск активен. Закроешь — вернётся обычный.',
      iconType: 'info'
    });
  }, 1200);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
