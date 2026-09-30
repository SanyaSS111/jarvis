'use strict';
// Models tab + the home "local model" panel: installed models, launching, and the Hugging Face catalog.
// Uses helpers from app.js ($, el, post, fmtGB, fmtDur, setLed, setStatus, confirmBox, state, render).

const FIT = { fast: 'Быстро', ok: 'Нормально', slow: 'Медленно', no: 'Не влезет' };
const FIT_HINT = {
  fast: 'целиком в видеокарте',
  ok: 'часть в оперативной памяти',
  slow: 'в основном в оперативной памяти — ответы будут медленными',
  no: 'не хватит памяти этого ПК',
};
const kLabel = (ctx) => Math.round(ctx / 1024) + 'K';
const paramsLabel = (p) => (p ? (p >= 1e10 ? Math.round(p / 1e9) : (p / 1e9).toFixed(1).replace('.', ',')) + 'B' : '');
const fmtCount = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace('.', ',') + ' млн' : n >= 1e3 ? Math.round(n / 1e3) + ' тыс.' : String(n));

let selectedId = null;
let chosenCtx = null;

function fitBadge(fit) {
  const b = el('span', 'fit ' + fit.level, FIT[fit.level]);
  b.title = `${FIT_HINT[fit.level]} · нужно ≈ ${String(fit.needGB).replace('.', ',')} ГБ`;
  return b;
}
function badges(m) {
  const out = [];
  if (m.kind === 'image' || m.kind === 'video') {
    const b = el('span', 'badge img', m.kind === 'video' ? 'видео · ComfyUI' : 'картинки · ComfyUI');
    b.title = 'Генерирует ' + (m.kind === 'video' ? 'видео' : 'изображения') + ' — работает в ComfyUI, не в агенте';
    out.push(b);
  }
  if (m.moe) out.push(el('span', 'badge plain', 'MoE'));
  if (m.vision) out.push(el('span', 'badge', 'видит картинки'));
  if (m.tools) out.push(el('span', 'badge', 'инструменты агента'));
  if (m.tools === false) out.push(el('span', 'badge plain', 'без инструментов'));
  if (m.uncensored) out.push(el('span', 'badge plain', 'без цензуры'));
  if (m.coder) out.push(el('span', 'badge plain', 'для кода'));
  return out;
}

// ---------------------------------------------------------------- catalog filters
const FILTER_LABELS = { fits: 'влезает в этот ПК', vision: 'видит картинки', uncensored: 'без цензуры', tools: 'инструменты агента', coder: 'для кода', moe: 'MoE', image: 'картинки (ComfyUI)' };
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
  list.prepend(el('div', 'muted small', `Показано ${shown} из ${total} · фильтр: ${[...filters].map((f) => FILTER_LABELS[f]).join(', ')}`));
}
function syncChips() {
  document.querySelectorAll('#cat-filters button').forEach((b) => b.classList.toggle('on', filters.has(b.dataset.f)));
}
document.querySelectorAll('#cat-filters button').forEach((b) => b.addEventListener('click', () => {
  if (filters.has(b.dataset.f)) filters.delete(b.dataset.f); else filters.add(b.dataset.f);
  try { localStorage.setItem('jarvis-cat-filters', JSON.stringify([...filters])); } catch {}
  syncChips();
  if (!$('cat-detail').hidden) return; // keep an open model card; the list refreshes on "Назад"
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
  $('hw-gpu').textContent = hw.gpu ? hw.gpu.name : 'нет дискретной';
  $('hw-vram').textContent = hw.gpu ? `${(hw.gpu.vramMB / 1024).toFixed(0)} ГБ` : '—';
  $('hw-ram').textContent = `${Math.round(hw.ramMB / 1024)} ГБ`;
  $('hw-cpu').textContent = `${hw.threads} потоков`;
  $('hw-cpu').title = hw.cpu;
  const engines = { cuda: 'CUDA (NVIDIA)', vulkan: 'Vulkan', sycl: 'SYCL (Intel)', cpu: 'только процессор', none: 'не установлен' };
  $('hw-engine').textContent = engines[hw.engine] || hw.engine;
  $('hw-disk').textContent = fmtGB(s.sys.diskFree);
  const note = $('hw-note');
  if (hw.engine === 'none') { note.hidden = false; note.textContent = 'Движок llama.cpp не установлен — локальные модели запустить не получится.'; }
  else if (hw.gpu && !hw.vramMB) { note.hidden = false; note.textContent = `Установленный движок (${engines[hw.engine]}) не использует видеокарту ${hw.gpu.name} — модели будут считаться на процессоре. Для неё нужен движок ${engines[hw.recommendedEngine]}.`; }
  else note.hidden = true;
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
    loading: [`Загружается: ${name}… ${fmtDur((Date.now() - a.since) / 1000)}`, 'busy', 'busy'],
    on: [`Работает: ${name} · ${kLabel(a.ctx || 0)}`, 'on', 'on'],
    stopping: ['Выгружается…', 'busy', 'busy'],
    error: ['Сбой запуска', 'err', 'err'],
  }[a.status] || [inst.length ? 'Не запущена' : M.installed.some((m) => m.image) ? 'Нет моделей для агента' : 'Нет установленных моделей', 'off', ''];
  for (const id of ['qm', 'm']) { setStatus(id + '-status', st[0], st[1]); setLed(id + '-led', st[2]); }
  $('m-uptime').textContent = a.status === 'on' ? 'работает ' + fmtDur((Date.now() - a.since) / 1000) : '';
  $('qm-ctx').textContent = '';
  $('m-error').hidden = !(a.status === 'error' && a.error);
  $('m-error').textContent = a.error || '';

  ctxSeg($('qm-seg'), ctxs);
  ctxSeg($('m-seg'), ctxs);
  const select = $('qm-select');
  once(select, inst.map((m) => m.id).join('|'), (b) => {
    if (!inst.length) b.appendChild(el('option', '', 'Нет установленных моделей'));
    for (const m of inst) { const o = el('option', '', `${m.title} · ${m.quant}`); o.value = m.id; b.appendChild(o); }
  });
  if (sel && select.value !== sel.id && document.activeElement !== select) select.value = sel.id;
  select.disabled = !inst.length;

  const restart = running && (a.id !== selectedId || a.ctx !== chosenCtx);
  for (const id of ['qm-start', 'm-start']) {
    const b = $(id);
    b.textContent = restart ? `Перезапустить · ${kLabel(chosenCtx)}` : `Запустить · ${kLabel(chosenCtx)}`;
    b.disabled = !sel || a.status === 'stopping' || (running && !restart);
  }
  $('qm-stop').disabled = $('m-stop').disabled = !running;
  $('m-chat').disabled = a.status !== 'on';
  $('qm-hint').textContent = !sel ? 'Установите модель на вкладке «Модели» — там подборка и поиск по Hugging Face.'
    : `${sel.title} · ${sel.quant}. В агенте выберите её в группе «Локально» и «Лёгкий режим».`;

  const freeRam = s.sys.ramTotal - s.sys.ramUsed;
  const note = $('mem-note');
  if (!running && sel && sel.fit && sel.fit.level !== 'fast' && freeRam < sel.fit.needGB * GB * 0.8) {
    const heavy = s.sys.heavy.filter((p) => !/^(llama-server|Memory Compression|System|MsMpEng|dwm|explorer)$/i.test(p.name)).slice(0, 3)
      .map((p) => `${p.name} — ${(p.mb / 1024).toFixed(1).replace('.', ',')} ГБ`).join(', ');
    note.hidden = false;
    note.textContent = `Свободно ${fmtGB(freeRam)} ОЗУ, а модели нужно около ${String(sel.fit.needGB).replace('.', ',')} ГБ. Закройте тяжёлые программы (${heavy}), иначе ответы будут идти медленно.`;
  } else note.hidden = true;

  renderInstalled(M);
}

function renderInstalled(M) {
  const job = M.job;
  const pct = (m) => Math.floor((100 * m.done) / Math.max(1, m.bytes));
  const sig = JSON.stringify([selectedId, M.active.id, M.active.status, state.comfy && state.comfy.installed, M.installed.map((m) => [m.id, m.status, pct(m), m.error, m.fit && m.fit.level]),
    job && [job.phase, Math.round(job.speed / 1e5), Math.floor((100 * job.verifyDone) / Math.max(1, job.verifyTotal))]]);
  once($('inst-list'), sig, (box) => {
    if (!M.installed.length) { box.appendChild(el('li', 'empty', 'Пока нет ни одной модели. Выберите подходящую в каталоге справа.')); return; }
    for (const m of M.installed) {
      const li = el('li', 'inst' + (m.id === selectedId ? ' sel' : ''));
      const t = el('div', 't', m.title); t.appendChild(el('small', '', m.quant));
      const acts = el('div', 'acts');
      const btn = (label, cls, fn) => { const b = el('button', 'btn small ' + cls, label); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
      const meta = el('div', 'meta');
      meta.appendChild(el('span', '', fmtGB(m.bytes)));
      if (m.status === 'installed') {
        if (m.fit) meta.appendChild(fitBadge(m.fit));
        if (M.active.id === m.id && ['loading', 'on'].includes(M.active.status)) meta.appendChild(el('span', 'badge', M.active.status === 'on' ? '● запущена' : '● загружается'));
        if (m.image) {
          if (state.comfy && state.comfy.installed) btn('Открыть в ComfyUI', 'primary', () => post('comfy/start'));
          else btn('Установить ComfyUI', 'primary', () => installComfy());
        } else li.onclick = () => { selectedId = m.id; chosenCtx = null; render(state); };
        btn('Удалить', 'danger', () => removeModel(m));
      } else {
        const isJob = job && job.id === m.id;
        let status = { queued: 'в очереди', paused: 'пауза', error: 'ошибка', downloading: 'скачивается' }[m.status] || m.status;
        if (isJob && job.phase === 'verify') status = `проверка целостности ${Math.floor((100 * job.verifyDone) / Math.max(1, job.verifyTotal))}%`;
        else if (isJob && job.phase === 'wait') status = job.message;
        else if (m.status === 'downloading' || m.status === 'paused' || m.status === 'queued') status += ` · ${pct(m)}%`;
        if (isJob && job.phase === 'download' && job.speed) status += ` · ${(job.speed / 1048576).toFixed(1).replace('.', ',')} МБ/с · осталось ${fmtDur((m.bytes - m.done) / job.speed)}`;
        meta.appendChild(el('span', '', status));
        if (m.status === 'downloading' || m.status === 'queued') btn('Пауза', '', () => post('model/pause', { id: m.id }));
        else btn('Продолжить', 'primary', () => post('model/resume', { id: m.id }));
        btn('Отменить', 'danger', () => removeModel(m, true));
      }
      badges(m).forEach((b) => meta.appendChild(b));
      li.append(t, acts, meta);
      if (m.status !== 'installed') {
        const bar = el('div', 'bar'); const i = el('i', m.status === 'downloading' ? 'active' : ''); i.style.width = pct(m) + '%'; bar.appendChild(i); li.appendChild(bar);
      }
      if (m.error) li.appendChild(el('div', 'err', m.error));
      box.appendChild(li);
    }
  });
}

async function removeModel(m, cancel) {
  const text = cancel ? `Отменить загрузку «${m.title} · ${m.quant}» и удалить уже скачанное?`
    : `Удалить «${m.title} · ${m.quant}» и освободить ${fmtGB(m.bytes)}? Скачать её можно будет снова из каталога.`;
  if (await confirmBox(cancel ? 'Отмена загрузки' : 'Удаление модели', text, cancel ? 'Отменить загрузку' : 'Удалить')) post('model/delete', { id: m.id });
}

// ---------------------------------------------------------------- catalog
let catMode = 'rec';
let recCache = null;
// A paged Hugging Face listing: {query, items, next, started, loading, scanned}.
const pager = (query) => ({ query, items: [], next: null, started: false, loading: false, scanned: 0 });
let searchPager = null;         // "Поиск" tab
let popularPager = pager('');   // continuation of "Подборка": the most downloaded GGUF models

async function getJson(url) {
  const r = await fetch(url);
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'ошибка');
  return j;
}
function catLoading(text) { const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.innerHTML = ''; list.appendChild(el('div', 'loading', text)); }
function catError(e) { const list = $('cat-list'); list.innerHTML = ''; list.appendChild(el('div', 'empty', 'Не удалось связаться с Hugging Face: ' + e.message)); }

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
    b.title = 'Примерно, для 4-битного варианта. Точно по каждому варианту — в карточке модели. ' + b.title;
    right.appendChild(b);
  }
  const meta = el('div', 'meta');
  if (r.params) meta.appendChild(el('span', '', paramsLabel(r.params)));
  meta.append(el('span', '', `⬇ ${fmtCount(r.downloads)}`), el('span', '', `♥ ${fmtCount(r.likes)}`));
  badges(r).forEach((b) => meta.appendChild(b));
  if (r.gated) meta.appendChild(el('span', 'badge plain', 'нужен вход'));
  card.append(el('div', 't', r.repo), right, meta);
  card.onclick = () => openDetail(r.repo);
  return card;
}

// "Показать ещё" at the bottom of a list; re-renders the current view when the page arrives.
function moreButton(list, p, redraw, skip) {
  if (p.started && !p.next) {
    list.appendChild(el('div', 'muted small end', `Это все модели на Hugging Face${p.query ? ` по запросу «${p.query}»` : ''} — просмотрено ${p.scanned}.`));
    return;
  }
  const b = el('button', 'btn wide more', p.loading ? 'Загружаю…' : p.started ? 'Показать ещё' : 'Показать ещё модели с Hugging Face');
  b.disabled = p.loading;
  b.onclick = async () => {
    b.disabled = true; b.textContent = filters.size ? 'Ищу подходящие под фильтры…' : 'Загружаю…';
    const before = p.items.length;
    try { await loadMore(p, 10, skip); } catch (e) { b.disabled = false; b.textContent = 'Ошибка — попробовать снова'; return; }
    const scrollTop = $('cat-list').closest('.panel-body').scrollTop;
    redraw();
    $('cat-list').closest('.panel-body').scrollTop = scrollTop;
    if (p.items.length === before && p.next) b.textContent = 'Показать ещё';
  };
  list.appendChild(b);
}

async function showRecommended() {
  if (!recCache) {
    catLoading('Загружаю подборку…');
    try { recCache = await getJson('/api/catalog/recommended'); } catch (e) { return catError(e); }
  }
  const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.textContent = '';
  const shown = recCache.filter((m) => passes(m, !!m.recommendedQuant));
  for (const m of shown) {
    const q = m.quants.find((x) => x.key === m.recommendedQuant);
    const card = el('button', 'cat');
    const t = el('div', 't', m.title);
    const right = el('div');
    if (q) right.appendChild(fitBadge(q.fit)); else right.appendChild(el('span', 'fit no', FIT.no));
    const meta = el('div', 'meta');
    if (m.params) meta.appendChild(el('span', '', paramsLabel(m.params)));
    if (q) meta.appendChild(el('span', '', `лучший вариант: ${q.key} · ${fmtGB(q.bytes)}`));
    badges(m).forEach((b) => meta.appendChild(b));
    card.append(t, right, el('div', 'n', m.note), meta);
    card.onclick = () => openDetail(m.repo);
    list.appendChild(card);
  }
  filterNote(list, shown.length, recCache.length);
  // Beyond the picks: popular GGUF models, loaded on demand.
  const skip = new Set(recCache.map((m) => m.repo));
  const popular = popularPager.items.filter((r) => passes(r, fitsApprox(r)));
  if (popularPager.started) {
    list.appendChild(el('h3', 'sep', `Популярные на Hugging Face · ${popular.length}`));
    if (!popular.length) list.appendChild(el('div', 'empty', 'Среди просмотренных моделей нет подходящих под фильтры — нажмите «Показать ещё».'));
    popular.forEach((r) => list.appendChild(resultCard(r)));
  }
  moreButton(list, popularPager, showRecommended, skip);
}

async function doSearch(q) {
  catLoading('Ищу на Hugging Face…');
  searchPager = pager(q);
  try { await loadMore(searchPager, 15); } catch (e) { return catError(e); }
  showSearch();
}
function showSearch() {
  const list = $('cat-list'); list.hidden = false; $('cat-detail').hidden = true; list.textContent = '';
  if (!searchPager) { list.appendChild(el('div', 'empty', 'Введите название модели — например qwen, gemma, llama, coder или uncensored.')); return; }
  if (!searchPager.items.length) { list.appendChild(el('div', 'empty', 'Ничего не нашлось. Попробуйте другое название.')); return; }
  const shown = searchPager.items.filter((r) => passes(r, fitsApprox(r)));
  if (!shown.length && filters.size) list.appendChild(el('div', 'empty', 'Среди просмотренных моделей нет подходящих под фильтры — нажмите «Показать ещё».'));
  shown.forEach((r) => list.appendChild(resultCard(r)));
  filterNote(list, shown.length, searchPager.items.length);
  moreButton(list, searchPager, showSearch);
}
async function openDetail(repo) {
  const box = $('cat-detail');
  $('cat-list').hidden = true; box.hidden = false; box.textContent = '';
  box.appendChild(el('div', 'loading', 'Читаю список файлов модели…'));
  let d;
  try { d = await getJson('/api/catalog/details?repo=' + encodeURIComponent(repo)); } catch (e) { box.textContent = ''; box.appendChild(el('div', 'empty', 'Не удалось загрузить: ' + e.message)); }
  box.textContent = '';
  const back = el('button', 'btn small ghost', '← Назад');
  back.onclick = () => (catMode === 'rec' ? showRecommended() : showSearch());
  box.appendChild(back);
  if (!d) return;
  const head = el('div', 'head'); head.append(el('b', '', d.title), el('span', 'muted', d.author));
  box.appendChild(head);
  const facts = el('div', 'meta');
  facts.className = 'cat-facts muted small';
  facts.textContent = [d.params && `${paramsLabel(d.params)} параметров`, d.arch && `архитектура ${d.arch}`,
    d.ctxMax && `контекст до ${kLabel(d.ctxMax)}`, `⬇ ${fmtCount(d.downloads)}`].filter(Boolean).join(' · ');
  box.appendChild(facts);
  const bl = el('div', 'btn-row'); badges(d).forEach((b) => bl.appendChild(b)); box.appendChild(bl);
  const image = d.kind === 'image' || d.kind === 'video';
  if (image) {
    const what = d.kind === 'video' ? 'видео' : 'картинок';
    const w = el('div', 'note warn');
    w.appendChild(el('b', '', `Это модель для генерации ${what}, а не для общения.`));
    w.appendChild(document.createTextNode(` Агент и движок llama.cpp её не запустят — она работает в ComfyUI. Лаунчер скачает её в папку ComfyUI` +
      (d.extraBytes ? ` вместе с нужными файлами (${[d.companions.text_encoders && `текстовый кодировщик ${fmtGB(d.companions.text_encoders.size)}`,
        d.companions.vae && `VAE ${fmtGB(d.companions.vae.size)}`].filter(Boolean).join(', ')}; уже скачанные повторно не качаются).` : '.')));
    box.appendChild(w);
    if (!d.companions || !d.companions.text_encoders || !d.companions.vae) {
      box.appendChild(el('div', 'note warn', 'В этом репозитории нет ' + [!(d.companions && d.companions.text_encoders) && 'текстового кодировщика',
        !(d.companions && d.companions.vae) && 'VAE'].filter(Boolean).join(' и ') +
        ' — их придётся скачать отдельно (ссылки обычно в описании модели на Hugging Face) и положить в папку моделей ComfyUI.'));
    }
    const te = d.companions && d.companions.text_encoders;
    if (te && state.hw && te.size > state.hw.ramMB * 1048576 * 0.6) {
      box.appendChild(el('div', 'note warn', `Текстовому кодировщику нужно ≈ ${fmtGB(te.size)} оперативной памяти, а на этом ПК всего ${Math.round(state.hw.ramMB / 1024)} ГБ — перед генерацией закройте тяжёлые программы.`));
    }
    if (!state.comfy || !state.comfy.installed) {
      const c = el('div', 'note');
      const plan = state.comfy && state.comfy.plan;
      c.appendChild(document.createTextNode('ComfyUI ещё не установлен. ' + (plan ? `Лаунчер поставит его сам: сборка для «${plan.label}», ≈ ${fmtGB(plan.bytes)}. ` : '')));
      const b = el('button', 'btn small primary', 'Установить ComfyUI');
      b.onclick = () => { b.disabled = true; installComfy(); };
      c.appendChild(b);
      box.appendChild(c);
    }
  }
  if (d.tools === false) box.appendChild(el('div', 'note warn', 'Шаблон этой модели не поддерживает инструменты — в агенте она сможет только отвечать текстом, без действий.'));
  if (d.gated) { box.appendChild(el('div', 'note warn', 'Модель закрыта: чтобы скачать её, нужен вход на Hugging Face. Из лаунчера её не скачать.')); return; }
  if (!d.quants.length) { box.appendChild(el('div', 'empty', 'В этом репозитории нет файлов GGUF — llama.cpp не сможет её запустить.')); return; }
  box.appendChild(el('p', 'muted small', image
    ? '★ — лучший вариант для этого ПК. Чем больше число в названии (Q4 → Q5 → Q8), тем качественнее картинки и тяжелее модель. Размер — без текстового кодировщика и VAE.'
    : '★ — лучший вариант для этого ПК. Чем больше число в названии (Q4 → Q5 → Q8), тем умнее и тяжелее модель. Размер указан вместе с модулем зрения.'));
  const wrap = el('div'); wrap.style.overflowX = 'auto';
  const table = el('table', 'qtable');
  const hr = el('tr'); ['Вариант', 'Размер', 'На этом ПК', ''].forEach((h) => hr.appendChild(el('th', '', h)));
  table.appendChild(hr);
  for (const q of d.quants) {
    const tr = el('tr', q.key === d.recommendedQuant ? 'rec' : '');
    const size = fmtGB(q.bytes) + (q.parts > 1 ? ` · ${q.parts} файла` : '');
    const fitTd = el('td'); fitTd.appendChild(fitBadge(q.fit));
    const act = el('td');
    if (q.installed) act.appendChild(el('span', 'badge', 'установлена'));
    else {
      const b = el('button', 'btn small' + (q.key === d.recommendedQuant ? ' primary' : ''), image ? 'Скачать для ComfyUI' : 'Скачать');
      b.disabled = q.fit.level === 'no';
      b.onclick = async () => {
        b.disabled = true; b.textContent = 'В очереди';
        const r = await fetch('/api/model/install', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1' }, body: JSON.stringify({ repo: d.repo, quant: q.key }) });
        if (!r.ok) { const j = await r.json().catch(() => ({})); b.textContent = 'Ошибка'; confirmBox('Не удалось скачать', j.error || 'Неизвестная ошибка', 'Понятно'); }
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
  document.querySelectorAll('#cat-mode button').forEach((x) => x.classList.toggle('on', x === b));
  $('cat-search').hidden = catMode !== 'search';
  // The search tab opens with the most downloaded GGUF models, so filters work right away.
  if (catMode === 'rec') showRecommended(); else { if (searchPager) showSearch(); else doSearch(''); $('cat-q').focus(); }
}));
$('cat-search').addEventListener('submit', (e) => { e.preventDefault(); doSearch($('cat-q').value.trim()); });
$('cat-q').placeholder = 'Название модели или пусто — самые популярные';

// ---------------------------------------------------------------- ComfyUI
async function installComfy() {
  const plan = state.comfy && state.comfy.plan;
  const text = `Скачать и установить ComfyUI ${plan ? plan.version : ''} (≈ ${plan ? fmtGB(plan.bytes) : '2 ГБ'}, на диске займёт ≈ 6 ГБ) в папку tools\\comfyui? ` +
    `Сборка — для «${plan ? plan.label : 'вашей видеокарты'}», с дополнением ComfyUI-GGUF для моделей из каталога.` +
    (plan && plan.cpu ? ' На этом ПК нет подходящей видеокарты: ComfyUI будет считать на процессоре — одна картинка может занимать десятки минут.' : '');
  if (await confirmBox('Установка ComfyUI', text, 'Установить')) post('comfy/install');
}

function renderComfy(s) {
  const c = s.comfy;
  if (!c) return;
  const images = s.models.installed.filter((m) => m.image && m.status === 'installed').length;
  const st = {
    installing: [c.step || 'Установка…', 'busy', 'busy'],
    starting: [`Запускается… ${fmtDur((Date.now() - c.since) / 1000)}`, 'busy', 'busy'],
    on: ['Работает · 127.0.0.1:' + c.port, 'on', 'on'],
    stopping: ['Останавливается…', 'busy', 'busy'],
    error: [c.installed ? 'Сбой ComfyUI' : 'Установка не удалась', 'err', 'err'],
  }[c.status] || [c.installed ? 'Установлен · не запущен' : 'Не установлен', 'off', ''];
  setStatus('c-status', st[0], st[1]); setLed('c-led', st[2]);
  $('c-uptime').textContent = c.status === 'on' ? 'работает ' + fmtDur((Date.now() - c.since) / 1000) : '';
  const installing = c.status === 'installing';
  $('c-bar').hidden = !(installing && c.total);
  if (installing && c.total) $('c-bar-i').style.width = Math.min(100, (100 * c.done) / c.total) + '%';
  $('c-hint').textContent = installing
    ? (c.total ? `${fmtGB(c.done)} из ${fmtGB(c.total)}` + (c.speed ? ` · ${(c.speed / 1048576).toFixed(1).replace('.', ',')} МБ/с · осталось ${fmtDur((c.total - c.done) / c.speed)}` : '') : '')
    : c.installed
      ? `ComfyUI ${c.version || ''} · ${c.variant || ''}. Моделей для картинок: ${images}. Готовые workflow — в меню Workflows слева; для других моделей: Workflow → Browse Templates.`
      : `Рисует картинки и видео моделями из каталога (метка «картинки · ComfyUI»). Установка — одной кнопкой: ≈ ${fmtGB(c.plan.bytes)}, сборка для «${c.plan.label}».`;
  $('c-error').hidden = !(c.status === 'error' && c.error);
  $('c-error').textContent = c.error || '';
  const running = ['starting', 'on'].includes(c.status);
  $('c-install').hidden = c.installed;
  $('c-install').disabled = c.busy;
  $('c-start').hidden = !c.installed;
  $('c-start').disabled = c.busy || c.status === 'starting' || c.status === 'stopping';
  $('c-start').textContent = c.status === 'on' ? 'Открыть окно' : 'Открыть ComfyUI';
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
  if (await confirmBox('Удаление ComfyUI', 'Удалить ComfyUI (папку tools\\comfyui)? Готовые картинки и скачанные модели останутся — модели можно удалить в списке моделей.', 'Удалить')) post('comfy/delete');
};

// ---------------------------------------------------------------- actions
$('qm-select').onchange = (e) => { selectedId = e.target.value; chosenCtx = null; render(state); };
for (const id of ['qm-start', 'm-start']) $(id).onclick = () => selectedId && post('model/start', { id: selectedId, ctx: chosenCtx });
for (const id of ['qm-stop', 'm-stop']) $(id).onclick = () => post('model/stop');
$('m-chat').onclick = () => post('model/chat');
