'use strict';
// J.A.R.V.I.S. launcher UI: renders the state stream from server.js and sends actions.

const $ = (id) => document.getElementById(id);
const GB = 1024 ** 3;
let state = null;

// ---------------------------------------------------------------- language
// The server serves the page with <html lang="en|ru">; t(ru, en) picks a string for it. Static text in
// index.html is Russian with the English in data-en (data-en-title, data-en-placeholder, … for attributes).
let LANG = document.documentElement.lang === 'ru' ? 'ru' : 'en';
const t = (ru, en) => (LANG === 'en' ? en : ru);
const LOCALE = () => (LANG === 'en' ? 'en-GB' : 'ru-RU');
const dec = (s) => (LANG === 'en' ? String(s) : String(s).replace('.', ','));
const langHooks = []; // rebuilders of UI parts built once (gauges, log tabs, HUD form, catalog …)
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
function applyStatic() {
  document.querySelectorAll('[data-en]').forEach((e) => {
    if (e.dataset.ru == null) e.dataset.ru = e.innerHTML;
    e.innerHTML = LANG === 'en' ? e.dataset.en : e.dataset.ru;
  });
  for (const a of ATTRS) {
    document.querySelectorAll(`[data-en-${a}]`).forEach((e) => {
      const key = 'ru' + a.replace(/(^|-)(\w)/g, (m, d, c) => c.toUpperCase());
      if (e.dataset[key] == null) e.dataset[key] = e.getAttribute(a) || '';
      e.setAttribute(a, LANG === 'en' ? e.getAttribute('data-en-' + a) : e.dataset[key]);
    });
  }
  document.querySelectorAll('[data-lang]').forEach((b) => b.classList.toggle('on', b.dataset.lang === LANG));
}
function setLang(l) {
  if (l === LANG) return;
  LANG = l;
  document.documentElement.lang = l;
  applyStatic();
  document.querySelectorAll('[data-sig]').forEach((e) => { delete e.dataset.sig; });
  for (const h of langHooks) { try { h(); } catch {} }
  tickClock();
  if (state) render(state);
}
document.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => {
  setLang(b.dataset.lang); // instantly here; the server switches the agent, bot and HUD
  post('settings/lang', { lang: b.dataset.lang });
}));
applyStatic();

// ---------------------------------------------------------------- utils
const fmtGB = (b) => dec((b / GB).toFixed(1)) + t(' ГБ', ' GB');
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? t(`${h} ч ${m} мин`, `${h} h ${m} min`) : m ? t(`${m} мин ${String(s).padStart(2, '0')} с`, `${m} min ${String(s).padStart(2, '0')} s`) : t(`${s} с`, `${s} s`);
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
async function post(action, body = {}) {
  try {
    const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1' }, body: JSON.stringify(body) });
    return r.ok;
  } catch { return false; }
}
function confirmBox(title, text, okLabel = t('Да', 'Yes')) {
  return new Promise((resolve) => {
    $('modal-title').textContent = title;
    $('modal-text').textContent = text;
    $('modal-ok').textContent = okLabel;
    $('modal').hidden = false;
    const done = (v) => { $('modal').hidden = true; $('modal-ok').onclick = $('modal-cancel').onclick = null; resolve(v); };
    $('modal-ok').onclick = () => done(true);
    $('modal-cancel').onclick = () => done(false);
  });
}
function setLed(id, kind) { $(id).className = 'led' + (kind ? ' ' + kind : ''); }
function setStatus(id, text, kind) { const e = $(id); e.textContent = text; e.className = 'st-' + kind; }

// ---------------------------------------------------------------- tabs, clock
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-page').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
  try { localStorage.setItem('jarvis-tab', name); } catch {}
  if (name === 'hud') loadHudConfig();
  if (name === 'model' && !recCache && catMode === 'rec') showRecommended();
  if (name === 'system') loadLog();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
document.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => post('tool/open', { what: b.dataset.open })));

function tickClock() {
  const d = new Date();
  $('clock').textContent = d.toLocaleTimeString(LOCALE(), { hour12: false });
  $('date').textContent = d.toLocaleDateString(LOCALE(), { weekday: 'short', day: 'numeric', month: 'long' });
  const h = d.getHours();
  const hello = h < 5 ? t('Доброй ночи', 'Good night') : h < 12 ? t('Доброе утро', 'Good morning') : h < 18 ? t('Добрый день', 'Good afternoon') : t('Добрый вечер', 'Good evening');
  $('greeting').textContent = t(`${hello}, сэр.`, `${hello}, sir.`);
}
setInterval(tickClock, 1000);
tickClock();

// ---------------------------------------------------------------- reactor build
(function buildReactor() {
  const ns = 'http://www.w3.org/2000/svg';
  const ticks = $('ticks');
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, major = i % 6 === 0;
    const r1 = major ? 166 : 170, r2 = 180;
    const l = document.createElementNS(ns, 'line');
    l.setAttribute('x1', (Math.cos(a) * r1).toFixed(1)); l.setAttribute('y1', (Math.sin(a) * r1).toFixed(1));
    l.setAttribute('x2', (Math.cos(a) * r2).toFixed(1)); l.setAttribute('y2', (Math.sin(a) * r2).toFixed(1));
    l.setAttribute('class', 'tick' + (major ? ' major' : ''));
    ticks.appendChild(l);
  }
  const coils = $('coils');
  const n = 10, inner = 100, outer = 142, gap = 0.07;
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 + gap, a1 = ((i + 1) / n) * Math.PI * 2 - gap;
    const p = [[inner, a0], [outer, a0 - 0.02], [outer, a1 + 0.02], [inner, a1]]
      .map(([r, a]) => `${(Math.cos(a) * r).toFixed(1)},${(Math.sin(a) * r).toFixed(1)}`).join(' ');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', p); poly.setAttribute('class', 'coil');
    coils.appendChild(poly);
  }
})();

// ---------------------------------------------------------------- gauges
const GAUGES = () => [['cpu', t('ЦП', 'CPU')], ['ram', t('ОЗУ', 'RAM')], ['vram', 'VRAM'], ['temp', t('ГП °C', 'GPU °C')]];
function buildGauges() {
  const box = $('gauges');
  box.textContent = '';
  for (const [key, label] of GAUGES()) {
    const g = el('div', 'gauge'); g.id = 'g-' + key;
    g.innerHTML = `<svg viewBox="-40 -40 80 80"><circle r="32" class="g-track"/><circle r="32" class="g-val" pathLength="100" stroke-dasharray="0 100"/><text>—</text></svg><div>${label}<small></small></div>`;
    box.appendChild(g);
  }
}
buildGauges();
langHooks.push(buildGauges);
function setGauge(key, pct, text, sub) {
  const g = $('g-' + key);
  const v = Math.max(0, Math.min(100, pct || 0));
  g.querySelector('.g-val').setAttribute('stroke-dasharray', `${v} 100`);
  g.querySelector('text').textContent = text;
  g.querySelector('small').textContent = sub || '';
  g.classList.toggle('warn', v >= 75 && v < 90);
  g.classList.toggle('hot', v >= 90);
}

// ---------------------------------------------------------------- render
function applyAccent(rgb) {
  if (!rgb) return;
  const v = rgb.map((c) => Math.round(c * 255)).join(', ');
  document.documentElement.style.setProperty('--acc', v);
}

function render(s) {
  state = s;
  if (s.lang && s.lang !== LANG) setLang(s.lang); // switched in another window
  applyAccent(s.meta.accent);
  renderAgent(s);
  renderHw(s);
  renderModels(s);
  renderComfy(s);
  renderTelegram(s);
  renderEngines(s);
  renderHud(s);
  renderSys(s);
  renderJournal(s);
  renderReactor(s);
}

function renderAgent(s) {
  const a = s.agent;
  const map = { off: [t('Отключён', 'Offline'), 'off', ''], starting: [t('Запускается…', 'Starting…'), 'busy', 'busy'], on: [t('В сети', 'Online'), 'on', 'on'],
    stopping: [t('Останавливается…', 'Stopping…'), 'busy', 'busy'], error: [t('Сбой', 'Failure'), 'err', 'err'] };
  const [text, kind, led] = map[a.status] || map.off;
  setStatus('agent-status', text, kind);
  setLed('agent-led', led);
  $('agent-uptime').textContent = a.since && a.status !== 'off' && a.status !== 'error' ? fmtDur((Date.now() - a.since) / 1000) : '';
  $('agent-error').hidden = !(a.status === 'error' && a.error);
  $('agent-error').textContent = a.error || '';
  $('agent-start').disabled = ['starting', 'on', 'stopping'].includes(a.status);
  $('agent-open').disabled = a.status !== 'on';
  $('agent-stop').disabled = !['starting', 'on'].includes(a.status);
  $('agent-start').textContent = a.status === 'error' ? t('Повторить запуск', 'Try again') : t('Запустить агента', 'Start agent');
  if (document.activeElement !== $('agent-theme')) $('agent-theme').checked = a.theme;
}

function renderReactor(s) {
  const a = s.agent, m = s.models.active, job = s.models.job;
  const r = $('reactor');
  const mode = a.status === 'on' ? 'online' : ['starting', 'stopping'].includes(a.status) ? 'busy' : a.status === 'error' ? 'alert' : 'idle';
  r.setAttribute('class', 'reactor ' + mode);
  let main, sub;
  if (a.status === 'on') {
    main = t('Все системы в норме', 'All systems nominal');
    sub = a.windowOpen ? t('Агент в сети. Нажмите на реактор, чтобы открыть ещё одно окно.', 'The agent is online. Click the reactor to open another window.')
      : t('Агент в сети. Нажмите на реактор, чтобы открыть окно.', 'The agent is online. Click the reactor to open its window.');
  } else if (a.status === 'starting') { main = t('Инициализация агента', 'Initializing the agent'); sub = t('Поднимаю сервер и модули… ', 'Bringing up the server and modules… ') + fmtDur((Date.now() - a.since) / 1000); }
  else if (a.status === 'stopping') { main = t('Отключение', 'Shutting down'); sub = t('Останавливаю агента…', 'Stopping the agent…'); }
  else if (a.status === 'error') { main = t('Сбой запуска', 'Start failed'); sub = t('Подробности — в панели агента. Нажмите на реактор, чтобы повторить.', 'Details are in the agent panel. Click the reactor to try again.'); }
  else { main = t('Режим ожидания', 'Standby'); sub = t('Нажмите на реактор, чтобы запустить агента DeepSeek Harness.', 'Click the reactor to start the DeepSeek Harness agent.'); }
  $('cap-main').textContent = main;
  $('cap-sub').textContent = sub;
  // Outer arc: download/verify progress, otherwise model loading/ready.
  let pct = 0;
  if (job && job.phase === 'verify') pct = 100 * job.verifyDone / Math.max(1, job.verifyTotal);
  else if (job) pct = 100 * job.done / Math.max(1, job.total);
  else if (m.status === 'on') pct = 100;
  else if (m.status === 'loading') pct = Math.min(95, ((Date.now() - m.since) / 1000 / 90) * 100);
  $('progress-arc').setAttribute('stroke-dasharray', `${pct.toFixed(1)} 100`);
}

function renderSys(s) {
  const sys = s.sys;
  const gb = t('ГБ', 'GB');
  setGauge('cpu', sys.cpu, sys.cpu + '%', '');
  const ramPct = (100 * sys.ramUsed) / sys.ramTotal;
  setGauge('ram', ramPct, Math.round(ramPct) + '%', `${dec((sys.ramUsed / GB).toFixed(1))}/${Math.round(sys.ramTotal / GB)} ${gb}`);
  if (sys.gpu) {
    const v = (100 * sys.gpu.vramUsed) / sys.gpu.vramTotal;
    setGauge('vram', v, Math.round(v) + '%', `${dec((sys.gpu.vramUsed / 1024).toFixed(1))}/${Math.round(sys.gpu.vramTotal / 1024)} ${gb}`);
    // AMD / Intel: Windows' counters give load and memory, no temperature.
    if (sys.gpu.temp == null) setGauge('temp', 0, '—', t(`нагрузка ${sys.gpu.load}%`, `load ${sys.gpu.load}%`));
    else setGauge('temp', sys.gpu.temp, sys.gpu.temp + '°', t(`нагрузка ${sys.gpu.load}%`, `load ${sys.gpu.load}%`));
    $('gpu-name').textContent = sys.gpu.name;
  }
  $('disk-free').textContent = fmtGB(sys.diskFree);
  // System tab.
  $('s-ram').textContent = `${fmtGB(sys.ramUsed)} ${t('из', 'of')} ${fmtGB(sys.ramTotal)}`;
  $('s-ram-bar').style.width = ramPct.toFixed(1) + '%';
  $('s-ram-bar').classList.toggle('warn', ramPct > 85);
  if (sys.gpu) {
    $('s-vram').textContent = `${dec((sys.gpu.vramUsed / 1024).toFixed(1))} ${t('из', 'of')} ${dec((sys.gpu.vramTotal / 1024).toFixed(1))} ${gb}`;
    $('s-vram-bar').style.width = ((100 * sys.gpu.vramUsed) / sys.gpu.vramTotal).toFixed(1) + '%';
  }
  const list = $('s-heavy'); list.textContent = '';
  const max = Math.max(1, ...sys.heavy.map((p) => p.mb));
  for (const p of sys.heavy) {
    const li = el('li');
    const bar = el('div', 'bar'); const i = el('i'); i.style.width = (100 * p.mb / max) + '%'; bar.appendChild(i);
    li.append(el('span', '', p.name), el('b', '', p.mb >= 1024 ? dec((p.mb / 1024).toFixed(1)) + ' ' + gb : p.mb + t(' МБ', ' MB')), bar);
    list.appendChild(li);
  }
  const w = s.win || {};
  setStatus('win-status', w.busy ? t('Применяю…', 'Applying…') : w.applied ? t('Иконки Джарвиса применены', 'Jarvis icons applied') : t('Стандартные значки Windows', 'Standard Windows icons'), w.busy ? 'busy' : w.applied ? 'on' : 'off');
  $('win-apply').disabled = !!w.busy;
  $('win-apply').textContent = w.applied ? t('Применить ещё раз', 'Apply again') : t('Применить иконки', 'Apply icons');
  $('win-restore').disabled = !!w.busy || !w.applied;
  renderTaskbar(s.taskbar || {});
  $('foot-left').textContent = t(`${s.meta.root} · ядро 127.0.0.1:3190 · работает ${fmtDur((Date.now() - s.startedAt) / 1000)}`,
    `${s.meta.root} · core 127.0.0.1:3190 · up ${fmtDur((Date.now() - s.startedAt) / 1000)}`);
}

// Windows shell parts restyled through the built-in Windhawk (taskbar, Start, notifications, Explorer).
function renderTaskbar(tb) {
  const mods = tb.mods || {};
  const parts = Object.entries(mods);
  const missing = parts.filter(([, m]) => !m.installed).map(([k]) => k);
  const anyOn = parts.some(([, m]) => m.enabled);
  setStatus('tb-status', tb.step ? t('Установка…', 'Installing…') : !tb.installed ? t('Не установлено', 'Not installed')
    : anyOn ? (tb.running ? t('Оформление Джарвиса активно', 'Jarvis look active') : t('Windhawk не запущен', 'Windhawk is not running')) : t('Стандартный вид Windows', 'Standard Windows look'),
  tb.step ? 'busy' : anyOn && tb.running ? 'on' : 'off');
  $('tb-step').textContent = tb.step || '';
  $('tb-error').hidden = !tb.error; $('tb-error').textContent = tb.error || '';
  $('tb-install').hidden = !missing.length;
  $('tb-install').disabled = !!tb.step;
  $('tb-install').textContent = missing.length === parts.length ? t('Установить всё', 'Install all') : t(`Установить остальное (${missing.length})`, `Install the rest (${missing.length})`);
  $('tb-auto-wrap').hidden = $('tb-reload').hidden = $('tb-open').hidden = !tb.installed;
  if (document.activeElement !== $('tb-auto')) $('tb-auto').checked = !!tb.autorun;
  const box = $('tb-parts');
  const sig = JSON.stringify([parts, !!tb.step]);
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig; box.textContent = '';
  for (const [key, m] of parts) {
    const li = el('li');
    li.appendChild(el('b', '', m.label));
    if (m.installed) {
      li.appendChild(el('small', m.enabled ? 'st-on' : 'st-off', m.enabled ? t('Джарвис', 'Jarvis') : t('стандарт', 'standard')));
      const lab = el('label', 'switch');
      const inp = el('input'); inp.type = 'checkbox'; inp.checked = m.enabled;
      inp.onchange = () => post('taskbar/toggle', { key, on: inp.checked });
      lab.append(inp, el('span'));
      li.appendChild(lab);
    } else {
      const b = el('button', 'btn small', t('Установить', 'Install'));
      b.disabled = !!tb.step;
      b.onclick = () => post('taskbar/install', { keys: [key] });
      li.appendChild(b);
    }
    box.appendChild(li);
  }
}

let journalSig = '';
langHooks.push(() => { journalSig = ''; });
function renderJournal(s) {
  const sig = s.log.length + ':' + (s.log.at(-1)?.t || 0);
  if (sig === journalSig) return;
  journalSig = sig;
  const box = $('journal'); box.textContent = '';
  for (const e of s.log.slice().reverse()) {
    const li = el('li');
    li.append(el('time', '', new Date(e.t).toLocaleTimeString(LOCALE(), { hour12: false })), el('span', e.level, e.text));
    box.appendChild(li);
  }
}

// ---------------------------------------------------------------- HUD settings
const ACCENTS = [[0.361, 0.882, 1.0], [0.35, 0.55, 1.0], [0.30, 1.0, 0.80], [1.0, 0.70, 0.30], [1.0, 0.36, 0.36], [0.72, 0.50, 1.0]];
const ACCENT_NAMES = () => [t('Голубой', 'Cyan'), t('Синий', 'Blue'), t('Бирюзовый', 'Turquoise'), t('Янтарный', 'Amber'), t('Красный', 'Red'), t('Фиолетовый', 'Violet')];
const FPS = () => [[15, '15'], [30, '30'], [60, '60'], [120, '120'], [0, t('Макс', 'Max')]];
const MARGINS = () => [[0, t('Нет', 'None')], [160, '160 px'], [300, '300 px'], [440, '440 px']];
const LOOK = () => [['reactor', t('Реактор с часами', 'Reactor with clock')], ['frame', t('Рамка и линейка', 'Frame and ruler')], ['grid', t('Сетка фона', 'Background grid')],
  ['motes', t('Частицы', 'Particles')], ['boot_animation', t('Анимация запуска', 'Boot animation')]];
const MODULES = () => [['datering', t('Календарь', 'Calendar')], ['cluster', t('Датчики', 'Sensors')], ['load', t('Нагрузка', 'Load')], ['network', t('Сеть', 'Network')],
  ['gpu', t('Видеокарта', 'GPU')], ['traffic', t('Трафик', 'Traffic')], ['storage', t('Накопитель', 'Storage')], ['energy', t('Энергия', 'Power')],
  ['thermal', t('Температуры', 'Temperatures')], ['chrono', t('Хронометрия', 'Chronometry')], ['system', t('Узел', 'Node')], ['display', t('Дисплей', 'Display')],
  ['cores', t('Ядра процессора', 'CPU cores')]];
let hudSaved = null, hudDraft = null;
const sameColor = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 0.02);
const clone = (o) => JSON.parse(JSON.stringify(o));

async function loadHudConfig() {
  try {
    hudSaved = await (await fetch('/api/hud/config')).json();
    hudDraft = clone(hudSaved);
    renderHudForm();
  } catch {}
}
function checkbox(label, checked, onChange) {
  const l = el('label', 'switch');
  const i = el('input'); i.type = 'checkbox'; i.checked = checked; i.onchange = () => onChange(i.checked);
  l.append(i, el('span'), document.createTextNode(label));
  return l;
}
function segmented(box, items, current, onPick) {
  box.textContent = '';
  for (const [v, label] of items) {
    const b = el('button', Math.abs(v - current) < 1 ? 'on' : '', label);
    b.onclick = () => onPick(v);
    box.appendChild(b);
  }
}
function renderHudForm() {
  if (!hudDraft) return;
  const acc = $('hud-accent'); acc.textContent = '';
  ACCENTS.forEach((c, i) => {
    const b = el('button', sameColor(hudDraft.accent, c) ? 'on' : '');
    b.style.setProperty('--c', `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`);
    b.title = ACCENT_NAMES()[i];
    b.onclick = () => { hudDraft.accent = c; renderHudForm(); };
    acc.appendChild(b);
  });
  segmented($('hud-fps'), FPS(), hudDraft.fps_cap, (v) => { hudDraft.fps_cap = v; renderHudForm(); });
  segmented($('hud-margin'), MARGINS(), hudDraft.icon_margin, (v) => { hudDraft.icon_margin = v; renderHudForm(); });
  const look = $('hud-look'); look.textContent = '';
  for (const [key, label] of LOOK()) look.appendChild(checkbox(label, !!hudDraft[key], (v) => { hudDraft[key] = v; markDirty(); }));
  const mods = $('hud-modules'); mods.textContent = '';
  for (const [key, label] of MODULES()) {
    mods.appendChild(checkbox(label, !hudDraft.hidden.includes(key), (v) => {
      hudDraft.hidden = v ? hudDraft.hidden.filter((k) => k !== key) : [...hudDraft.hidden, key];
      markDirty();
    }));
  }
  markDirty();
}
langHooks.push(renderHudForm);
function markDirty() {
  const dirty = JSON.stringify(hudDraft) !== JSON.stringify(hudSaved);
  $('hud-dirty').hidden = !dirty;
  $('hud-apply').disabled = $('hud-revert').disabled = !dirty;
}
$('hud-apply').onclick = async () => {
  $('hud-apply').disabled = true;
  await post('hud/apply', { config: hudDraft });
  await loadHudConfig();
};
$('hud-revert').onclick = () => { hudDraft = clone(hudSaved); renderHudForm(); };
$('hud-reset').onclick = async () => {
  if (!(await confirmBox(t('Сброс настроек обоев', 'Reset wallpaper settings'),
    t('Вернуть все настройки обоев по умолчанию? Расстановка модулей тоже сбросится.', 'Restore all wallpaper settings to defaults? Module positions will be reset too.'), t('Сбросить', 'Reset')))) return;
  await post('hud/reset');
  await loadHudConfig();
};

let previewSig = -1;
function renderHud(s) {
  const h = s.hud;
  setStatus('hud-status', h.running ? t('Обои работают', 'Wallpaper is running') : t('Обои выключены', 'Wallpaper is off'), h.running ? 'on' : 'off');
  setLed('hud-led', h.running ? 'on' : '');
  $('hud-start').disabled = h.running;
  $('hud-stop').disabled = !h.running;
  $('hud-autostart').checked = h.autostart;
  $('hud-preview-box').classList.toggle('busy', h.previewBusy);
  if (h.previewAt !== previewSig) {
    previewSig = h.previewAt;
    if (h.previewAt) { $('hud-preview').src = '/api/hud/preview.png?t=' + h.previewAt; $('hud-preview').hidden = false; $('hud-preview-empty').hidden = true; }
    else { $('hud-preview').hidden = true; $('hud-preview-empty').hidden = false; }
  }
}
$('hud-start').onclick = () => post('hud/start');
$('hud-stop').onclick = () => post('hud/stop');
$('hud-autostart').onchange = (e) => post('hud/autostart', { on: e.target.checked });
$('hud-preview-btn').onclick = () => post('hud/preview');

// ---------------------------------------------------------------- logs
const LOGS = () => [['launcher', t('Лаунчер', 'Launcher')], ['agent', t('Агент', 'Agent')], ['agentOut', t('Агент · вывод', 'Agent · output')],
  ['model', t('Модель', 'Model')], ['comfy', 'ComfyUI'], ['telegram', 'Telegram']];
let logWhich = 'launcher';
function buildLogSeg() {
  const box = $('log-seg'); box.textContent = '';
  for (const [k, label] of LOGS()) {
    const b = el('button', k === logWhich ? 'on' : '', label);
    b.onclick = () => { logWhich = k; buildLogSeg(); loadLog(); };
    box.appendChild(b);
  }
}
async function loadLog() {
  try {
    const r = await (await fetch('/api/logs?which=' + logWhich)).json();
    const pre = $('log-text');
    const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
    pre.textContent = r.text || t('(пусто)', '(empty)');
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  } catch {}
}
buildLogSeg();
langHooks.push(buildLogSeg);
setInterval(() => { if ($('tab-system').classList.contains('active')) loadLog(); }, 3000);

// ---------------------------------------------------------------- actions
$('agent-start').onclick = () => post('agent/start');
$('agent-open').onclick = () => post('agent/open');
$('agent-stop').onclick = () => post('agent/stop');
$('agent-theme').onchange = (e) => post('agent/theme', { on: e.target.checked });
$('reactor-btn').onclick = () => {
  const st = state?.agent.status;
  if (st === 'on') post('agent/open');
  else if (st === 'off' || st === 'error') post('agent/start');
};
$('power').onclick = async () => {
  if (!(await confirmBox(t('Отключение', 'Shut down'), t('Остановить агента и выгрузить локальную модель? Обои HUD продолжат работать.',
    'Stop the agent and unload the local model? The HUD wallpaper keeps running.'), t('Отключить', 'Shut down')))) return;
  post('shutdown');
};
$('t-blender').onclick = () => post('tool/blender');
$('win-apply').onclick = () => post('win/apply');
// Manual steps: open the right Windows page and put what to paste into the clipboard.
async function guide(action, clip, hint) {
  if (clip) { try { await navigator.clipboard.writeText(clip); } catch {} }
  post(action);
  $('g-hint').hidden = false;
  $('g-hint').textContent = hint;
}
$('g-cursors').onclick = () => guide('guide/cursors', null, t(
  'Открылись «Свойства: Мышь» → «Указатели» и папка с курсорами. Для каждой строки нажмите «Обзор» и выберите файл по таблице ниже, затем «Сохранить как…» → «J.A.R.V.I.S.» и «ОК».',
  'Mouse Properties → Pointers and the cursor folder are open. For each row press "Browse" and pick the file from the table below, then "Save As…" → "J.A.R.V.I.S." and "OK".'));
$('g-accent').onclick = () => guide('guide/accent', '5CE1FF', t(
  'Открылись «Цвета». В «Цвет элементов» выберите «Вручную» → «Просмотреть цвета» → «Дополнительно» и вставьте 5CE1FF (уже в буфере обмена, Ctrl+V).',
  'Colors is open. Under "Accent color" choose "Manual" → "View colors" → "More" and paste 5CE1FF (already in the clipboard, Ctrl+V).'));
$('g-lock').onclick = () => guide('guide/lock', (state && state.meta ? state.meta.root : 'C:\\LLM') + '\\data\\launcher\\lockscreen.png', t(
  'Открылся «Экран блокировки». В «Персонализировать экран блокировки» выберите «Изображение» → «Обзор фотографий», вставьте путь в поле имени файла (Ctrl+V) и нажмите «Выбрать изображение».',
  'Lock screen is open. Under "Personalize your lock screen" choose "Picture" → "Browse photos", paste the path into the file name box (Ctrl+V) and press "Choose picture".'));
$('tb-open').onclick = () => post('taskbar/windhawk');
$('tb-install').onclick = () => {
  const mods = (state && state.taskbar && state.taskbar.mods) || {};
  post('taskbar/install', { keys: Object.keys(mods).filter((k) => !mods[k].installed) });
};
$('tb-reload').onclick = () => post('taskbar/reload');
$('tb-auto').onchange = (e) => post('taskbar/autostart', { on: e.target.checked });
$('win-restore').onclick = async () => {
  if (await confirmBox(t('Стандартные значки', 'Standard icons'), t('Вернуть обычные значки Windows, папок и ярлыков?', 'Restore the normal Windows, folder and shortcut icons?'), t('Вернуть', 'Restore'))) post('win/restore');
};

// ---------------------------------------------------------------- stream
function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => { $('offline').hidden = true; render(JSON.parse(e.data)); });
  es.addEventListener('focus', () => window.focus());
  es.onerror = () => { $('offline').hidden = false; };
}
// Start once every script (app.js, models-ui.js) is loaded.
window.addEventListener('DOMContentLoaded', () => {
  connect();
  // ?tab=model opens a tab directly (links, screenshots); otherwise the last one used.
  try { const p = new URLSearchParams(location.search).get('tab') || localStorage.getItem('jarvis-tab'); if (p) showTab(p); } catch {}
});
