/**
 * StartORBack — Renderer
 * Работает и в Electron (через window.StartORBack) и в браузере (мок)
 */
const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

let apps = [];
let recent = [];
let filtered = [];
let currentTheme = localStorage.getItem('startorback:theme') || 'win11';
let accent = localStorage.getItem('startorback:accent') || '#0078d4';
let isElectron = !!(window.StartORBack && window.StartORBack.isElectron);

// DOM
const startMenu = $('#startMenu');
const pinnedGrid = $('#pinnedGrid');
const recentList = $('#recentList');
const appsList = $('#appsList');
const alphaNav = $('#alphaNav');
const searchInput = $('#searchInput');
const searchClear = $('#searchClear');
const searchWrap = searchInput.closest('.search-wrap');
const allAppsSection = $('#allAppsSection');
const themePicker = $('#themePicker');
const settingsPanel = $('#settingsPanel');
const backdrop = $('#backdrop');
const toastEl = $('#toast');
const previewBanner = $('#preview-banner');
const taskbarStart = $('#taskbar-start');

function toast(msg, ms=2200){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=> toastEl.classList.remove('show'), ms);
}

function setAccent(c){
  accent = c;
  document.documentElement.style.setProperty('--accent', c);
  localStorage.setItem('startorback:accent', c);
  $$('.accent-dot').forEach(b=> b.classList.toggle('active', b.dataset.color===c));
  $('#accentCustom').value = c;
  if (isElectron) window.StartORBack.setAccent(c);
}

function setTheme(t){
  currentTheme = t;
  document.body.className = document.body.className.replace(/theme-\w+/g,'').trim() + ' theme-' + t;
  document.body.classList.toggle('is-electron', isElectron);
  localStorage.setItem('startorback:theme', t);
  $$('.theme-card').forEach(c=> c.classList.toggle('active', c.dataset.theme===t));
  // Обновим Taskbar mock
  if (!isElectron){
    // позиционирование меню в зависимости от темы
    if (t==='win11'){
      startMenu.style.left = '50%';
      startMenu.style.right = 'auto';
      startMenu.style.transform = 'translateX(-50%)';
      startMenu.style.bottom = 'calc(var(--taskbar-h) + 14px)';
    } else {
      startMenu.style.left = '12px';
      startMenu.style.right = 'auto';
      startMenu.style.transform = 'none';
      startMenu.style.bottom = 'calc(var(--taskbar-h) + 12px)';
    }
  }
  if (isElectron) window.StartORBack.setTheme(t);
}

function formatTime(d=new Date()){
  return d.toLocaleTimeString('ru-RU', {hour:'2-digit', minute:'2-digit', second:'2-digit'});
}
function tickClock(){
  const now = new Date();
  const el = $('#liveClock');
  if (el) el.textContent = formatTime(now);
  const tc = $('#taskbar-clock'); if (tc) tc.textContent = now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const td = $('#taskbar-date'); if (td) td.textContent = now.toLocaleDateString('ru-RU',{day:'numeric', month:'short'});
}
setInterval(tickClock, 1000); tickClock();

async function loadApps(){
  if (isElectron){
    try{
      apps = await window.StartORBack.getApps();
      // обогащаем иконками если их нет
      const icons = ['💻','🌐','📁','🎮','🎵','🎨','🧩','📄','📊','⌘','📁','⚙️','📈','🧮','📝','🖌️','💬','🎥','▶️','🐙','🐳','>_','✂️','⛅','🚀','📑','🖼️'];
      apps.forEach((a,i)=> { if(!a.icon) a.icon = icons[i%icons.length]; if(a.pinned===undefined) a.pinned = i<8; });
    }catch(e){ apps = mockFallback(); }
    try{
      const info = await window.StartORBack.getSystemInfo();
      $('#userName').textContent = info.user || 'Пользователь';
      $('#footerUserName').textContent = info.user || 'Пользователь';
      $('#aboutUser').textContent = info.user || '—';
      $('#aboutPlatform').textContent = info.platform + ' ' + info.release;
    }catch{}
  } else {
    // browser: fetch mock via /api/apps
    try{
      const res = await fetch('/api/apps');
      apps = await res.json();
    }catch{
      apps = mockFallback();
    }
    // добавляем мок пользователя
    $('#aboutPlatform').textContent = 'browser preview';
    $('#aboutUser').textContent = 'Гость (превью)';
  }
  // разделим на pinned / recent / все
  recent = apps.filter(a=> a.recent).sort((a,b)=> (b.mtime||0)-(a.mtime||0)).slice(0,3);
  if (recent.length===0) recent = apps.slice(0,3); // демо
  filtered = apps;
  render();
}

function mockFallback(){
  // тот же мок что в src/mockApps, продублирован для браузера без сервера
  return [
    { name: 'Visual Studio Code', path: 'C:\\VSCode\\Code.exe', icon: '💻', category:'Разработка', pinned:true },
    { name: 'Google Chrome', path: 'C:\\Chrome\\chrome.exe', icon: '🌐', category:'Интернет', pinned:true },
    { name: 'Telegram', icon: '✈️', category:'Мессенджеры', pinned:true },
    { name: 'Spotify', icon: '🎵', pinned:true },
    { name: 'Steam', icon: '🎮', pinned:true },
    { name: 'Figma', icon: '🧩', pinned:true },
    { name: 'Проводник', icon: '📁', pinned:true },
    { name: 'Параметры', icon: '⚙️', pinned:true },
    { name: 'Adobe Photoshop', icon: '🎨', category:'Графика' },
    { name: 'Microsoft Word', icon: '📄', category:'Офис' },
    { name: 'Калькулятор', icon: '🧮', category:'Стандартные' },
    { name: 'Блокнот', icon: '📝' },
    { name: 'Discord', icon: '💬' },
    { name: 'VLC', icon: '▶️' },
    { name: 'PowerShell', icon: '⌘', category:'Система' },
    { name: 'Недавний проект — StartORBack', icon:'🚀', recent:true, mtime: Date.now()-600000 },
    { name: 'Отчёт Q4.pdf', icon:'📑', recent:true, mtime: Date.now()-3600000 },
    { name: 'Скриншот 28.10.png', icon:'🖼️', recent:true, mtime: Date.now()-7200000 },
  ];
}

function render(){
  renderPinned();
  renderRecent();
  renderAppsList();
  renderAlpha();
}

function renderPinned(){
  const q = searchInput.value.trim().toLowerCase();
  let list = apps.filter(a=> a.pinned);
  if (q) list = apps.filter(a=> a.name.toLowerCase().includes(q));
  if (!q && list.length===0) list = apps.slice(0,12);
  pinnedGrid.innerHTML = list.slice(0, 18).map(a=> `
    <button class="app-card ${a.pinned?'pinned':''}" data-path="${a.path||''}" data-name="${a.name}">
      <span class="app-icon">${a.icon||'📦'}</span>
      <span class="app-name">${a.name}</span>
    </button>
  `).join('') || `<div style="grid-column:1/-1; text-align:center; color:var(--muted); padding:16px">Ничего не найдено</div>`;
  pinnedGrid.querySelectorAll('.app-card').forEach(btn=>{
    btn.addEventListener('click', ()=> launchApp(btn.dataset.path, btn.dataset.name));
    btn.addEventListener('contextmenu', (e)=>{ e.preventDefault(); showContextMenu(e, btn.dataset.name); });
  });
}

function renderRecent(){
  recentList.innerHTML = recent.map(a=> `
    <div class="recent-item" data-path="${a.path||''}" data-name="${a.name}">
      <span class="r-icon">${a.icon||'📄'}</span>
      <div class="r-text">
        <div class="r-title">${a.name}</div>
        <div class="r-sub">${a.category||'Недавние'} · ${a.mtime? timeAgo(a.mtime) : 'сегодня'}</div>
      </div>
      <span style="font-size:12px; opacity:.5">↗</span>
    </div>
  `).join('');
  recentList.querySelectorAll('.recent-item').forEach(el=>{
    el.addEventListener('click', ()=> launchApp(el.dataset.path, el.dataset.name));
  });
}

function timeAgo(ms){
  const diff = Date.now()-ms;
  const m = Math.floor(diff/60000);
  if (m<60) return m<=1? 'только что' : `${m} мин назад`;
  const h = Math.floor(m/60); if (h<24) return `${h} ч назад`;
  return `${Math.floor(h/24)} дн назад`;
}

function renderAppsList(){
  const q = searchInput.value.trim().toLowerCase();
  let list = q ? apps.filter(a=> a.name.toLowerCase().includes(q)) : apps;
  list = [...list].sort((a,b)=> a.name.localeCompare(b.name,'ru'));
  // группировка по буквам
  const groups = {};
  for (const a of list){
    const letter = a.name[0].toUpperCase();
    const key = /[A-ZА-ЯЁ]/.test(letter) ? letter : '#';
    (groups[key] ||= []).push(a);
  }
  const letters = Object.keys(groups).sort((a,b)=> a.localeCompare(b,'ru'));
  appsList.innerHTML = letters.map(letter=> `
    <div class="group" data-letter="${letter}">
      <div class="group-title">${letter}</div>
      ${groups[letter].map(a=> `
        <div class="app-row" data-path="${a.path||''}" data-name="${a.name}">
          <span class="row-icon">${a.icon||'📦'}</span>
          <span class="row-name">${a.name}</span>
          <span class="row-action">Открыть</span>
        </div>
      `).join('')}
    </div>
  `).join('') || `<div style="text-align:center; color:var(--muted); padding:20px">Ничего не найдено по запросу «${escapeHtml(q)}»</div>`;
  appsList.querySelectorAll('.app-row').forEach(el=>{
    el.addEventListener('click', ()=> launchApp(el.dataset.path, el.dataset.name));
  });
  // показать секцию All Apps при поиске
  if (q){
    allAppsSection.classList.remove('hidden');
    $('.pane-main .section:not(.all-apps-section)')?.classList.add('hidden-search');
    // скрываем pinned/recommended визуально
    $$('.pane-main .section').forEach(s=>{ if(!s.classList.contains('all-apps-section')) s.style.display='none'; });
  } else {
    if (allAppsSection.dataset.forced!=='true'){
      allAppsSection.classList.add('hidden');
      $$('.pane-main .section').forEach(s=> s.style.display='');
    }
  }
}

function renderAlpha(){
  const letters = 'АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  // оставим только те что есть
  const existing = new Set(apps.map(a=> a.name[0].toUpperCase()));
  alphaNav.innerHTML = letters.map(l=> `
    <button class="${existing.has(l)?'':'off'}" data-letter="${l}" ${existing.has(l)?'':'disabled style="opacity:.25"'}>${l}</button>
  `).join('');
  alphaNav.querySelectorAll('button').forEach(b=>{
    b.addEventListener('click', ()=>{
      const letter = b.dataset.letter;
      const target = appsList.querySelector(`[data-letter="${letter}"]`);
      if (target) target.scrollIntoView({behavior:'smooth', block:'start'});
      alphaNav.querySelectorAll('button').forEach(x=> x.classList.remove('active'));
      b.classList.add('active');
    });
  });
}

function escapeHtml(s){ return s.replace(/[&<>"]/g, c=> ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

async function launchApp(p, name){
  if (isElectron && p){
    const res = await window.StartORBack.launchApp(p);
    if (!res.ok) toast('Не удалось запустить: ' + (res.error||'неизвестно'), 2500);
    else toast(`Запуск ${name}…`);
  } else {
    // в превью — просто тост
    toast(`В Windows здесь запустится: ${name}`, 2200);
    // также откроем настройки как демо если это параметры
    if (name.includes('Параметры')) openSettings();
  }
}

function showContextMenu(e, name){
  // простой тост вместо меню
  toast(`ПКМ по ${name} — в полной версии: закрепить, удалить, открыть расположение`);
}

// Search
searchInput.addEventListener('input', ()=>{
  const v = searchInput.value;
  searchWrap.classList.toggle('has-value', v.length>0);
  renderPinned();
  renderRecent();
  renderAppsList();
});
searchClear.addEventListener('click', ()=>{
  searchInput.value='';
  searchWrap.classList.remove('has-value');
  renderAppsList(); renderPinned();
  searchInput.focus();
});
searchInput.addEventListener('keydown', (e)=>{
  if (e.key==='Escape'){
    if (searchInput.value){ searchInput.value=''; searchWrap.classList.remove('has-value'); renderPinned(); renderAppsList(); }
    else hideMenu();
  }
  if (e.key==='Enter'){
    const first = pinnedGrid.querySelector('.app-card') || appsList.querySelector('.app-row');
    if (first) first.click();
  }
});
document.addEventListener('keydown', (e)=>{
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if (e.key==='Escape'){ if (settingsPanel.classList.contains('open')) closeSettings(); else if(!isElectron || searchInput.value) {} else window.StartORBack?.hideMenu(); }
  if (e.altKey && e.code==='Space'){ e.preventDefault(); togglePreviewMenu(); }
});

// Theme picker
themePicker.addEventListener('click', (e)=>{
  const card = e.target.closest('.theme-card');
  if (!card) return;
  setTheme(card.dataset.theme);
  toast(`Тема: ${card.querySelector('span').textContent.split('\n')[0].trim()}`);
});

// Accent
$$('.accent-dot').forEach(b=>{
  b.addEventListener('click', ()=> setAccent(b.dataset.color));
});
$('#accentCustom').addEventListener('input', (e)=> setAccent(e.target.value));

// Toggles
$('#toggleBlur').addEventListener('change', (e)=>{
  document.body.classList.toggle('no-blur', !e.target.checked);
  localStorage.setItem('startorback:blur', e.target.checked?'1':'0');
});
$('#opacityRange').addEventListener('input', (e)=>{
  const v = e.target.value;
  $('#opacityVal').textContent = v+'%';
  document.documentElement.style.setProperty('--opacity', v/100);
  localStorage.setItem('startorback:opacity', v);
});
$('#toggleAnim').addEventListener('change', (e)=>{
  startMenu.classList.toggle('no-anim', !e.target.checked);
  localStorage.setItem('startorback:anim', e.target.checked?'1':'0');
});

// Settings open/close
function openSettings(){ settingsPanel.classList.add('open'); backdrop.classList.add('show'); }
function closeSettings(){ settingsPanel.classList.remove('open'); backdrop.classList.remove('show'); }
$('#btn-settings').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
backdrop.addEventListener('click', closeSettings);
$$('.footer-btn')[1]?.addEventListener('click', openSettings); // второй — параметры

// Side nav demo
$('#sideNav').addEventListener('click', (e)=>{
  const a = e.target.closest('a'); if(!a) return; e.preventDefault();
  toast(`Папка «${a.textContent.trim()}» — в Windows откроется проводник`);
});
$('#sideTiles').addEventListener('click', (e)=>{
  const t = e.target.closest('.tile'); if(!t) return; toast('Плитка — живой виджет (демо)');
});

// All apps navigation
$$('[data-action="all-apps"]').forEach(b=> b.addEventListener('click', ()=>{
  allAppsSection.classList.remove('hidden'); allAppsSection.dataset.forced='true';
  $$('.pane-main .section').forEach(s=>{ if(!s.classList.contains('all-apps-section')) s.style.display='none'; });
  allAppsSection.scrollIntoView({behavior:'smooth'});
}));
$('#btn-back-pinned').addEventListener('click', ()=>{
  allAppsSection.classList.add('hidden'); allAppsSection.dataset.forced='';
  $$('.pane-main .section').forEach(s=> s.style.display='');
  searchInput.value=''; searchWrap.classList.remove('has-value'); renderPinned(); renderRecent();
});
$('#btn-more-recent').addEventListener('click', ()=> toast('Здесь был бы список недавних файлов из проводника'));

// Power
$('#btn-power, .footer-btn.power').addEventListener('click', (e)=>{
  e.preventDefault();
  if(confirm('StartORBack не управляет питанием системы — это безопасный оверлей.\n\nХочешь выйти из программы (вернуть обычный Пуск)?')) {
    if(isElectron) window.StartORBack?.openExternal?.('ms-settings:') || closeSettings();
    else toast('В Windows здесь было бы меню: завершение работы, перезагрузка, сон');
  }
});

// About links
$$('[data-link]').forEach(a=>{
  a.addEventListener('click', (e)=>{
    e.preventDefault();
    const k = a.dataset.link;
    if(k==='github') isElectron? window.StartORBack.openExternal('https://github.com/Artins200/StartORBack') : window.open('https://github.com/Artins200/StartORBack','_blank');
    if(k==='readme') toast('Установи: git clone → npm install → npm start (Windows + Electron)');
    if(k==='exit') { if(isElectron) window.close(); else toast('В Electron здесь выход из приложения'); }
  });
});

// Preview banner hide
if (previewBanner){
  $('#banner-hide')?.addEventListener('click', (e)=>{ e.preventDefault(); previewBanner.classList.add('hidden'); localStorage.setItem('startorback:hideBanner','1'); });
  if(localStorage.getItem('startorback:hideBanner')==='1') previewBanner.classList.add('hidden');
}

// Taskbar start toggle (для превью)
let menuVisible = true;
function togglePreviewMenu(){
  menuVisible = !menuVisible;
  if (menuVisible){
    startMenu.style.display='flex'; startMenu.style.animation='slideUp .24s'; taskbarStart.classList.add('active');
  } else { startMenu.style.display='none'; taskbarStart.classList.remove('active'); }
}
function hideMenu(){ if(!isElectron){ menuVisible=false; startMenu.style.display='none'; taskbarStart.classList.remove('active'); } }
taskbarStart.addEventListener('click', togglePreviewMenu);

// Electron events
if (isElectron){
  document.body.classList.add('is-electron');
  window.StartORBack.onThemeChanged(t=> setTheme(t));
  window.StartORBack.onAccentChanged(c=> setAccent(c));
  window.StartORBack.onMenuShow(()=>{ menuVisible=true; startMenu.style.display='flex'; searchInput.focus(); });
  window.StartORBack.onMenuHide(()=>{ menuVisible=false; startMenu.style.display='none'; });
  // начальная тема с main
  window.StartORBack.getTheme().then(t=> setTheme(t));
}

// Init
// восстановить настройки
(() => {
  const blur = localStorage.getItem('startorback:blur'); if(blur==='0') { $('#toggleBlur').checked=false; document.body.classList.add('no-blur'); }
  const op = localStorage.getItem('startorback:opacity'); if(op){ $('#opacityRange').value=op; $('#opacityVal').textContent=op+'%'; document.documentElement.style.setProperty('--opacity', op/100); }
  const anim = localStorage.getItem('startorback:anim'); if(anim==='0') { $('#toggleAnim').checked=false; startMenu.classList.add('no-anim'); }
  setAccent(accent);
  setTheme(currentTheme);
  isElectron = !!(window.StartORBack && window.StartORBack.isElectron);
  document.body.classList.toggle('is-electron', isElectron);
  if (isElectron) {
    // в Electron меню должно быть скрыто по умолчанию до вызова
    // но для первого рендера покажем
  }
})();

loadApps();

// Клик вне меню в превью — скрыть
if (!isElectron){
  document.addEventListener('click', (e)=>{
    if (!startMenu.contains(e.target) && !taskbarStart.contains(e.target) && !settingsPanel.contains(e.target) && menuVisible){
      // не скрываем если клик по настройкам
      if (e.target.closest('.settings-panel') || e.target.closest('.backdrop')) return;
      // оставим меню видимым в превью для демо, но по клику на фон прячем
      if (e.target.classList.contains('stage') || e.target.classList.contains('desktop-mock')) hideMenu();
    }
  });
}
