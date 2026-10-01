'use strict';
// Models tab + the home "local model" panel: installed models, launching, and the Hugging Face catalog.
// Uses helpers from app.js ($, el, post, t, dec, fmtGB, fmtDur, setLed, setStatus, confirmBox, state, render).

const FIT = () => ({ fast: t('Быстро', 'Fast'), ok: t('Нормально', 'OK'), slow: t('Медленно', 'Slow'), no: t('Не влезет', "Won't fit") });
const FIT_HINT = () => ({
  fast: t('целиком в видеокарте', 'fully on the GPU'),
  ok: t('часть в оперативной памяти', 'partly in RAM'),
  slow: t('в основном в оперативной памяти — ответы будут медленными', 'mostly in RAM — replies will be slow'),
  no: t('не хватит памяти этого ПК', 'not enough memory on this PC'),
});
const kLabel = (ctx) => Math.round(ctx / 1024) + 'K';
const paramsLabel = (p) => (p ? (p >= 1e10 ? Math.round(p / 1e9) : dec((p / 1e9).toFixed(1))) + 'B' : '');
const fmtCount = (n) => (n >= 1e6 ? dec((n / 1e6).toFixed(1)) + t(' млн', 'M') : n >= 1e3 ? Math.round(n / 1e3) + t(' тыс.', 'K') : String(n));

let selectedId = null;
let chosenCtx = null;

function fitBadge(fit) {
  const b = el('span', 'fit ' + fit.level, FIT()[fit.level]);
  b.title = `${FIT_HINT()[fit.level]} · ${t('нужно', 'needs')} ≈ ${dec(fit.needGB)} ${t('ГБ', 'GB')}`;
  return b;
}
function badges(m) {
  const out = [];
  if (m.kind === 'image' || m.kind === 'video') {
    const b = el('span', 'badge img', m.kind === 'video' ? t('видео · ComfyUI', 'video · ComfyUI') : t('картинки · ComfyUI', 'images · ComfyUI'));
    b.title = m.kind === 'video' ? t('Генерирует видео — работает в ComfyUI, не в агенте', 'Generates video — runs in ComfyUI, not in the agent')
      : t('Генерирует изображения — работает в ComfyUI, не в агенте', 'Generates images — runs in ComfyUI, not in the agent');
    out.push(b);
  }
  if (m.moe) out.push(el('span', 'badge plain', 'MoE'));
  if (m.vision) out.push(el('span', 'badge', t('видит картинки', 'sees images')));
  if (m.tools) out.push(el('span', 'badge', t('инструменты агента', 'agent tools')));
  if (m.tools === false) out.push(el('span', 'badge plain', t('без инструментов', 'no tools')));
  if (m.uncensored) out.push(el('span', 'badge plain', t('без цензуры', 'uncensored')));
  if (m.coder) out.push(el('span', 'badge plain', t('для кода', 'for code')));
  return out;
}

// ---------------------------------------------------------------- catalog filters
const FILTER_LABELS = () => ({ fits: t('влезает в этот ПК', 'fits this PC'), vision: t('видит картинки', 'sees images'), uncensored: t('без цензуры', 'uncensored'),
  tools: t('инструменты агента', 'agent tools'), coder: t('для кода', 'for code'), moe: 'MoE', image: t('картинки (ComfyUI)', 'images (ComfyUI)') });
let filters = new Set();
try { filters = new Set(JSON.parse(localStorage.getItem('jarvis-cat-filters') || '[]')); } catch {}

// `fits`: the model has a variant that runs on this PC (exact for the picks, approximate for search).
function passes(m, fits) {
  for (const f of filters) {
    if (f === 'fits' ? !fits : !m[f]) return false;
  }
  return true;
}
function filterNote(list, shown, total) {
  if (!filters.size || !shown) return;
  const names = [...filters].map((f) => FILTER_LABELS()[f]).join(', ');
  list.prepend(el('div', 'muted small', t(`Показано ${shown} из ${total} · фильтр: ${names}`, `Showing ${shown} of ${total} · filter: ${names}`)));
}
function syncChips() {
  document.querySelectorAll('#cat-filters button').forEach((b) => b.classList.toggle('on', filters.has(b.dataset.f)));
}
document.querySelectorAll('#cat-filters button').forEach((b) => b.addEventListener('click', () => {
  if (filters.has(b.dataset.f)) filters.delete(b.dataset.f); else filters.add(b.dataset.f);
  try { localStorage.setItem('jarvis-cat-filters', JSON.stringify([...filters])); } catch {}
  syncChips();
  if (!$('cat-detail').hidden) return; // keep an open model card; the list refreshes on "Back"
  if (catMode === 'rec') showRecommended(); else showSearch();
}));
syncChips();

// Rebuild a container only when its content signature changes (keeps hover/focus stable).
function once(box, sig, build) {
  if (box.dataset.sig === sig) return;
  box.dataset.sig = sig;
  box.textContent = '';
  build(box);
}
function ctxSeg(box, ctxs) {
  once(box, ctxs.join(',') + '|' + chosenCtx, (b) => {
    for (const c of ctxs) {
      const btn = el('button', c === chosenCtx ? 'on' : '', kLabel(c));
      btn.onclick = () => { chosenCtx = c; render(state); };
      b.appendChild(btn);
    }
  });
}

// ---------------------------------------------------------------- hardware strip
function renderHw(s) {
  const hw = s.hw;
  if (!hw) return;
  $('hw-gpu').textContent = hw.gpu ? hw.gpu.name : t('нет дискретной', 'no discrete GPU');
  $('hw-vram').textContent = hw.gpu ? `${(hw.gpu.vramMB / 1024).toFixed(0)} ${t('ГБ', 'GB')}` : '—';
  $('hw-ram').textContent = `${Math.round(hw.ramMB / 1024)} ${t('ГБ', 'GB')}`;
  $('hw-cpu').textContent = t(`${hw.threads} потоков`, `${hw.threads} threads`);
  $('hw-cpu').title = hw.cpu;
  const engines = { cuda: 'CUDA (NVIDIA)', vulkan: 'Vulkan', sycl: 'SYCL (Intel)', cpu: t('только процессор', 'CPU only'), none: t('не установлен', 'not installed') };
  $('hw-engine').textContent = engines[hw.engine] || hw.engine;
  $('hw-disk').textContent = fmtGB(s.sys.diskFree);
  const note = $('hw-note');
  if (hw.engine === 'none') { note.hidden = false; note.textContent = t('Движок llama.cpp не установлен — локальные модели запустить не получится.', 'The llama.cpp engine is not installed — local models cannot run.'); }
  else if (hw.gpu && !hw.vramMB) {
    note.hidden = false;
    note.textContent = t(`Установленный движок (${engines[hw.engine]}) не использует видеокарту ${hw.gpu.name} — модели будут считаться на процессоре. Для неё нужен движок ${engines[hw.recommendedEngine]}.`,
      `The installed engine (${engines[hw.engine]}) does not use the ${hw.gpu.name} GPU — models will run on the CPU. It needs the ${engines[hw.recommendedEngine]} engine.`);
  } else note.hidden = true;
  // Engines that don't fit the GPU, prompt dismissed: a way back to it.
  const e = s.engines;
  if (e && e.actions.length && !e.visible) {
    if (note.hidden) { note.hidden = false; note.textContent = t('Движки не подходят к видеокарте.', 'The engines do not match the GPU.'); }
    const b = el('button', 'btn small primary', t('Обновить движки', 'Update engines'));
    b.style.marginLeft = '10px';
    b.onclick = () => post('hw/show');
    note.appendChild(b);
  }
}

// ---------------------------------------------------------------- installed + launch
function renderModels(s) {
  const M = s.models, a = M.active;
  // Image models are opened in ComfyUI, not launched by llama.cpp.
  const inst = M.installed.filter((m) => m.status === 'installed' && !m.image);
  if (!selectedId || !inst.some((m) => m.id === selectedId)) selectedId = (a.id && inst.some((m) => m.id === a.id)) ? a.id : (inst[0] || {}).id || null;
  const sel = inst.find((m) => m.id === selectedId) || null;
  const act = M.installed.find((m) => m.id === a.id);
  const running = ['loading', 'on'].includes(a.status);
  const ctxs = M.contexts.filter((c) => !sel || c <= (sel.ctxMax || 131072));
  if (!chosenCtx || !ctxs.includes(chosenCtx)) chosenCtx = sel && ctxs.includes(sel.ctx) ? sel.ctx : 16384;

  const name = act ? `${act.title} · ${act.quant}` : '';
  const st = {
    loading: [t(`Загружается: ${name}… `, `Loading: ${name}… `) + fmtDur((Date.now() - a.since) / 1000), 'busy', 'busy'],
    on: [t(`Работает: ${name} · ${kLabel(a.ctx || 0)}`, `Running: ${name} · ${kLabel(a.ctx || 0)}`), 'on', 'on'],
    stopping: [t('Выгружается…', 'Unloading…'), 'busy', 'busy'],
    error: [t('Сбой запуска', 'Start failed'), 'err', 'err'],
  }[a.status] || [inst.length ? t('Не запущена', 'Not running') : M.installed.some((m) => m.image) ? t('Нет моделей для агента', 'No models for the agent') : t('Нет установленных моделей', 'No models installed'), 'off', ''];
  for (const id of ['qm', 'm']) { setStatus(id + '-status', st[0], st[1]); setLed(id + '-led', st[2]); }
  $('m-uptime').textContent = a.status === 'on' ? t('работает ', 'up ') + fmtDur((Date.now() - a.since) / 1000) : '';
  $('qm-ctx').textContent = '';
  $('m-error').hidden = !(a.status === 'error' && a.error);
  $('m-error').textContent = a.error || '';

  ctxSeg($('qm-seg'), ctxs);
  ctxSeg($('m-seg'), ctxs);
  const select = $('qm-select');
  once(select, inst.map((m) => m.id).join('|'), (b) => {
    if (!inst.length) b.appendChild(el('option', '', t('Нет установленных моделей', 'No models installed')));
    for (const m of inst) { const o = el('option', '', `${m.title} · ${m.quant}`); o.value = m.id; b.appendChild(o); }
  });
  if (sel && select.value !== sel.id && document.activeElement !== select) select.value = sel.id;
  select.disabled = !inst.length;

  const restart = running && (a.id !== selectedId || a.ctx !== chosenCtx);
  for (const id of ['qm-start', 'm-start']) {
    const b = $(id);
    b.textContent = (restart ? t('Перезапустить', 'Restart') : t('Запустить', 'Start')) + ` · ${kLabel(chosenCtx)}`;
    b.disabled = !sel || a.status === 'stopping' || (running && !restart);
  }
  $('qm-stop').disabled = $('m-stop').disabled = !running;
  $('m-chat').disabled = a.status !== 'on';
  $('qm-hint').textContent = !sel ? t('Установите модель на вкладке «Модели» — там подборка и поиск по Hugging Face.', 'Install a model on the Models tab — it has picks and Hugging Face search.')
    : t(`${sel.title} · ${sel.quant}. В агенте выберите её в группе «Локально» и «Лёгкий режим».`, `${sel.title} · ${sel.quant}. In the agent pick it in the "Local" group and "Lite mode".`);

  const freeRam = s.sys.ramTotal - s.sys.ramUsed;
  const note = $('mem-note');
  if (!running && sel && sel.fit && sel.fit.level !== 'fast' && freeRam < sel.fit.needGB * GB * 0.8) {
    const heavy = s.sys.heavy.filter((p) => !/^(llama-server|Memory Compression|System|MsMpEng|dwm|explorer)$/i.test(p.name)).slice(0, 3)
      .map((p) => `${p.name} — ${dec((p.mb / 1024).toFixed(1))} ${t('ГБ', 'GB')}`).join(', ');
    note.hidden = false;
    note.textContent = t(`Свободно ${fmtGB(freeRam)} ОЗУ, а модели нужно около ${dec(sel.fit.needGB)} ГБ. Закройте тяжёлые программы (${heavy}), иначе ответы будут идти медленно.`,
      `${fmtGB(freeRam)} of RAM is free, and the model needs about ${sel.fit.needGB} GB. Close heavy programs (${heavy}), otherwise replies will be slow.`);
  } else note.hidden = true;

  renderInstalled(M);
}

function renderInstalled(M) {
  const job = M.job;
  const pct = (m) => Math.floor((100 * m.done) / Math.max(1, m.bytes));
  const sig = JSON.stringify([selectedId, M.active.id, M.active.status, state.comfy && state.comfy.installed, M.installed.map((m) => [m.id, m.status, pct(m), m.error, m.fit && m.fit.level]),
    job && [job.phase, Math.round(job.speed / 1e5), Math.floor((100 * job.verifyDone) / Math.max(1, job.verifyTotal))]]);
  once($('inst-list'), sig, (box) => {
    if (!M.installed.length) { box.appendChild(el('li', 'empty', t('Пока нет ни одной модели. Выберите подходящую в каталоге справа.', 'No models yet. Pick one in the catalog on the right.'))); return; }
    for (const m of M.installed) {
      const li = el('li', 'inst' + (m.id === selectedId ? ' sel' : ''));
      const title = el('div', 't', m.title); title.appendChild(el('small', '', m.quant));
      const acts = el('div', 'acts');
      const btn = (label, cls, fn) => { const b = el('button', 'btn small ' + cls, label); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
      const meta = el('div', 'meta');
      meta.appendChild(el('span', '', fmtGB(m.bytes)));
      if (m.status === 'installed') {
        if (m.fit) meta.appendChild(fitBadge(m.fit));
        if (M.active.id === m.id && ['loading', 'on'].includes(M.active.status)) meta.appendChild(el('span', 'badge', M.active.status === 'on' ? t('● запущена', '● running') : t('● загружается', '● loading')));
        if (m.image) {
          if (state.comfy && state.comfy.installed) btn(t('Открыть в ComfyUI', 'Open in ComfyUI'), 'primary', () => post('comfy/start'));
          else btn(t('Установить ComfyUI', 'Install ComfyUI'), 'primary', () => installComfy());
        } else li.onclick = () => { selectedId = m.id; chosenCtx = null; render(state); };
        btn(t('Удалить', 'Delete'), 'danger', () => removeModel(m));
      } else {
        const isJob = job && job.id === m.id;
        let status = { queued: t('в очереди', 'queued'), paused: t('пауза', 'paused'), error: t('ошибка', 'error'), downloading: t('скачивается', 'downloading') }[m.status] || m.status;
        if (isJob && job.phase === 'verify') status = t('проверка целостности ', 'verifying ') + Math.floor((100 * job.verifyDone) / Math.max(1, job.verifyTotal)) + '%';
        else if (isJob && job.phase === 'wait') status = job.message;
        else if (m.status === 'downloading' || m.status === 'paused' || m.status === 'queued') status += ` · ${pct(m)}%`;
        if (isJob && job.phase === 'download' && job.speed) status += ` · ${dec((job.speed / 1048576).toFixed(1))} ${t('МБ/с', 'MB/s')} · ${t('осталось', 'left')} ${fmtDur((m.bytes - m.done) / job.speed)}`;
        meta.appendChild(el('span', '', status));
        if (m.status === 'downloading' || m.status === 'queued') btn(t('Пауза', 'Pause'), '', () => post('model/pause', { id: m.id }));
        else btn(t('Продолжить', 'Resume'), 'primary', () => post('model/resume', { id: m.id }));
        btn(t('Отменить', 'Cancel'), 'danger', () => removeModel(m, true));
      }
      badges(m).forEach((b) => meta.appendChild(b));
      li.append(title, acts, meta);
      if (m.status !== 'installed') {
        const bar = el('div', 'bar'); const i = el('i', m.status === 'downloading' ? 'active' : ''); i.style.width = pct(m) + '%'; bar.appendChild(i); li.appendChild(bar);
      }
      if (m.error) li.appendChild(el('div', 'err', m.error));
      box.appendChild(li);
    }
  });
}

async function removeModel(m, cancel) {
  const name = `${m.title} · ${m.quant}`;
  const text = cancel ? t(`Отменить загрузку «${name}» и удалить уже скачанное?`, `Cancel the download of "${name}" and delete what was downloaded?`)
    : t(`Удалить «${name}» и освободить ${fmtGB(m.bytes)}? Скачать её можно будет снова из каталога.`, `Delete "${name}" and free ${fmtGB(m.bytes)}? You can download it again from the catalog.`);
  if (await confirmBox(cancel ? t('Отмена загрузки', 'Cancel download') : t('Удаление модели', 'Delete model'), text,
    cancel ? t('Отменить загрузку', 'Cancel download') : t('Удалить', 'Delete'))) post('model/delete', { id: m.id });
}

// ---------------------------------------------------------------- catalog
let catMode = 'rec';
let recCache = null;
// A paged Hugging Face listing: {query, items, next, started, loading, scanned}.
const pager = (query) => ({ query, items: [], next: null, started: false, loading: false, scanned: 0 });
let searchPager = null;         // "Search" tab
let popularPager = pager('');   // continuation of the picks: the most downloaded GGUF models

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || t('ошибка', 'error'));
  return j;
}
function catLoading(text) { const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.innerHTML = ''; list.appendChild(el('div', 'loading', text)); }
function catError(e) { const list = $('cat-list'); list.innerHTML = ''; list.appendChild(el('div', 'empty', t('Не удалось связаться с Hugging Face: ', 'Could not reach Hugging Face: ') + e.message)); }

const fitsApprox = (r) => (r.fitApprox ? r.fitApprox.level !== 'no' : false);

// Fetch pages until `want` new items pass the filters (or HF has no more / 6 pages per click).
async function loadMore(p, want, skip = new Set()) {
  if (p.loading || (p.started && !p.next)) return;
  p.loading = true;
  try {
    let added = 0, pages = 0;
    do {
      const url = '/api/catalog/search?q=' + encodeURIComponent(p.query) + (p.next ? '&cursor=' + encodeURIComponent(p.next) : '');
      const page = await getJson(url);
      p.started = true; p.next = page.next; pages += 1;
      const seen = new Set(p.items.map((x) => x.repo));
      for (const r of page.items) {
        if (seen.has(r.repo) || skip.has(r.repo)) continue;
        p.items.push(r); p.scanned += 1;
        if (passes(r, fitsApprox(r))) added += 1;
      }
    } while (p.next && added < want && pages < 6);
  } finally { p.loading = false; }
}

function resultCard(r) {
  const card = el('button', 'cat');
  const right = el('div');
  if (r.fitApprox) {
    const b = fitBadge(r.fitApprox);
    b.textContent = '≈ ' + b.textContent;
    b.title = t('Примерно, для 4-битного варианта. Точно по каждому варианту — в карточке модели. ', 'Approximate, for a 4-bit variant. Exact numbers per variant are in the model card. ') + b.title;
    right.appendChild(b);
  }
  const meta = el('div', 'meta');
  if (r.params) meta.appendChild(el('span', '', paramsLabel(r.params)));
  meta.append(el('span', '', `⬇ ${fmtCount(r.downloads)}`), el('span', '', `♥ ${fmtCount(r.likes)}`));
  badges(r).forEach((b) => meta.appendChild(b));
  if (r.gated) meta.appendChild(el('span', 'badge plain', t('нужен вход', 'login required')));
  card.append(el('div', 't', r.repo), right, meta);
  card.onclick = () => openDetail(r.repo);
  return card;
}

// "Show more" at the bottom of a list; re-renders the current view when the page arrives.
function moreButton(list, p, redraw, skip) {
  if (p.started && !p.next) {
    list.appendChild(el('div', 'muted small end', p.query
      ? t(`Это все модели на Hugging Face по запросу «${p.query}» — просмотрено ${p.scanned}.`, `That's every model on Hugging Face for "${p.query}" — ${p.scanned} checked.`)
      : t(`Это все модели на Hugging Face — просмотрено ${p.scanned}.`, `That's every model on Hugging Face — ${p.scanned} checked.`)));
    return;
  }
  const b = el('button', 'btn wide more', p.loading ? t('Загружаю…', 'Loading…') : p.started ? t('Показать ещё', 'Show more') : t('Показать ещё модели с Hugging Face', 'Show more models from Hugging Face'));
  b.disabled = p.loading;
  b.onclick = async () => {
    b.disabled = true; b.textContent = filters.size ? t('Ищу подходящие под фильтры…', 'Looking for models that match the filters…') : t('Загружаю…', 'Loading…');
    const before = p.items.length;
    try { await loadMore(p, 10, skip); } catch (e) { b.disabled = false; b.textContent = t('Ошибка — попробовать снова', 'Error — try again'); return; }
    const scrollTop = $('cat-list').closest('.panel-body').scrollTop;
    redraw();
    $('cat-list').closest('.panel-body').scrollTop = scrollTop;
    if (p.items.length === before && p.next) b.textContent = t('Показать ещё', 'Show more');
  };
  list.appendChild(b);
}

async function showRecommended() {
  if (!recCache) {
    catLoading(t('Загружаю подборку…', 'Loading the picks…'));
    try { recCache = await getJson('/api/catalog/recommended'); } catch (e) { return catError(e); }
  }
  const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.textContent = '';
  const shown = recCache.filter((m) => passes(m, !!m.recommendedQuant));
  for (const m of shown) {
    const q = m.quants.find((x) => x.key === m.recommendedQuant);
    const card = el('button', 'cat');
    const title = el('div', 't', m.title);
    const right = el('div');
    if (q) right.appendChild(fitBadge(q.fit)); else right.appendChild(el('span', 'fit no', FIT().no));
    const meta = el('div', 'meta');
    if (m.params) meta.appendChild(el('span', '', paramsLabel(m.params)));
    if (q) meta.appendChild(el('span', '', `${t('лучший вариант', 'best variant')}: ${q.key} · ${fmtGB(q.bytes)}`));
    badges(m).forEach((b) => meta.appendChild(b));
    card.append(title, right, el('div', 'n', m.note), meta);
    card.onclick = () => openDetail(m.repo);
    list.appendChild(card);
  }
  filterNote(list, shown.length, recCache.length);
  // Beyond the picks: popular GGUF models, loaded on demand.
  const skip = new Set(recCache.map((m) => m.repo));
  const popular = popularPager.items.filter((r) => passes(r, fitsApprox(r)));
  if (popularPager.started) {
    list.appendChild(el('h3', 'sep', `${t('Популярные на Hugging Face', 'Popular on Hugging Face')} · ${popular.length}`));
    if (!popular.length) list.appendChild(el('div', 'empty', t('Среди просмотренных моделей нет подходящих под фильтры — нажмите «Показать ещё».', 'None of the models checked so far match the filters — press "Show more".')));
    popular.forEach((r) => list.appendChild(resultCard(r)));
  }
  moreButton(list, popularPager, showRecommended, skip);
}

async function doSearch(q) {
  catLoading(t('Ищу на Hugging Face…', 'Searching Hugging Face…'));
  searchPager = pager(q);
  try { await loadMore(searchPager, 15); } catch (e) { return catError(e); }
  showSearch();
}
function showSearch() {
  const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.textContent = '';
  if (!searchPager) { list.appendChild(el('div', 'empty', t('Введите название модели — например qwen, gemma, llama, coder или uncensored.', 'Type a model name — for example qwen, gemma, llama, coder or uncensored.'))); return; }
  if (!searchPager.items.length) { list.appendChild(el('div', 'empty', t('Ничего не нашлось. Попробуйте другое название.', 'Nothing found. Try another name.'))); return; }
  const shown = searchPager.items.filter((r) => passes(r, fitsApprox(r)));
  if (!shown.length && filters.size) list.appendChild(el('div', 'empty', t('Среди просмотренных моделей нет подходящих под фильтры — нажмите «Показать ещё».', 'None of the models checked so far match the filters — press "Show more".')));
  shown.forEach((r) => list.appendChild(resultCard(r)));
  filterNote(list, shown.length, searchPager.items.length);
  moreButton(list, searchPager, showSearch);
}
let detailRepo = null;
async function openDetail(repo) {
  detailRepo = repo;
  const box = $('cat-detail');
  $('cat-list').hidden = true; box.hidden = false; box.textContent = '';
  box.appendChild(el('div', 'loading', t('Читаю список файлов модели…', 'Reading the model file list…')));
  let d;
  try { d = await getJson('/api/catalog/details?repo=' + encodeURIComponent(repo)); } catch (e) { box.textContent = ''; box.appendChild(el('div', 'empty', t('Не удалось загрузить: ', 'Could not load: ') + e.message)); }
  box.textContent = '';
  const back = el('button', 'btn small ghost', t('← Назад', '← Back'));
  back.onclick = () => { detailRepo = null; (catMode === 'rec' ? showRecommended() : showSearch()); };
  box.appendChild(back);
  if (!d) return;
  const head = el('div', 'head'); head.append(el('b', '', d.title), el('span', 'muted', d.author));
  box.appendChild(head);
  const facts = el('div', 'meta');
  facts.className = 'cat-facts muted small';
  facts.textContent = [d.params && t(`${paramsLabel(d.params)} параметров`, `${paramsLabel(d.params)} parameters`), d.arch && t(`архитектура ${d.arch}`, `architecture ${d.arch}`),
    d.ctxMax && t(`контекст до ${kLabel(d.ctxMax)}`, `context up to ${kLabel(d.ctxMax)}`), `⬇ ${fmtCount(d.downloads)}`].filter(Boolean).join(' · ');
  box.appendChild(facts);
  const bl = el('div', 'btn-row'); badges(d).forEach((b) => bl.appendChild(b)); box.appendChild(bl);
  const image = d.kind === 'image' || d.kind === 'video';
  if (image) {
    const w = el('div', 'note warn');
    w.appendChild(el('b', '', d.kind === 'video' ? t('Это модель для генерации видео, а не для общения.', 'This model generates video; it is not for chatting.')
      : t('Это модель для генерации картинок, а не для общения.', 'This model generates images; it is not for chatting.')));
    const comp = d.companions || {};
    const parts = [comp.text_encoders && t(`текстовый кодировщик ${fmtGB(comp.text_encoders.size)}`, `text encoder ${fmtGB(comp.text_encoders.size)}`),
      comp.vae && `VAE ${fmtGB(comp.vae.size)}`].filter(Boolean).join(', ');
    w.appendChild(document.createTextNode(t(' Агент и движок llama.cpp её не запустят — она работает в ComfyUI. Лаунчер скачает её в папку ComfyUI', ' The agent and the llama.cpp engine cannot run it — it runs in ComfyUI. The launcher will download it into the ComfyUI folder') +
      (d.extraBytes ? t(` вместе с нужными файлами (${parts}; уже скачанные повторно не качаются).`, ` together with the files it needs (${parts}; files already downloaded are not downloaded again).`) : '.')));
    box.appendChild(w);
    if (!d.companions || !d.companions.text_encoders || !d.companions.vae) {
      const missing = [!(d.companions && d.companions.text_encoders) && t('текстового кодировщика', 'a text encoder'), !(d.companions && d.companions.vae) && 'VAE'].filter(Boolean).join(t(' и ', ' and '));
      box.appendChild(el('div', 'note warn', t(`В этом репозитории нет ${missing} — их придётся скачать отдельно (ссылки обычно в описании модели на Hugging Face) и положить в папку моделей ComfyUI.`,
        `This repository has no ${missing} — download them separately (links are usually in the model description on Hugging Face) and put them into the ComfyUI models folder.`)));
    }
    const te = d.companions && d.companions.text_encoders;
    if (te && state.hw && te.size > state.hw.ramMB * 1048576 * 0.6) {
      box.appendChild(el('div', 'note warn', t(`Текстовому кодировщику нужно ≈ ${fmtGB(te.size)} оперативной памяти, а на этом ПК всего ${Math.round(state.hw.ramMB / 1024)} ГБ — перед генерацией закройте тяжёлые программы.`,
        `The text encoder needs ≈ ${fmtGB(te.size)} of RAM, and this PC has only ${Math.round(state.hw.ramMB / 1024)} GB — close heavy programs before generating.`)));
    }
    if (!state.comfy || !state.comfy.installed) {
      const c = el('div', 'note');
      const plan = state.comfy && state.comfy.plan;
      c.appendChild(document.createTextNode(t('ComfyUI ещё не установлен. ', 'ComfyUI is not installed yet. ') +
        (plan ? t(`Лаунчер поставит его сам: сборка для «${plan.label}», ≈ ${fmtGB(plan.bytes)}. `, `The launcher installs it for you: the "${plan.label}" build, ≈ ${fmtGB(plan.bytes)}. `) : '')));
      const b = el('button', 'btn small primary', t('Установить ComfyUI', 'Install ComfyUI'));
      b.onclick = () => { b.disabled = true; installComfy(); };
      c.appendChild(b);
      box.appendChild(c);
    }
  }
  if (d.tools === false) box.appendChild(el('div', 'note warn', t('Шаблон этой модели не поддерживает инструменты — в агенте она сможет только отвечать текстом, без действий.', "This model's template does not support tools — in the agent it can only reply with text, without actions.")));
  if (d.gated) { box.appendChild(el('div', 'note warn', t('Модель закрыта: чтобы скачать её, нужен вход на Hugging Face. Из лаунчера её не скачать.', 'This model is gated: downloading it requires a Hugging Face login. It cannot be downloaded from the launcher.'))); return; }
  if (!d.quants.length) { box.appendChild(el('div', 'empty', t('В этом репозитории нет файлов GGUF — llama.cpp не сможет её запустить.', 'This repository has no GGUF files — llama.cpp cannot run it.'))); return; }
  box.appendChild(el('p', 'muted small', image
    ? t('★ — лучший вариант для этого ПК. Чем больше число в названии (Q4 → Q5 → Q8), тем качественнее картинки и тяжелее модель. Размер — без текстового кодировщика и VAE.',
      '★ — the best variant for this PC. The bigger the number in the name (Q4 → Q5 → Q8), the better the images and the heavier the model. Size excludes the text encoder and VAE.')
    : t('★ — лучший вариант для этого ПК. Чем больше число в названии (Q4 → Q5 → Q8), тем умнее и тяжелее модель. Размер указан вместе с модулем зрения.',
      '★ — the best variant for this PC. The bigger the number in the name (Q4 → Q5 → Q8), the smarter and heavier the model. Size includes the vision module.')));
  const wrap = el('div'); wrap.style.overflowX = 'auto';
  const table = el('table', 'qtable');
  const hr = el('tr'); [t('Вариант', 'Variant'), t('Размер', 'Size'), t('На этом ПК', 'On this PC'), ''].forEach((h) => hr.appendChild(el('th', '', h)));
  table.appendChild(hr);
  for (const q of d.quants) {
    const tr = el('tr', q.key === d.recommendedQuant ? 'rec' : '');
    const size = fmtGB(q.bytes) + (q.parts > 1 ? t(` · ${q.parts} файла`, ` · ${q.parts} files`) : '');
    const fitTd = el('td'); fitTd.appendChild(fitBadge(q.fit));
    const act = el('td');
    if (q.installed) act.appendChild(el('span', 'badge', t('установлена', 'installed')));
    else {
      const b = el('button', 'btn small' + (q.key === d.recommendedQuant ? ' primary' : ''), image ? t('Скачать для ComfyUI', 'Download for ComfyUI') : t('Скачать', 'Download'));
      b.disabled = q.fit.level === 'no';
      b.onclick = async () => {
        b.disabled = true; b.textContent = t('В очереди', 'Queued');
        const r = await fetch('/api/model/install', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1' }, body: JSON.stringify({ repo: d.repo, quant: q.key }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); b.textContent = t('Ошибка', 'Error'); confirmBox(t('Не удалось скачать', 'Download failed'), j.error || t('Неизвестная ошибка', 'Unknown error'), t('Понятно', 'OK')); }
      };
      act.appendChild(b);
    }
    tr.append(el('td', '', q.key), el('td', '', size), fitTd, act);
    table.appendChild(tr);
  }
  wrap.appendChild(table);
  box.appendChild(wrap);
}

document.querySelectorAll('#cat-mode button').forEach((b) => b.addEventListener('click', () => {
  catMode = b.dataset.mode;
  detailRepo = null;
  document.querySelectorAll('#cat-mode button').forEach((x) => x.classList.toggle('on', x === b));
  $('cat-search').hidden = catMode !== 'search';
  // The search tab opens with the most downloaded GGUF models, so filters work right away.
  if (catMode === 'rec') showRecommended(); else { if (searchPager) showSearch(); else doSearch(''); $('cat-q').focus(); }
}));
$('cat-search').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('cat-q').value.trim()); });
function catPlaceholder() { $('cat-q').placeholder = t('Название модели или пусто — самые популярные', 'Model name, or empty for the most popular'); }
catPlaceholder();
// Language switch: the picks carry server-side notes, so they are fetched again.
langHooks.push(() => {
  catPlaceholder();
  recCache = null;
  if (detailRepo) openDetail(detailRepo);
  else if (catMode === 'rec') { if ($('tab-model').classList.contains('active')) showRecommended(); }
  else showSearch();
});

// ---------------------------------------------------------------- ComfyUI
async function installComfy() {
  const plan = state.comfy && state.comfy.plan;
  const size = plan ? fmtGB(plan.bytes) : t('2 ГБ', '2 GB');
  const build = plan ? plan.label : t('вашей видеокарты', 'your GPU');
  const text = t(`Скачать и установить ComfyUI ${plan ? plan.version : ''} (≈ ${size}, на диске займёт ≈ 6 ГБ) в папку tools\\comfyui? Сборка — для «${build}», с дополнением ComfyUI-GGUF для моделей из каталога.`,
    `Download and install ComfyUI ${plan ? plan.version : ''} (≈ ${size}, ≈ 6 GB on disk) into tools\\comfyui? The build is for "${build}", with the ComfyUI-GGUF extension for catalog models.`) +
    (plan && plan.cpu ? t(' На этом ПК нет подходящей видеокарты: ComfyUI будет считать на процессоре — одна картинка может занимать десятки минут.',
      ' This PC has no suitable GPU: ComfyUI will run on the CPU — one image may take tens of minutes.') : '');
  if (await confirmBox(t('Установка ComfyUI', 'Install ComfyUI'), text, t('Установить', 'Install'))) post('comfy/install');
}

function renderComfy(s) {
  const c = s.comfy;
  if (!c) return;
  const images = s.models.installed.filter((m) => m.image && m.status === 'installed').length;
  const st = {
    installing: [c.step || t('Установка…', 'Installing…'), 'busy', 'busy'],
    starting: [t('Запускается… ', 'Starting… ') + fmtDur((Date.now() - c.since) / 1000), 'busy', 'busy'],
    on: [t('Работает · 127.0.0.1:', 'Running · 127.0.0.1:') + c.port, 'on', 'on'],
    stopping: [t('Останавливается…', 'Stopping…'), 'busy', 'busy'],
    error: [c.installed ? t('Сбой ComfyUI', 'ComfyUI failure') : t('Установка не удалась', 'Installation failed'), 'err', 'err'],
  }[c.status] || [c.installed ? t('Установлен · не запущен', 'Installed · not running') : t('Не установлен', 'Not installed'), 'off', ''];
  setStatus('c-status', st[0], st[1]); setLed('c-led', st[2]);
  $('c-uptime').textContent = c.status === 'on' ? t('работает ', 'up ') + fmtDur((Date.now() - c.since) / 1000) : '';
  const installing = c.status === 'installing';
  $('c-bar').hidden = !(installing && c.total);
  if (installing && c.total) $('c-bar-i').style.width = Math.min(100, (100 * c.done) / c.total) + '%';
  $('c-hint').textContent = installing
    ? (c.total ? `${fmtGB(c.done)} ${t('из', 'of')} ${fmtGB(c.total)}` + (c.speed ? ` · ${dec((c.speed / 1048576).toFixed(1))} ${t('МБ/с', 'MB/s')} · ${t('осталось', 'left')} ${fmtDur((c.total - c.done) / c.speed)}` : '') : '')
    : c.installed
      ? t(`ComfyUI ${c.version || ''} · ${c.variant || ''}. Моделей для картинок: ${images}. Готовые workflow — в меню Workflows слева; для других моделей: Workflow → Browse Templates.`,
        `ComfyUI ${c.version || ''} · ${c.variant || ''}. Image models: ${images}. Ready workflows are in the Workflows menu on the left; for other models: Workflow → Browse Templates.`)
      : t(`Рисует картинки и видео моделями из каталога (метка «картинки · ComfyUI»). Установка — одной кнопкой: ≈ ${fmtGB(c.plan.bytes)}, сборка для «${c.plan.label}».`,
        `Draws images and video with catalog models (the "images · ComfyUI" tag). One-click install: ≈ ${fmtGB(c.plan.bytes)}, the "${c.plan.label}" build.`);
  $('c-error').hidden = !(c.status === 'error' && c.error);
  $('c-error').textContent = c.error || '';
  const running = ['starting', 'on'].includes(c.status);
  $('c-install').hidden = c.installed;
  $('c-install').disabled = c.busy;
  $('c-start').hidden = !c.installed;
  $('c-start').disabled = c.busy || c.status === 'starting' || c.status === 'stopping';
  $('c-start').textContent = c.status === 'on' ? t('Открыть окно', 'Open window') : t('Открыть ComfyUI', 'Open ComfyUI');
  $('c-stop').hidden = !c.installed;
  $('c-stop').disabled = !running;
  $('c-output').hidden = !c.installed;
  $('c-delete').hidden = !c.installed;
  $('c-delete').disabled = c.busy;
}
$('c-install').onclick = () => installComfy();
$('c-start').onclick = () => post(state.comfy && state.comfy.status === 'on' ? 'comfy/open' : 'comfy/start');
$('c-stop').onclick = () => post('comfy/stop');
$('c-output').onclick = () => post('comfy/folder', { what: 'output' });
$('c-delete').onclick = async () => {
  if (await confirmBox(t('Удаление ComfyUI', 'Delete ComfyUI'), t('Удалить ComfyUI (папку tools\\comfyui)? Готовые картинки и скачанные модели останутся — модели можно удалить в списке моделей.',
    'Delete ComfyUI (the tools\\comfyui folder)? Finished images and downloaded models stay — models can be deleted in the model list.'), t('Удалить', 'Delete'))) post('comfy/delete');
};

// ---------------------------------------------------------------- actions
$('qm-select').onchange = (e) => { selectedId = e.target.value; chosenCtx = null; render(state); };
for (const id of ['qm-start', 'm-start']) $(id).onclick = () => selectedId && post('model/start', { id: selectedId, ctx: chosenCtx });
for (const id of ['qm-stop', 'm-stop']) $(id).onclick = () => post('model/stop');
$('m-chat').onclick = () => post('model/chat');
