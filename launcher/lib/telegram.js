// Telegram bot management for the launcher: token (checked with getMe), pairing a phone with a
// one-time code, start/stop of tools\telegram\bot.js (detached, survives the launcher), autostart,
// and the `telegram` agent profile (ACP) the bot talks to.
// The token stays in data\telegram\config.json: never logged, never sent anywhere but api.telegram.org.
'use strict';
const { T } = require('./i18n');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const crypto = require('crypto');

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'J.A.R.V.I.S. Telegram';
const PROFILE_VERSION = 1;

function createTelegram({ root, run, killTree, journal }) {
  const dir = path.join(root, 'data', 'telegram');
  const cfgFile = path.join(dir, 'config.json');
  const statusFile = path.join(dir, 'status.json');
  const pidFile = path.join(dir, 'bot.pid');
  const bot = path.join(root, 'tools', 'telegram', 'bot.js');
  const vbs = path.join(root, 'tools', 'telegram', 'start-hidden.vbs');
  const home = path.join(root, 'agent', 'home');
  const profile = path.join(home, 'profiles', 'telegram');
  fs.mkdirSync(dir, { recursive: true });

  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const readCfg = () => read(cfgFile, {});
  const writeCfg = (c) => { fs.writeFileSync(cfgFile + '.tmp', JSON.stringify(c, null, 2)); fs.renameSync(cfgFile + '.tmp', cfgFile); };
  let autostart = false;
  let busy = null;

  // Alive = the pid exists AND the bot's heartbeat (status.json, every 10 s) is fresh: Windows reuses pids.
  function botPid() {
    try {
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      if (!pid) return null;
      process.kill(pid, 0);
      const st = read(statusFile, {});
      if (st.pid === pid && Date.now() - (st.beat || st.startedAt || 0) < 60000) return pid;
    } catch {}
    return null;
  }

  function getMe(token) {
    return new Promise((resolve, reject) => {
      const req = https.get(`https://api.telegram.org/bot${token}/getMe`, { timeout: 15000 }, (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => {
          let j; try { j = JSON.parse(d); } catch { return reject(new Error(T('Telegram ответил непонятно (HTTP ', 'Telegram sent an unexpected reply (HTTP ') + res.statusCode + ')')); }
          if (j.ok) resolve(j.result); else reject(new Error(res.statusCode === 401 ? T('Токен не подошёл — скопируйте его из @BotFather ещё раз.', 'The token was rejected — copy it from @BotFather again.') : j.description));
        });
      });
      req.on('timeout', () => req.destroy(new Error(T('Telegram не отвечает — проверьте интернет.', 'Telegram is not responding — check your connection.'))));
      req.on('error', (e) => reject(new Error(T('Нет связи с api.telegram.org: ', 'Cannot reach api.telegram.org: ') + e.message)));
    });
  }

  // The agent profile for ACP: plugins copied from the web profile (no download), presets joined by
  // agent\plugins\jarvis-acp-presets, the same access rules and search settings as the web agent.
  function ensureProfile() {
    const marker = path.join(profile, '.jarvis-profile');
    if (read(marker, {}).version === PROFILE_VERSION && fs.existsSync(path.join(profile, 'node_modules', 'dsh-permission-rules'))) return;
    const web = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profile, { recursive: true });
    const webPkg = read(path.join(web, 'package.json'), { dependencies: {} });
    const deps = {};
    for (const n of ['dsh-cost-meter', 'dsh-free-search', 'dsh-permission-rules']) if (webPkg.dependencies[n]) deps[n] = webPkg.dependencies[n];
    fs.writeFileSync(path.join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-telegram', private: true, dependencies: deps,
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app', ...Object.keys(deps)], patchReload: 'startup' } } }, null, 2) + '\n');
    fs.writeFileSync(path.join(profile, 'cordis.yml'), '# dsh profile root (telegram bot, ACP). Edit cordis.patch.yml.\n[]\n');
    fs.writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n');
    const fwd = root.replace(/\\/g, '/');
    fs.writeFileSync(path.join(profile, 'cordis.patch.yml'), [
      '# Written by the J.A.R.V.I.S. launcher (lib/telegram.js): the agent for the Telegram bot over ACP.',
      '# Same home settings, presets, models and sessions as the web agent.',
      '- insert:',
      '    # Per-session presets ("full" / "lite"): the web app mounts this, ACP doesn\'t.',
      '    - id: agent-presets',
      "      name: '@deepseek-ai/dsh-agent-presets'",
      '      config:',
      '        default: full',
      '    # Joins ACP sessions to the preset the bot picked (ACP itself doesn\'t join any).',
      '    - id: jarvis-acp-presets',
      `      name: ${fwd}/agent/plugins/jarvis-acp-presets/index.mjs`,
      '      config:',
      '        default: full',
      `        presetFile: ${path.join(dir, 'preset.txt')}`,
      '    # Host-scope services the presets expect (dsh-web-app mounts them in the web profile).',
      '    - id: subagent-model-selection-settings',
      "      name: '@deepseek-ai/dsh-tool-subagent/model-selection-settings'",
      '    - id: code-runtime',
      "      name: '@deepseek-ai/dsh-code-runtime-worker-thread'",
      '    - id: workspace',
      "      name: '@deepseek-ai/dsh-workspace'",
      '    - id: session-reference',
      "      name: '@deepseek-ai/dsh-session-reference'",
      '    - id: file-reference-local',
      "      name: '@deepseek-ai/dsh-file-reference-local'",
      '    - id: session-stats',
      "      name: '@deepseek-ai/dsh-session-stats'",
      '    - id: session-turn-outline',
      "      name: '@deepseek-ai/dsh-session-turn-outline'",
      '',
      '# Same access rules as the web agent: important when it is driven from a phone.',
      '- id: permission-rules',
      '  name: dsh-permission-rules',
      '  config:',
      '    rulesFile: .dsh/rules.yaml',
      '    badFilePolicy: fail',
      '    maxRules: 256',
      '    patternMode: glob',
      '    watch: true',
      '    searchUp: true',
      '    fallbackPath: C:\\Projects\\.dsh\\rules.yaml',
      '',
      '- id: web-search-free',
      '  name: dsh-free-search',
      '  config:',
      '    provider: bing',
      '    bingMarket: ru-RU',
      '',
    ].join('\n'));
    // Plugins: a copy of the web profile's (junctions skipped; pnpm state files hold that profile's paths).
    const src = path.join(web, 'node_modules'), dst = path.join(profile, 'node_modules');
    const copy = (from, to) => {
      fs.mkdirSync(to, { recursive: true });
      for (const e of fs.readdirSync(from, { withFileTypes: true })) {
        if (e.isSymbolicLink() || ['.pnpm', '.modules.yaml', '.pnpm-workspace-state-v1.json', 'dsh-jarvis'].includes(e.name)) continue;
        const a = path.join(from, e.name), b = path.join(to, e.name);
        if (fs.lstatSync(a).isSymbolicLink()) continue;
        if (e.isDirectory()) copy(a, b); else fs.copyFileSync(a, b);
      }
    };
    copy(src, dst);
    fs.writeFileSync(marker, JSON.stringify({ version: PROFILE_VERSION }));
    journal(T('Telegram: профиль агента для бота подготовлен', 'Telegram: agent profile for the bot prepared'));
  }

  async function setToken(token) {
    token = String(token || '').trim();
    if (!/^\d{5,}:[\w-]{30,}$/.test(token)) throw new Error(T('Это не похоже на токен бота. Он выглядит так: 1234567890:AAH…, его выдаёт @BotFather.', 'This does not look like a bot token. It looks like 1234567890:AAH… and comes from @BotFather.'));
    busy = T('Проверяю токен…', 'Checking the token…');
    try {
      const me = await getMe(token);
      const cfg = readCfg();
      const changed = cfg.token !== token;
      cfg.token = token; cfg.bot = { id: me.id, username: me.username, name: me.first_name };
      if (changed) cfg.users = []; // another bot: pair again
      writeCfg(cfg);
      journal(T(`Telegram: подключён бот @${me.username}`, `Telegram: bot @${me.username} connected`), 'ok');
      await stop(true);
      await start();
    } finally { busy = null; }
  }

  async function forget() {
    await stop(true);
    await setAutostart(false);
    const cfg = readCfg();
    delete cfg.token; delete cfg.bot; delete cfg.pair; cfg.users = [];
    writeCfg(cfg);
    try { fs.unlinkSync(statusFile); } catch {}
    journal(T('Telegram: бот отключён от лаунчера, токен удалён', 'Telegram: bot disconnected from the launcher, token deleted'));
  }

  async function start() {
    if (botPid()) return;
    if (!readCfg().token) throw new Error(T('Сначала подключите бота: токен от @BotFather', 'Connect a bot first: a token from @BotFather'));
    busy = T('Готовлю агента для бота…', 'Preparing the agent for the bot…');
    try { ensureProfile(); } finally { busy = null; }
    try { fs.unlinkSync(statusFile); } catch {}
    const out = fs.openSync(path.join(dir, 'bot.out.log'), 'w');
    const p = cp.spawn(process.execPath, [bot], { cwd: path.dirname(bot), detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    fs.closeSync(out);
    p.unref();
    journal(T('Telegram-бот запущен', 'Telegram bot started'));
  }

  async function stop(quiet) {
    const pid = botPid();
    if (pid) await killTree(pid);
    try { fs.unlinkSync(pidFile); } catch {}
    if (!quiet) journal(T('Telegram-бот остановлен', 'Telegram bot stopped'));
  }

  function pair() {
    const cfg = readCfg();
    if (!cfg.token) throw new Error(T('Сначала подключите бота', 'Connect a bot first'));
    cfg.pair = { code: String(crypto.randomInt(100000, 1000000)), until: Date.now() + 10 * 60000, fails: 0 };
    writeCfg(cfg);
    journal(T('Telegram: код привязки создан (действует 10 минут)', 'Telegram: pairing code created (valid for 10 minutes)'));
  }

  function removeUser(id) {
    const cfg = readCfg();
    cfg.users = (cfg.users || []).filter((u) => u.id !== Number(id));
    writeCfg(cfg);
    journal(T('Telegram: доступ отозван', 'Telegram: access revoked'));
  }

  async function readAutostart() {
    const r = await run('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE]);
    autostart = !r.err && r.stdout.includes('start-hidden.vbs');
  }

  // Starts with Windows without a console window: wscript runs a tiny .vbs that runs node hidden.
  async function setAutostart(on) {
    if (on) {
      fs.writeFileSync(vbs, `' J.A.R.V.I.S.: Telegram bot at logon, no console window (written by the launcher).\r\n` +
        `CreateObject("WScript.Shell").Run """${process.execPath}"" ""${bot}""", 0, False\r\n`);
      await run('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `wscript.exe "${vbs}"`, '/f']);
    } else await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    await readAutostart();
    journal(on ? T('Telegram-бот будет запускаться вместе с Windows', 'The Telegram bot will start with Windows') : T('Автозапуск Telegram-бота выключен', 'Telegram bot autostart is off'));
  }

  function state() {
    const cfg = readCfg();
    const pid = botPid();
    const st = pid ? read(statusFile, {}) : {};
    return {
      configured: !!cfg.token,
      bot: cfg.bot || null,
      running: !!pid,
      telegram: pid ? st.telegram || 'connecting' : 'off',
      agent: pid ? st.agent || 'off' : 'off',
      error: st.error || null,
      lastMessageAt: st.lastMessageAt || null,
      users: (cfg.users || []).map((u) => ({ id: u.id, name: u.name, username: u.username })),
      pair: cfg.pair && cfg.pair.until > Date.now() ? { code: cfg.pair.code, until: cfg.pair.until } : null,
      autostart,
      busy,
    };
  }

  readAutostart();
  return { state, setToken, forget, start, stop, pair, removeUser, setAutostart, ensureProfile, running: () => !!botPid() };
}

module.exports = { createTelegram };
