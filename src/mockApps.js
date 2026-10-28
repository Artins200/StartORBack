/**
 * Мок приложений для превью в браузере и на не-Windows системах
 */
module.exports = function mockApps() {
  const now = Date.now();
  // иконки — эмодзи как замена реальным иконкам
  return [
    { name: 'Visual Studio Code', path: 'C:\\Program Files\\VS Code\\Code.exe', type: 'lnk', icon: '💻', category: 'Разработка', pinned: true },
    { name: 'Google Chrome', path: 'C:\\Program Files\\Chrome\\chrome.exe', type: 'lnk', icon: '🌐', category: 'Интернет', pinned: true },
    { name: 'Telegram', path: 'C:\\Users\\User\\AppData\\Telegram\\Telegram.exe', type: 'lnk', icon: '✈️', category: 'Мессенджеры', pinned: true },
    { name: 'Spotify', path: 'C:\\Users\\User\\AppData\\Spotify\\Spotify.exe', type: 'lnk', icon: '🎵', category: 'Музыка', pinned: true },
    { name: 'Steam', path: 'C:\\Program Files\\Steam\\steam.exe', type: 'lnk', icon: '🎮', category: 'Игры', pinned: true },
    { name: 'Adobe Photoshop', path: 'C:\\Program Files\\Adobe\\Photoshop.exe', type: 'lnk', icon: '🎨', category: 'Графика', pinned: false },
    { name: 'Figma', path: 'C:\\Users\\User\\AppData\\Figma\\Figma.exe', type: 'lnk', icon: '🧩', category: 'Дизайн', pinned: true },
    { name: 'Microsoft Word', path: 'C:\\Program Files\\Office\\WINWORD.EXE', type: 'lnk', icon: '📄', category: 'Офис', pinned: false },
    { name: 'Microsoft Excel', path: 'C:\\Program Files\\Office\\EXCEL.EXE', type: 'lnk', icon: '📊', category: 'Офис', pinned: false },
    { name: 'PowerShell', path: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', type: 'exe', icon: '⌘', category: 'Система', pinned: false },
    { name: 'Проводник', path: 'C:\\Windows\\explorer.exe', type: 'exe', icon: '📁', category: 'Система', pinned: true },
    { name: 'Параметры', path: 'ms-settings:', type: 'url', icon: '⚙️', category: 'Система', pinned: true },
    { name: 'Диспетчер задач', path: 'C:\\Windows\\System32\\Taskmgr.exe', type: 'exe', icon: '📈', category: 'Система', pinned: false },
    { name: 'Калькулятор', path: 'C:\\Windows\\System32\\calc.exe', type: 'exe', icon: '🧮', category: 'Стандартные', pinned: false },
    { name: 'Блокнот', path: 'C:\\Windows\\notepad.exe', type: 'exe', icon: '📝', category: 'Стандартные', pinned: false },
    { name: 'Paint', path: 'C:\\Windows\\System32\\mspaint.exe', type: 'exe', icon: '🖌️', category: 'Стандартные', pinned: false },
    { name: 'Discord', path: 'C:\\Users\\User\\AppData\\Discord\\Discord.exe', type: 'lnk', icon: '💬', category: 'Мессенджеры', pinned: false },
    { name: 'OBS Studio', path: 'C:\\Program Files\\obs-studio\\obs64.exe', type: 'lnk', icon: '🎥', category: 'Видео', pinned: false },
    { name: 'VLC media player', path: 'C:\\Program Files\\VideoLAN\\vlc.exe', type: 'lnk', icon: '▶️', category: 'Видео', pinned: false },
    { name: 'GitHub Desktop', path: 'C:\\Users\\User\\AppData\\GitHub Desktop\\GitHubDesktop.exe', type: 'lnk', icon: '🐙', category: 'Разработка', pinned: false },
    { name: 'Docker Desktop', path: 'C:\\Program Files\\Docker\\Docker Desktop.exe', type: 'lnk', icon: '🐳', category: 'Разработка', pinned: false },
    { name: 'Командная строка', path: 'C:\\Windows\\System32\\cmd.exe', type: 'exe', icon: '>_', category: 'Система', pinned: false },
    { name: 'Ножницы', path: 'C:\\Windows\\System32\\SnippingTool.exe', type: 'exe', icon: '✂️', category: 'Стандартные', pinned: false },
    { name: 'Погода', path: 'ms-weather:', type: 'url', icon: '⛅', category: 'Стандартные', pinned: false },
    // Недавние (для демонстрации сортировки)
    { name: 'Недавний проект — StartORBack', path: 'C:\\Projects\\StartORBack', type: 'lnk', icon: '🚀', category: 'Недавние', recent: true, mtime: now - 1000*60*10 },
    { name: 'Отчёт Q4.pdf', path: 'C:\\Users\\User\\Documents\\report.pdf', type: 'lnk', icon: '📑', category: 'Недавние', recent: true, mtime: now - 1000*60*60 },
    { name: 'Скриншот 28.10.png', path: 'C:\\Users\\User\\Pictures\\screenshot.png', type: 'lnk', icon: '🖼️', category: 'Недавние', recent: true, mtime: now - 1000*60*120 },
  ];
}
