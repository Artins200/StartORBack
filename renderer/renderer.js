'use strict';
/**
 * StartORBack Renderer — hardened v3
 * Фиксы: 🟢 гигиена, CSS.escape, MutationObserver, dead code
 */

const $ = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const ALLOWED_THEMES = new Set(['win11','win10','win7']);
const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const MAX_NAME_LEN = 120;

// Эти хелперы оставлены только если используются — сейчас рендер через textContent, поэтому оставляем для внешнего API если нужно, но не используем в мертвом коде
function sanitizeName(n){ return String(n||'').slice(0,MAX_NAME_LEN).replace(/[\x00-\x1F\x7F]/g,'').trim(); }
function isValidHex(c){ return typeof c==='string' && HEX_RE.test(c.trim()); }
function isValidTheme(t){ return ALLOWED_THEMES.has(t); }
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=> fn(...a), ms); }; }

const storage = {
  get(k, d=null){ try{ const v=localStorage.getItem(k); return v===null?d:v; }catch{ return d; } },
  set(k,v){ try{ localStorage.setItem(k,v); }catch{} }
};

let apps = [];
let recent = [];
let currentTheme = storage.get('startorback:theme','win11');
if (!isValidTheme(currentTheme)) currentTheme='win11';
let accent = storage.get('startorback:accent','#0078d4');
if (!isValidHex(accent)) accent='#0078d4';
let isElectron = !!(window.StartORBack && window.StartORBack.isElectron);

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
  if (typeof msg!=='string') msg=String(msg);
  msg = msg.slice(0,200);
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastEl._t);
  toastEl._t = setTimeout(()=> toastEl.classList.remove('show'), ms);
}
function setAccent(c){
  if (!isValidHex(c)) return;
  accent = c.toLowerCase();
  document.documentElement.style.setProperty('--accent', accent);
  storage.set('startorback:accent', accent);
  $$('.accent-dot').forEach(b=> b.classList.toggle('active', b.dataset.color && b.dataset.color.toLowerCase()===accent));
  const ac = $('#accentCustom'); if (ac) ac.value = accent;
  if (isElectron) { try{ window.StartORBack.setAccent(accent); }catch{} }
}
function setTheme(t){
  if (!isValidTheme(t)) return;
  currentTheme = t;
  const body = document.body;
  body.className = body.className.replace(/theme-\w+/g,'').trim() + ' theme-' + t;
  body.classList.toggle('is-electron', isElectron);
  storage.set('startorback:theme', t);
  $$('.theme-card').forEach(c=> c.classList.toggle('active', c.dataset.theme===t));
  if (!isElectron){
    if (t==='win11'){ startMenu.style.left='50%'; startMenu.style.right='auto'; startMenu.style.transform='translateX(-50%)'; startMenu.style.bottom='calc(var(--taskbar-h) + 14px)'; }
    else { startMenu.style.left='12px'; startMenu.style.right='auto'; startMenu.style.transform='none'; startMenu.style.bottom='calc(var(--taskbar-h) + 12px)'; }
  }
  if (isElectron) { try{ window.StartORBack.setTheme(t); }catch{} }
}
function tickClock(){
  const now=new Date();
  const el=$('#liveClock'); if(el) el.textContent=now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const tc=$('#taskbar-clock'); if(tc) tc.textContent=now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  const td=$('#taskbar-date'); if(td) td.textContent=now.toLocaleDateString('ru-RU',{day:'numeric',month:'short'});
}
setInterval(tickClock,1000); tickClock();

async function loadApps(){
  try {
    if (isElectron){
      try{
        const raw = await window.StartORBack.getApps();
        if (raw && !Array.isArray(raw) && raw.code === 'rate_limited') { toast('Слишком часто — подожди секунду'); return; }
        if (raw && raw.ok === false) return;
        const icons=['💻','🌐','📁','🎮','🎵','🎨','🧩','📄','📊','⌘','📁','⚙️','📈','🧮','📝','🖌️','💬','🎥','▶️','🐙','🐳','>_','✂️','⛅','🚀','📑','🖼️'];
        apps=(Array.isArray(raw)?raw:[]).map((a,i)=>({
          name: sanitizeName(a.name)||'Без имени',
          path: typeof a.path==='string'? a.path.slice(0,1024):'',
          type: a.type||'lnk',
          icon: a.icon? String(a.icon).slice(0,8): icons[i%icons.length],
          category: a.category? String(a.category).slice(0,32):'',
          pinned: !!a.pinned,
          recent: !!a.recent,
          mtime: a.mtime||a.mtimeMs||null
        })).slice(0,800);
        if (apps.length===0) apps=mockFallback();
        else { apps.forEach((a,i)=>{ if(!a.icon) a.icon=icons[i%icons.length]; if(a.pinned===undefined) a.pinned=i<8; }); }
      }catch(e){ apps=mockFallback(); }
      try{
        const info=await window.StartORBack.getSystemInfo();
        if(info && typeof info.user==='string'){
          const u=sanitizeName(info.user);
          $('#userName').textContent=u||'Пользователь';
          $('#footerUserName').textContent=u||'Пользователь';
          $('#aboutUser').textContent=u||'—';
          $('#aboutPlatform').textContent=(String(info.platform).slice(0,32)+' '+String(info.release||'').slice(0,64)).trim();
        }
      }catch{}
    } else {
      try{
        const res=await fetch('/api/apps',{headers:{'Accept':'application/json'}});
        if(!res.ok) throw new Error('fetch failed');
        const raw=await res.json();
        if(!Array.isArray(raw)) throw new Error('invalid');
        apps=raw.map(a=>({name:sanitizeName(a.name), path:String(a.path||'').slice(0,1024), type:a.type||'lnk', icon:String(a.icon||'📦').slice(0,8), category:String(a.category||'').slice(0,32), pinned:!!a.pinned, recent:!!a.recent, mtime:a.mtime||null})).slice(0,800);
      }catch{ apps=mockFallback(); }
      $('#aboutPlatform').textContent='browser preview (hardened v3)';
      $('#aboutUser').textContent='Гость (превью)';
    }
    recent=apps.filter(a=>a.recent).sort((a,b)=> (b.mtime||0)-(a.mtime||0)).slice(0,3);
    if(recent.length===0) recent=apps.slice(0,3);
    render();
  } catch(e){ toast('Ошибка загрузки приложений'); apps=mockFallback(); render(); }
}
function mockFallback(){
  return [
    { name:'Visual Studio Code', path:'C:\\VSCode\\Code.exe', icon:'💻', category:'Разработка', pinned:true },
    { name:'Google Chrome', path:'C:\\Chrome\\chrome.exe', icon:'🌐', pinned:true },
    { name:'Telegram', icon:'✈️', pinned:true },
    { name:'Spotify', icon:'🎵', pinned:true },
    { name:'Steam', icon:'🎮', pinned:true },
    { name:'Figma', icon:'🧩', pinned:true },
    { name:'Проводник', icon:'📁', pinned:true },
    { name:'Параметры', icon:'⚙️', pinned:true },
    { name:'Adobe Photoshop', icon:'🎨' },
    { name:'Microsoft Word', icon:'📄' },
    { name:'Калькулятор', icon:'🧮' },
    { name:'Блокнот', icon:'📝' },
    { name:'Discord', icon:'💬' },
    { name:'VLC', icon:'▶️' },
    { name:'PowerShell', icon:'⌘' },
    { name:'Недавний проект — StartORBack', icon:'🚀', recent:true, mtime:Date.now()-600000 },
    { name:'Отчёт Q4.pdf', icon:'📑', recent:true, mtime:Date.now()-3600000 },
    { name:'Скриншот 28.10.png', icon:'🖼️', recent:true, mtime:Date.now()-7200000 },
  ];
}
function render(){ renderPinned(); renderRecent(); renderAppsList(); renderAlpha(); }

function renderPinned(){
  const q=searchInput.value.trim().toLowerCase().slice(0,80);
  let list=apps.filter(a=>a.pinned);
  if(q) list=apps.filter(a=> a.name.toLowerCase().includes(q));
  if(!q && list.length===0) list=apps.slice(0,12);
  list=list.slice(0,18);
  pinnedGrid.innerHTML='';
  if(list.length===0){
    const d=document.createElement('div'); d.style.cssText='grid-column:1/-1;text-align:center;color:var(--muted);padding:16px'; d.textContent='Ничего не найдено'; pinnedGrid.appendChild(d); return;
  }
  const frag=document.createDocumentFragment();
  for(const a of list){
    const btn=document.createElement('button'); btn.type='button'; btn.className='app-card'+(a.pinned?' pinned':''); btn.dataset.path=a.path||''; btn.dataset.name=a.name; btn.setAttribute('role','listitem'); btn.setAttribute('aria-label', a.name);
    const icon=document.createElement('span'); icon.className='app-icon'; icon.textContent=a.icon||'📦';
    const name=document.createElement('span'); name.className='app-name'; name.textContent=a.name;
    btn.appendChild(icon); btn.appendChild(name); frag.appendChild(btn);
  }
  pinnedGrid.appendChild(frag);
}
function renderRecent(){
  recentList.innerHTML=''; const frag=document.createDocumentFragment();
  for(const a of recent){
    const row=document.createElement('div'); row.className='recent-item'; row.dataset.path=a.path||''; row.dataset.name=a.name; row.setAttribute('role','listitem');
    const ic=document.createElement('span'); ic.className='r-icon'; ic.textContent=a.icon||'📄';
    const txt=document.createElement('div'); txt.className='r-text';
    const title=document.createElement('div'); title.className='r-title'; title.textContent=a.name;
    const sub=document.createElement('div'); sub.className='r-sub'; sub.textContent=(a.category||'Недавние')+' · '+(a.mtime? timeAgo(a.mtime):'сегодня');
    txt.appendChild(title); txt.appendChild(sub);
    const arrow=document.createElement('span'); arrow.style.cssText='font-size:12px;opacity:.5'; arrow.textContent='↗';
    row.appendChild(ic); row.appendChild(txt); row.appendChild(arrow); frag.appendChild(row);
  }
  recentList.appendChild(frag);
}
function timeAgo(ms){
  const diff=Date.now()-ms; const m=Math.floor(diff/60000);
  if(m<60) return m<=1?'только что':`${m} мин назад`;
  const h=Math.floor(m/60); if(h<24) return `${h} ч назад`;
  return `${Math.floor(h/24)} дн назад`;
}
function renderAppsList(){
  const q=searchInput.value.trim().toLowerCase().slice(0,80);
  let list=q? apps.filter(a=> a.name.toLowerCase().includes(q)): apps;
  list=[...list].sort((a,b)=> a.name.localeCompare(b.name,'ru',{sensitivity:'base',numeric:true}));
  const LIMIT_INITIAL=120; const groups={};
  for(const a of list){ const first=(a.name[0]||'#').toUpperCase(); const key=/[A-ZА-ЯЁ]/.test(first)? first:'#'; (groups[key]||(groups[key]=[])).push(a); }
  const letters=Object.keys(groups).sort((a,b)=> a.localeCompare(b,'ru'));
  appsList.innerHTML='';
  if(letters.length===0){
    const d=document.createElement('div'); d.style.cssText='text-align:center;color:var(--muted);padding:20px'; d.textContent='Ничего не найдено по запросу «'+q+'»'; appsList.appendChild(d);
  } else {
    const frag=document.createDocumentFragment(); let rendered=0; const deferred=[];
    for(const letter of letters){
      const group=document.createElement('div'); group.className='group'; group.dataset.letter=letter;
      const title=document.createElement('div'); title.className='group-title'; title.textContent=letter; group.appendChild(title);
      const items=groups[letter];
      for(const a of items){
        if(rendered < LIMIT_INITIAL){
          const row=document.createElement('div'); row.className='app-row'; row.dataset.path=a.path||''; row.dataset.name=a.name; row.setAttribute('role','listitem');
          const ic=document.createElement('span'); ic.className='row-icon'; ic.textContent=a.icon||'📦';
          const name=document.createElement('span'); name.className='row-name'; name.textContent=a.name;
          const act=document.createElement('span'); act.className='row-action'; act.textContent='Открыть';
          row.appendChild(ic); row.appendChild(name); row.appendChild(act); group.appendChild(row); rendered++;
        } else { deferred.push({group, a}); }
      }
      frag.appendChild(group);
    }
    appsList.appendChild(frag);
    if(deferred.length){
      const sentinel=document.createElement('div'); sentinel.textContent='Показать ещё '+deferred.length+' приложений'; sentinel.style.cssText='text-align:center;color:var(--accent);padding:10px;cursor:pointer;font-size:13px'; sentinel.setAttribute('role','button'); sentinel.tabIndex=0;
      const loadMore=()=>{
        const batch=deferred.splice(0,60);
        for(const {group,a} of batch){
          const row=document.createElement('div'); row.className='app-row'; row.dataset.path=a.path||''; row.dataset.name=a.name;
          const ic=document.createElement('span'); ic.className='row-icon'; ic.textContent=a.icon||'📦';
          const name=document.createElement('span'); name.className='row-name'; name.textContent=a.name;
          const act=document.createElement('span'); act.className='row-action'; act.textContent='Открыть';
          row.appendChild(ic); row.appendChild(name); row.appendChild(act); group.appendChild(row);
        }
        if(deferred.length===0) sentinel.remove(); else sentinel.textContent='Показать ещё '+deferred.length+' приложений';
      };
      sentinel.addEventListener('click', loadMore);
      sentinel.addEventListener('keydown', (e)=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); loadMore(); }});
      appsList.appendChild(sentinel);
      if('IntersectionObserver' in window){
        const io=new IntersectionObserver((entries)=>{ if(entries[0].isIntersecting){ loadMore(); if(deferred.length===0) io.disconnect(); } }, { root: appsList, threshold: 0.1 }); io.observe(sentinel);
      }
    }
  }
  if(q){ allAppsSection.classList.remove('hidden'); $$('.pane-main .section').forEach(s=>{ if(!s.classList.contains('all-apps-section')) s.style.display='none'; }); }
  else { if(allAppsSection.dataset.forced!=='true'){ allAppsSection.classList.add('hidden'); $$('.pane-main .section').forEach(s=> s.style.display=''); } }
}
function renderAlpha(){
  const letters='АБВГДЕЖЗИКЛМНОПРСТУФХЦЧШЩЭЮЯ#ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const existing=new Set(apps.map(a=> (a.name[0]||'').toUpperCase()));
  alphaNav.innerHTML=''; const frag=document.createDocumentFragment();
  for(const l of letters){ const btn=document.createElement('button'); btn.type='button'; btn.textContent=l; btn.dataset.letter=l; if(!existing.has(l)){ btn.disabled=true; btn.style.opacity='0.25'; } frag.appendChild(btn); }
  alphaNav.appendChild(frag);
}
pinnedGrid.addEventListener('click', (e)=>{ const btn=e.target.closest('.app-card'); if(!btn) return; launchApp(btn.dataset.path, btn.dataset.name); });
pinnedGrid.addEventListener('contextmenu', (e)=>{ const btn=e.target.closest('.app-card'); if(!btn) return; e.preventDefault(); showContextMenu(e, btn.dataset.name); });
recentList.addEventListener('click', (e)=>{ const row=e.target.closest('.recent-item'); if(!row) return; launchApp(row.dataset.path, row.dataset.name); });
appsList.addEventListener('click', (e)=>{ const row=e.target.closest('.app-row'); if(!row) return; launchApp(row.dataset.path, row.dataset.name); });
// п.🟢 фикс CSS.escape('#') — не используем CSS.escape, ищем перебором
alphaNav.addEventListener('click', (e)=>{
  const b=e.target.closest('button'); if(!b||b.disabled) return;
  const letter=b.dataset.letter;
  // Ищем группу перебором вместо querySelector с CSS.escape
  let target=null;
  for(const g of appsList.querySelectorAll('.group')) if(g.dataset.letter===letter){ target=g; break; }
  if(target) target.scrollIntoView({behavior:'smooth',block:'start'});
  alphaNav.querySelectorAll('button').forEach(x=> x.classList.remove('active')); b.classList.add('active');
});
async function launchApp(p, name){
  const cleanName=sanitizeName(name);
  if(isElectron && p){
    if(typeof p!=='string' || p.length>1024 || p.includes('\0')){ toast('Некорректный путь'); return; }
    try{ const res=await window.StartORBack.launchApp(p); if(!res.ok) toast('Не удалось запустить: '+(res.error||'неизвестно').slice(0,120),2500); else toast('Запуск '+cleanName+'…'); }catch{ toast('Ошибка запуска'); }
  } else { toast('В Windows здесь запустится: '+cleanName,2200); if(cleanName.includes('Параметры')) openSettings(); }
}
function showContextMenu(e,name){ toast('ПКМ по '+sanitizeName(name)+' — закрепить/открыть расположение'); }
const debouncedRender=debounce(()=>{ searchWrap.classList.toggle('has-value', searchInput.value.length>0); renderPinned(); renderAppsList(); },120);
searchInput.addEventListener('input', ()=>{ const v=searchInput.value; if(v.length>80){ searchInput.value=v.slice(0,80); } searchWrap.classList.toggle('has-value', searchInput.value.length>0); debouncedRender(); });
searchClear.addEventListener('click', ()=>{ searchInput.value=''; searchWrap.classList.remove('has-value'); renderPinned(); renderAppsList(); searchInput.focus(); });
searchInput.addEventListener('keydown', (e)=>{
  if(e.key==='Escape'){ if(searchInput.value){ searchInput.value=''; searchWrap.classList.remove('has-value'); renderPinned(); renderAppsList(); } else hideMenu(); }
  if(e.key==='Enter'){ const first=pinnedGrid.querySelector('.app-card')||appsList.querySelector('.app-row'); if(first) first.click(); }
});
document.addEventListener('keydown', (e)=>{
  if((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k'){ e.preventDefault(); searchInput.focus(); searchInput.select(); }
  if(e.key==='Escape'){ if(settingsPanel.classList.contains('open')) closeSettings(); else if(isElectron && !searchInput.value) { try{ window.StartORBack.hideMenu(); }catch{} } }
  if(e.altKey && e.code==='Space'){ e.preventDefault(); togglePreviewMenu(); }
});
themePicker.addEventListener('click', (e)=>{ const card=e.target.closest('.theme-card'); if(!card) return; const t=card.dataset.theme; if(!isValidTheme(t)) return; setTheme(t); toast('Тема: '+ t); });
$$('.accent-dot').forEach(b=>{ b.addEventListener('click', ()=>{ const c=b.dataset.color; if(isValidHex(c)) setAccent(c); }); });
$('#accentCustom').addEventListener('input', (e)=>{ const c=e.target.value; if(isValidHex(c)) setAccent(c); });
$('#toggleBlur').addEventListener('change', (e)=>{ document.body.classList.toggle('no-blur', !e.target.checked); storage.set('startorback:blur', e.target.checked?'1':'0'); });
$('#opacityRange').addEventListener('input', (e)=>{ const v=e.target.value; $('#opacityVal').textContent=v+'%'; document.documentElement.style.setProperty('--opacity', Number(v)/100); storage.set('startorback:opacity', v); });
$('#toggleAnim').addEventListener('change', (e)=>{ startMenu.classList.toggle('no-anim', !e.target.checked); storage.set('startorback:anim', e.target.checked?'1':'0'); });
function openSettings(){ settingsPanel.classList.add('open'); backdrop.classList.add('show'); }
function closeSettings(){ settingsPanel.classList.remove('open'); backdrop.classList.remove('show'); }
$('#btn-settings').addEventListener('click', openSettings);
$('#settingsClose').addEventListener('click', closeSettings);
backdrop.addEventListener('click', closeSettings);
const footerBtns=$$('.footer-btn'); if(footerBtns[1]) footerBtns[1].addEventListener('click', openSettings);
$('#sideNav').addEventListener('click', (e)=>{ const a=e.target.closest('a'); if(!a) return; e.preventDefault(); toast('Папка «'+sanitizeName(a.textContent.trim())+'» — откроется проводник'); });
$('#sideTiles').addEventListener('click', (e)=>{ const t=e.target.closest('.tile'); if(!t) return; toast('Плитка — живой виджет (демо)'); });
$$('[data-action="all-apps"]').forEach(b=> b.addEventListener('click', ()=>{ allAppsSection.classList.remove('hidden'); allAppsSection.dataset.forced='true'; $$('.pane-main .section').forEach(s=>{ if(!s.classList.contains('all-apps-section')) s.style.display='none'; }); allAppsSection.scrollIntoView({behavior:'smooth'}); }));
$('#btn-back-pinned').addEventListener('click', ()=>{ allAppsSection.classList.add('hidden'); allAppsSection.dataset.forced=''; $$('.pane-main .section').forEach(s=> s.style.display=''); searchInput.value=''; searchWrap.classList.remove('has-value'); renderPinned(); renderRecent(); });
$('#btn-more-recent').addEventListener('click', ()=> toast('Список недавних из проводника (демо)'));
const powerBtns=[$('#btn-power'), $$('.footer-btn.power')[0]].filter(Boolean);
powerBtns.forEach(btn=> btn.addEventListener('click', (e)=>{ e.preventDefault(); if(confirm('StartORBack не управляет питанием — это оверлей.\nВыйти из программы?')){ if(isElectron) { try{ window.StartORBack.openExternal('https://github.com/Artins200/StartORBack'); }catch{} closeSettings(); } else toast('В Windows было бы меню питания'); }}));
$$('[data-link]').forEach(a=>{ a.addEventListener('click', (e)=>{ e.preventDefault(); const k=a.dataset.link; if(k==='github') isElectron? window.StartORBack.openExternal('https://github.com/Artins200/StartORBack'): window.open('https://github.com/Artins200/StartORBack','_blank','noopener'); if(k==='readme') toast('git clone → npm install → npm start'); if(k==='exit') { if(isElectron) { try{ window.close(); }catch{} } else toast('В Electron — выход'); } }); });
if(previewBanner){ const hideBtn=$('#banner-hide'); if(hideBtn) hideBtn.addEventListener('click', (e)=>{ e.preventDefault(); previewBanner.classList.add('hidden'); storage.set('startorback:hideBanner','1'); }); if(storage.get('startorback:hideBanner','0')==='1') previewBanner.classList.add('hidden'); }
let menuVisible=true;
function togglePreviewMenu(){ menuVisible=!menuVisible; if(menuVisible){ startMenu.style.display='flex'; startMenu.style.animation='slideUp .24s'; taskbarStart.classList.add('active'); } else { startMenu.style.display='none'; taskbarStart.classList.remove('active'); } }
function hideMenu(){ if(!isElectron){ menuVisible=false; startMenu.style.display='none'; taskbarStart.classList.remove('active'); } }
taskbarStart.addEventListener('click', togglePreviewMenu);
if(isElectron){
  document.body.classList.add('is-electron');
  try{
    const rm1=window.StartORBack.onThemeChanged(t=> setTheme(t));
    const rm2=window.StartORBack.onAccentChanged(c=> setAccent(c));
    const rm3=window.StartORBack.onMenuShow(()=>{ menuVisible=true; startMenu.style.display='flex'; searchInput.focus(); });
    const rm4=window.StartORBack.onMenuHide(()=>{ menuVisible=false; startMenu.style.display='none'; });
    window.addEventListener('beforeunload', ()=>{ try{ rm1(); rm2(); rm3(); rm4(); }catch{} });
    window.StartORBack.getTheme().then(t=> { if(isValidTheme(t)) setTheme(t); });
  }catch{}
}
(() => {
  const blur=storage.get('startorback:blur',null); if(blur==='0'){ const el=$('#toggleBlur'); if(el) el.checked=false; document.body.classList.add('no-blur'); }
  const op=storage.get('startorback:opacity',null); if(op && /^\d+$/.test(op)){ const n=Math.min(100,Math.max(80, parseInt(op,10))); const el=$('#opacityRange'); if(el) el.value=n; const ov=$('#opacityVal'); if(ov) ov.textContent=n+'%'; document.documentElement.style.setProperty('--opacity', n/100); }
  const anim=storage.get('startorback:anim',null); if(anim==='0'){ const el=$('#toggleAnim'); if(el) el.checked=false; startMenu.classList.add('no-anim'); }
  setAccent(accent); setTheme(currentTheme); isElectron=!!(window.StartORBack && window.StartORBack.isElectron); document.body.classList.toggle('is-electron', isElectron);
})();
loadApps();
if(!isElectron){
  document.addEventListener('click', (e)=>{
    if(!startMenu.contains(e.target) && !taskbarStart.contains(e.target) && !settingsPanel.contains(e.target) && menuVisible){
      if(e.target.closest('.settings-panel') || e.target.closest('.backdrop')) return;
      if(e.target.classList.contains('stage') || e.target.classList.contains('desktop-mock')) hideMenu();
    }
  });
}
// п.🟢 удалён мертвый MutationObserver — больше не наблюдаем head
// window.__StartORBackTest удалён — не экспортируем в прод
