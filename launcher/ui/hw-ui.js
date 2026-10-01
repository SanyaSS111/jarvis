'use strict';
// "PC configuration changed" card (engines that no longer fit the GPU) and the kept old engines.
// Uses helpers from app.js ($, el, post, t, fmtGB, confirmBox, langHooks).

const ENGINE_NAME = () => ({ cuda: 'CUDA (NVIDIA)', vulkan: 'Vulkan', sycl: 'SYCL (Intel)', cpu: t('процессор', 'CPU') });
const COMFY_NAME = () => ({ nvidia: 'NVIDIA RTX (CUDA 13)', nvidia_cu126: t('NVIDIA GTX / старые карты (CUDA 12.6)', 'NVIDIA GTX / older cards (CUDA 12.6)'),
  amd: 'AMD Radeon (ROCm)', intel: 'Intel Arc' });

// Engines are often tens of megabytes: МБ below a gigabyte.
const fmtSize = (b) => (b >= GB ? fmtGB(b) : Math.max(1, Math.round(b / 1048576)) + t(' МБ', ' MB'));

function hwActionText(a) {
  const size = a.ready ? t(' · уже есть на ПК, без скачивания', ' · already on this PC, no download')
    : a.bytes ? t(` · скачать ${fmtSize(a.bytes)}`, ` · download ${fmtSize(a.bytes)}`)
    : a.kind === 'mode' ? '' : t(' · уже скачан', ' · already downloaded');
  if (a.id === 'llama') {
    const n = ENGINE_NAME();
    return [t('Движок локальных моделей', 'Local model engine'), `${n[a.from] || a.from} → ${n[a.to] || a.to}${size}`];
  }
  if (a.kind === 'mode') {
    const how = a.to === 'cpu' ? t('видеокарта → процессор', 'GPU → CPU') : t('процессор → видеокарта', 'CPU → GPU');
    const why = a.unsupported ? t(' Эта видеокарта не поддерживается сборками ComfyUI (нужна Radeon RX 6000 и новее или Arc) — картинки будут считаться на процессоре, это медленно.',
      ' This GPU is not supported by the ComfyUI builds (needs a Radeon RX 6000 or newer, or an Arc) — images will be drawn on the CPU, which is slow.') : '';
    return ['ComfyUI', how + t(' · без скачивания.', ' · no download.') + why];
  }
  const c = COMFY_NAME();
  const why = a.unsupported ? t(' Видеокарта не поддерживается сборками ComfyUI — режим процессора.', ' The GPU is not supported by the ComfyUI builds — CPU mode.') : '';
  return [t('ComfyUI — новая сборка', 'ComfyUI — new build'), `${c[a.from] || a.from} → ${c[a.to] || a.to}${size}.${why}`];
}

function renderEngines(s) {
  const e = s.engines;
  if (!e) return;
  const box = $('hwup');
  box.hidden = !e.visible;
  renderStashes(e);
  if (!e.visible) return;
  const ch = e.change;
  $('hwup-title').textContent = ch ? t('Конфигурация ПК изменилась', 'PC configuration changed') : t('Движки не подходят к видеокарте', 'The engines do not match your GPU');
  const gpu = (x) => (x && x.gpu ? `${x.gpu}${x.vramGB ? ` · ${x.vramGB} ${t('ГБ', 'GB')}` : ''}` : t('без видеокарты', 'no GPU'));
  $('hwup-change').textContent = ch
    ? t(`Видеокарта: ${gpu(ch.from)} → ${gpu(ch.to)}`, `GPU: ${gpu(ch.from)} → ${gpu(ch.to)}`) + (ch.from.ramGB !== ch.to.ramGB ? t(` · ОЗУ: ${ch.from.ramGB} → ${ch.to.ramGB} ГБ`, ` · RAM: ${ch.from.ramGB} → ${ch.to.ramGB} GB`) : '')
    : t(`Видеокарта: ${gpu(s.hw && s.hw.gpu ? { gpu: s.hw.gpu.name, vramGB: Math.round(s.hw.gpu.vramMB / 1024) } : null)}`, `GPU: ${gpu(s.hw && s.hw.gpu ? { gpu: s.hw.gpu.name, vramGB: Math.round(s.hw.gpu.vramMB / 1024) } : null)}`);
  once($('hwup-list'), JSON.stringify([e.actions, LANG]), (list) => {
    if (!e.actions.length) { list.appendChild(el('li', 'muted', t('Обновлять ничего не нужно — всё установленное подходит к новой конфигурации.', 'Nothing to update — everything installed fits the new configuration.'))); return; }
    for (const a of e.actions) {
      const [head, body] = hwActionText(a);
      const li = el('li'); li.append(el('b', '', head), el('span', '', ' ' + body));
      list.appendChild(li);
    }
  });
  const oldBytes = e.actions.reduce((sum, a) => sum + (a.oldBytes || 0), 0);
  $('hwup-remove-wrap').hidden = !oldBytes || e.busy;
  $('hwup-remove-text').textContent = t(`Удалить старые движки (освободит ${fmtSize(oldBytes)}). Если не удалять — они останутся про запас, и при возврате прежней видеокарты переключение будет мгновенным.`,
    `Delete the old engines (frees ${fmtSize(oldBytes)}). If kept, they stay in reserve and switching back to the previous GPU is instant.`);
  $('hwup-bar').hidden = !(e.busy && e.total);
  if (e.busy && e.total) $('hwup-bar-i').style.width = Math.min(100, (100 * e.done) / e.total) + '%';
  $('hwup-step').textContent = e.busy ? (e.step || t('Обновляю…', 'Updating…')) : '';
  $('hwup-error').hidden = !e.error; $('hwup-error').textContent = e.error || '';
  const has = e.actions.length > 0;
  $('hwup-apply').hidden = !has;
  $('hwup-apply').disabled = e.busy;
  $('hwup-apply').textContent = e.error ? t('Повторить', 'Try again') : t('Обновить', 'Update');
  $('hwup-later').hidden = !has || e.busy;
  $('hwup-later').textContent = t('Не сейчас', 'Not now');
  $('hwup-dismiss').hidden = e.busy;
  $('hwup-dismiss').textContent = has ? t('Не напоминать', "Don't remind me") : t('Понятно', 'OK');
}

function renderStashes(e) {
  const wrap = $('stash-wrap');
  wrap.hidden = !e.stashes.length;
  once($('stash-list'), JSON.stringify([e.stashes, e.busy, LANG]), (list) => {
    for (const s of e.stashes) {
      const name = s.kind === 'llama' ? t('Движок ', 'Engine ') + (ENGINE_NAME()[s.name] || s.name) : 'ComfyUI · ' + (COMFY_NAME()[s.name] || s.name);
      const li = el('li');
      li.append(el('b', '', name), el('small', 'muted', fmtSize(s.bytes)));
      const b = el('button', 'btn small danger', t('Удалить', 'Delete'));
      b.disabled = e.busy;
      b.onclick = async () => {
        if (await confirmBox(t('Удалить запасной движок', 'Delete the kept engine'), t(`Удалить «${name}» и освободить ${fmtSize(s.bytes)}? Если эта видеокарта вернётся, движок скачается заново.`,
          `Delete "${name}" and free ${fmtSize(s.bytes)}? If this GPU comes back, the engine is downloaded again.`), t('Удалить', 'Delete'))) post('hw/stash-delete', { id: s.id });
      };
      li.appendChild(b);
      list.appendChild(li);
    }
  });
}

$('hwup-apply').onclick = () => post('hw/apply', { removeOld: $('hwup-remove').checked });
$('hwup-later').onclick = () => post('hw/later');
$('hwup-dismiss').onclick = () => post('hw/dismiss');
