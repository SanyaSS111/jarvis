'use strict';
// Home panel 05: the Telegram bot (token, pairing, start/stop, autostart). Uses helpers from app.js.

async function tgPost(action, body = {}) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'ошибка'); }
}

function renderTelegram(s) {
  const t = s.telegram;
  if (!t) return;
  $('tg-setup').hidden = t.configured;
  $('tg-main').hidden = !t.configured;
  const conn = { on: 'на связи', connecting: 'подключается…', error: 'нет связи с Telegram' }[t.telegram] || '';
  const st = t.busy ? [t.busy, 'busy', 'busy']
    : !t.configured ? ['Не подключён', 'off', '']
    : t.running ? [`@${t.bot ? t.bot.username : '…'} · ${conn}`, t.telegram === 'on' ? 'on' : t.telegram === 'error' ? 'err' : 'busy', t.telegram === 'on' ? 'on' : t.telegram === 'error' ? 'err' : 'busy']
    : [`@${t.bot ? t.bot.username : '…'} · выключен`, 'off', ''];
  setStatus('tg-status', st[0], st[1]); setLed('tg-led', st[2]);
  $('tg-sub').textContent = t.running && t.agent === 'on' ? 'агент активен' : '';
  $('tg-error').hidden = !(t.running && t.error && t.telegram === 'error');
  $('tg-error').textContent = t.error || '';

  const pairBox = $('tg-pair');
  pairBox.hidden = !t.pair;
  if (t.pair) {
    const left = Math.max(0, Math.round((t.pair.until - Date.now()) / 1000));
    once(pairBox, t.pair.code + '|' + Math.floor(left / 10), (b) => {
      b.append('Откройте бота ', el('b', '', '@' + (t.bot ? t.bot.username : '')), ' в Telegram на телефоне и отправьте: ');
      b.appendChild(el('code', 'tg-code', '/start ' + t.pair.code));
      b.append(` — код действует ещё ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}.` + (t.running ? '' : ' Бот должен быть запущен.'));
    });
  }
  once($('tg-users'), JSON.stringify(t.users), (box) => {
    if (!t.users.length) { box.appendChild(el('li', 'muted small', 'Пока никто не привязан — нажмите «Привязать телефон».')); return; }
    for (const u of t.users) {
      const li = el('li');
      li.append(el('span', '', '📱 ' + (u.name || 'без имени') + (u.username ? ` (@${u.username})` : '')));
      const x = el('button', 'btn small ghost', 'Отвязать');
      x.onclick = async () => { if (await confirmBox('Отвязать телефон', `Закрыть доступ к агенту для ${u.name || u.id}?`, 'Отвязать')) tgPost('tg/unpair', { id: u.id }).catch(() => {}); };
      li.appendChild(x);
      box.appendChild(li);
    }
  });
  const auto = $('tg-auto');
  if (document.activeElement !== auto) auto.checked = !!t.autostart;
  $('tg-start').hidden = t.running;
  $('tg-stop').hidden = !t.running;
  $('tg-start').disabled = !!t.busy;
}

$('tg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('tg-token');
  const btn = $('tg-save');
  btn.disabled = true; btn.textContent = 'Проверяю…';
  try { await tgPost('tg/token', { token: input.value.trim() }); input.value = ''; }
  catch (err) { confirmBox('Не получилось подключить бота', err.message, 'Понятно'); }
  finally { btn.disabled = false; btn.textContent = 'Подключить'; }
});
$('tg-start').onclick = () => tgPost('tg/start').catch((e) => confirmBox('Бот не запустился', e.message, 'Понятно'));
$('tg-stop').onclick = () => tgPost('tg/stop').catch(() => {});
$('tg-pair-btn').onclick = async () => {
  try { await tgPost('tg/pair'); if (!state.telegram.running) await tgPost('tg/start'); }
  catch (e) { confirmBox('Привязка', e.message, 'Понятно'); }
};
$('tg-auto').onchange = (e) => tgPost('tg/autostart', { on: e.target.checked }).catch(() => {});
$('tg-forget').onclick = async () => {
  if (await confirmBox('Сменить бота', 'Отключить этого бота от лаунчера? Токен удалится с ПК, привязанные телефоны тоже. Потом можно подключить другого бота.', 'Отключить')) tgPost('tg/forget').catch(() => {});
};
