'use strict';
// Home panel 05: the Telegram bot (token, pairing, start/stop, autostart). Uses helpers from app.js.

async function tgPost(action, body = {}) {
  const r = await fetch('/api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1' }, body: JSON.stringify(body) });
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || t('ошибка', 'error')); }
}

function renderTelegram(s) {
  const g = s.telegram;
  if (!g) return;
  $('tg-setup').hidden = g.configured;
  $('tg-main').hidden = !g.configured;
  const conn = { on: t('на связи', 'connected'), connecting: t('подключается…', 'connecting…'), error: t('нет связи с Telegram', 'no connection to Telegram') }[g.telegram] || '';
  const bot = '@' + (g.bot ? g.bot.username : '…');
  const live = g.telegram === 'on' ? 'on' : g.telegram === 'error' ? 'err' : 'busy';
  const st = g.busy ? [g.busy, 'busy', 'busy']
    : !g.configured ? [t('Не подключён', 'Not connected'), 'off', '']
    : g.running ? [`${bot} · ${conn}`, live, live]
    : [`${bot} · ${t('выключен', 'off')}`, 'off', ''];
  setStatus('tg-status', st[0], st[1]); setLed('tg-led', st[2]);
  $('tg-sub').textContent = g.running && g.agent === 'on' ? t('агент активен', 'agent active') : '';
  $('tg-error').hidden = !(g.running && g.error && g.telegram === 'error');
  $('tg-error').textContent = g.error || '';

  const pairBox = $('tg-pair');
  pairBox.hidden = !g.pair;
  if (g.pair) {
    const left = Math.max(0, Math.round((g.pair.until - Date.now()) / 1000));
    once(pairBox, g.pair.code + '|' + Math.floor(left / 10), (b) => {
      b.append(t('Откройте бота ', 'Open the bot '), el('b', '', '@' + (g.bot ? g.bot.username : '')), t(' в Telegram на телефоне и отправьте: ', ' in Telegram on your phone and send: '));
      b.appendChild(el('code', 'tg-code', '/start ' + g.pair.code));
      const mmss = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
      b.append(t(` — код действует ещё ${mmss}.`, ` — the code is valid for ${mmss}.`) + (g.running ? '' : t(' Бот должен быть запущен.', ' The bot must be running.')));
    });
  }
  once($('tg-users'), JSON.stringify(g.users), (box) => {
    if (!g.users.length) { box.appendChild(el('li', 'muted small', t('Пока никто не привязан — нажмите «Привязать телефон».', 'Nobody is paired yet — press "Pair a phone".'))); return; }
    for (const u of g.users) {
      const li = el('li');
      li.append(el('span', '', '📱 ' + (u.name || t('без имени', 'no name')) + (u.username ? ` (@${u.username})` : '')));
      const x = el('button', 'btn small ghost', t('Отвязать', 'Unpair'));
      x.onclick = async () => {
        if (await confirmBox(t('Отвязать телефон', 'Unpair phone'), t(`Закрыть доступ к агенту для ${u.name || u.id}?`, `Revoke agent access for ${u.name || u.id}?`), t('Отвязать', 'Unpair')))
          tgPost('tg/unpair', { id: u.id }).catch(() => {});
      };
      li.appendChild(x);
      box.appendChild(li);
    }
  });
  const auto = $('tg-auto');
  if (document.activeElement !== auto) auto.checked = !!g.autostart;
  $('tg-start').hidden = g.running;
  $('tg-stop').hidden = !g.running;
  $('tg-start').disabled = !!g.busy;
}

$('tg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('tg-token');
  const btn = $('tg-save');
  btn.disabled = true; btn.textContent = t('Проверяю…', 'Checking…');
  try { await tgPost('tg/token', { token: input.value.trim() }); input.value = ''; }
  catch (err) { confirmBox(t('Не получилось подключить бота', 'Could not connect the bot'), err.message, t('Понятно', 'OK')); }
  finally { btn.disabled = false; btn.textContent = t('Подключить', 'Connect'); }
});
$('tg-start').onclick = () => tgPost('tg/start').catch((e) => confirmBox(t('Бот не запустился', 'The bot did not start'), e.message, t('Понятно', 'OK')));
$('tg-stop').onclick = () => tgPost('tg/stop').catch(() => {});
$('tg-pair-btn').onclick = async () => {
  try { await tgPost('tg/pair'); if (!state.telegram.running) await tgPost('tg/start'); }
  catch (e) { confirmBox(t('Привязка', 'Pairing'), e.message, t('Понятно', 'OK')); }
};
$('tg-auto').onchange = (e) => tgPost('tg/autostart', { on: e.target.checked }).catch(() => {});
$('tg-forget').onclick = async () => {
  if (await confirmBox(t('Сменить бота', 'Change bot'), t('Отключить этого бота от лаунчера? Токен удалится с ПК, привязанные телефоны тоже. Потом можно подключить другого бота.',
    'Disconnect this bot from the launcher? The token is deleted from this PC, and so are the paired phones. You can connect another bot afterwards.'), t('Отключить', 'Disconnect'))) tgPost('tg/forget').catch(() => {});
};
