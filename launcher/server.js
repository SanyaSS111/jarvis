// J.A.R.V.I.S. launcher: one local control server for the whole C:\LLM setup.
// - DeepSeek Harness agent (dsh web) in its own Edge app window
// - local llama.cpp models: Hugging Face catalog, download/verify/delete, start with a context size
//   (lib/models.js, lib/hf.js, lib/hardware.js, lib/harness.js)
// - JarvisHUD wallpaper: start/stop, settings (config.json), autostart, preview
// - telemetry, tools, logs
// No dependencies: plain Node (runs on the system Node.js).

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 3190;
const P = {
  ui: path.join(__dirname, 'ui'),
  data: path.join(ROOT, 'data'),
  agentData: path.join(ROOT, 'data', 'agent'),
  modelData: path.join(ROOT, 'data', 'model'),
  launcherData: path.join(ROOT, 'data', 'launcher'),
  dshDir: path.join(ROOT, 'runtime', 'dsh'),
  dshBin: path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  llama: path.join(ROOT, 'runtime', 'llama.cpp', 'llama-server.exe'),
  models: path.join(ROOT, 'models'),
  hudDir: path.join(ROOT, 'hud'),
  hudExe: path.join(ROOT, 'hud', 'JarvisHUD2.exe'),
  hudCfg: path.join(process.env.APPDATA || '', 'JarvisHUD2', 'config.json'),
  blender: path.join(ROOT, 'tools', 'blender', 'blender-mcp.cmd'),
  docs: path.join(ROOT, 'docs'),
  projects: 'C:\\Projects',
};
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));
for (const d of [P.agentData, P.modelData, P.launcherData, P.models]) fs.mkdirSync(d, { recursive: true });

const { detectHardware } = require('./lib/hardware');
const { createModels } = require('./lib/models');
const { createWindhawk } = require('./lib/windhawk');
const { createComfy } = require('./lib/comfy');
const { createTelegram } = require('./lib/telegram');
const { applyFixes } = require('./lib/fixes');

// ---------------------------------------------------------------- state
const S = {
  startedAt: Date.now(),
  agent: { status: 'off', url: null, pid: null, error: null, since: null, windowOpen: false },
  hud: { running: false, autostart: false, previewAt: 0, previewBusy: false, restarting: false },
  sys: { cpu: 0, ramUsed: 0, ramTotal: os.totalmem(), gpu: null, diskFree: 0, heavy: [] },
  hw: null,
  log: [],
};
const own = { agentProc: null, agentWin: null };

function journal(text, level = 'info') {
  S.log.push({ t: Date.now(), level, text });
  if (S.log.length > 80) S.log.shift();
  fs.appendFile(path.join(P.launcherData, 'launcher.log'),
    `${new Date().toISOString()} [${level}] ${text}\n`, () => {});
}

// ---------------------------------------------------------------- helpers
function run(file, args, opts = {}) {
  return new Promise((resolve) => {
    cp.execFile(file, args, { windowsHide: true, timeout: opts.timeout || 15000, encoding: opts.encoding || 'utf8',
      maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => resolve({ err, stdout: stdout || '', stderr: stderr || '' }));
  });
}
async function killTree(pid) {
  if (!pid) return;
  await run('taskkill.exe', ['/PID', String(pid), '/T', '/F']);
}
async function listeningPid(port) {
  const { stdout } = await run('netstat.exe', ['-ano', '-p', 'TCP']);
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.trim().split(/\s+/);
    if (m.length >= 5 && /LISTEN/i.test(m[3]) && m[1].endsWith(':' + port)) return Number(m[4]);
  }
  return null;
}
function httpGet(url, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
  });
}
function tail(file, lines = 14) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch { return ''; }
}
function fileLen(p) { try { return fs.statSync(p).size; } catch { return 0; } }
function openEdgeApp(url, profileDir, size = '1280,860') {
  if (!EDGE) { journal('Microsoft Edge не найден', 'error'); return null; }
  return cp.spawn(EDGE, [`--app=${url}`, `--user-data-dir=${profileDir}`, '--no-first-run',
    '--no-default-browser-check', `--window-size=${size}`], { windowsHide: false, stdio: 'ignore' });
}
function stripAnsi(s) { return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''); }

const models = createModels({
  root: ROOT, run, killTree, listeningPid, httpGet, journal,
  getHw: () => S.hw,
  agentHome: path.join(ROOT, 'agent', 'home'),
});
// ComfyUI: image/video models from the catalog (lib/comfy.js).
const comfy = createComfy({
  root: ROOT, run, killTree, listeningPid, httpGet, journal,
  getHw: () => S.hw, openEdge: openEdgeApp, imageModels: () => models.imageModels(),
});
// Telegram bot (tools\telegram\bot.js): the agent from a phone (lib/telegram.js).
const telegram = createTelegram({ root: ROOT, run, killTree, journal });

// ---------------------------------------------------------------- agent (dsh web)
const AGENT_PORT = 3080;
const agentUrlFile = path.join(P.agentData, 'url.txt');

async function agentStart() {
  if (['starting', 'on'].includes(S.agent.status)) return agentOpen();
  S.agent = { status: 'starting', url: null, pid: null, error: null, since: Date.now(), windowOpen: false };
  journal('Запуск агента DeepSeek Harness…');
  const busy = await listeningPid(AGENT_PORT);
  if (busy) {
    const saved = fs.existsSync(agentUrlFile) ? fs.readFileSync(agentUrlFile, 'utf8').trim() : '';
    if (saved) {
      Object.assign(S.agent, { status: 'on', url: saved, pid: busy });
      journal('Агент уже работал — подключился к нему', 'ok');
      return agentOpen();
    }
    await killTree(busy);
  }
  // Output goes straight to files (not pipes) and the process is detached, so the agent survives
  // a launcher restart; the login URL is read back from the log.
  const outLog = path.join(P.agentData, 'dsh-web.log');
  const outFd = fs.openSync(outLog, 'w');
  const errFd = fs.openSync(path.join(P.agentData, 'dsh-web.err.log'), 'w');
  const env = { ...process.env, PATH: `${P.dshDir};${path.dirname(process.execPath)};${process.env.PATH}`,
    LOCAL_LLAMA_API_KEY: 'local', DSH_TELEMETRY_DISABLED: '1' };
  // The agent's settings live in agent\home. Where ~/.dsh already points there (junction) keep the
  // default; otherwise (fresh installs) tell dsh explicitly.
  const agentHome = path.join(ROOT, 'agent', 'home');
  let homeDsh = null;
  try { homeDsh = fs.realpathSync(path.join(os.homedir(), '.dsh')); } catch {}
  if (!homeDsh || path.resolve(homeDsh).toLowerCase() !== path.resolve(agentHome).toLowerCase()) env.DSH_HOME = agentHome;
  const cwd = fs.existsSync(P.projects) ? P.projects : os.homedir();
  // detached: otherwise libuv puts the child in a kill-on-close job and it dies with the launcher.
  const proc = cp.spawn(process.execPath, [P.dshBin, 'web', '--no-open'],
    { cwd, env, windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd] });
  fs.closeSync(outFd); fs.closeSync(errFd);
  own.agentProc = proc;
  S.agent.pid = proc.pid;
  const watch = setInterval(() => {
    if (own.agentProc !== proc || S.agent.url) { clearInterval(watch); return; }
    let text = '';
    try { text = stripAnsi(fs.readFileSync(outLog, 'utf8')); } catch { return; }
    const m = text.match(/https?:\/\/\S+token=[\w-]+/);
    if (m) {
      clearInterval(watch);
      S.agent.url = m[0];
      S.agent.status = 'on';
      fs.writeFileSync(agentUrlFile, m[0]);
      journal(`Агент в сети за ${Math.round((Date.now() - S.agent.since) / 1000)} с`, 'ok');
      agentOpen();
    }
  }, 500);
  proc.on('exit', (code) => {
    clearInterval(watch);
    if (own.agentProc !== proc) return;
    own.agentProc = null;
    try { fs.unlinkSync(agentUrlFile); } catch {}
    if (S.agent.status === 'stopping' || S.agent.status === 'off') {
      S.agent.status = 'off';
    } else {
      S.agent.status = 'error';
      S.agent.error = `Сервер агента завершился (код ${code}).\n` + tail(path.join(P.agentData, 'dsh-web.err.log'), 10);
      journal('Агент неожиданно остановился', 'error');
    }
    S.agent.url = null; S.agent.pid = null; S.agent.windowOpen = false;
    scheduleIdleCheck();
  });
  setTimeout(() => {
    if (S.agent.status === 'starting' && own.agentProc === proc) {
      S.agent.error = 'Агент не ответил за 2 минуты.\n' + tail(path.join(P.agentData, 'dsh-web.err.log'), 10);
      journal('Агент не запустился вовремя', 'error');
      agentStop('error');
    }
  }, 120000);
}

function agentOpen() {
  if (S.agent.status !== 'on' || !S.agent.url) return;
  const started = Date.now();
  const win = openEdgeApp(S.agent.url, path.join(P.agentData, 'edge-profile'), '1280,860');
  if (!win) return;
  own.agentWin = win;
  S.agent.windowOpen = true;
  win.on('exit', () => {
    if (own.agentWin !== win) return;
    // A quick exit means Edge handed the window to an already running instance.
    if (Date.now() - started < 4000) return;
    own.agentWin = null;
    S.agent.windowOpen = false;
    if (S.agent.status === 'on') {
      journal('Окно агента закрыто — останавливаю агента');
      agentStop();
    }
  });
}

async function agentStop(finalStatus = 'off') {
  const pid = S.agent.pid;
  S.agent.status = finalStatus === 'error' ? 'error' : 'stopping';
  own.agentProc = null; // the exit handler must not report this as a crash
  if (own.agentWin) { try { own.agentWin.kill(); } catch {} own.agentWin = null; }
  if (pid) await killTree(pid);
  const still = await listeningPid(AGENT_PORT);
  if (still) await killTree(still);
  try { fs.unlinkSync(agentUrlFile); } catch {}
  S.agent.url = null; S.agent.pid = null; S.agent.windowOpen = false;
  if (finalStatus !== 'error') { S.agent.status = 'off'; journal('Агент остановлен'); }
  scheduleIdleCheck();
}

// Jarvis skin for the Harness UI: the dsh-jarvis plugin polls this file and applies it live.
const themeFile = path.join(P.agentData, 'jarvis-theme.json');
function themeEnabled() {
  try { return JSON.parse(fs.readFileSync(themeFile, 'utf8')).enabled !== false; } catch { return true; }
}
function setTheme(on) {
  fs.writeFileSync(themeFile, JSON.stringify({ enabled: !!on }, null, 2));
  journal(on ? 'Интерфейс агента: тема Джарвиса' : 'Интерфейс агента: стандартная тема');
}

// An agent adopted after a launcher restart is not our child: watch its port instead.
async function agentPoll() {
  if (S.agent.status !== 'on' || own.agentProc) return;
  if (!(await listeningPid(AGENT_PORT))) {
    S.agent = { status: 'off', url: null, pid: null, error: null, since: null, windowOpen: false };
    try { fs.unlinkSync(agentUrlFile); } catch {}
    journal('Агент остановлен');
    scheduleIdleCheck();
  }
}

async function adoptExisting() {
  const agentPid = await listeningPid(AGENT_PORT);
  if (agentPid && fs.existsSync(agentUrlFile)) {
    Object.assign(S.agent, { status: 'on', url: fs.readFileSync(agentUrlFile, 'utf8').trim(), pid: agentPid, since: Date.now() });
    journal('Найден работающий агент — подключился');
  }
  await models.adopt();
}

// ---------------------------------------------------------------- HUD wallpaper
const HUD_DEFAULTS = { accent: [0.361, 0.882, 1.0], fps_cap: 30, icon_margin: 300.0, grid: true, motes: true,
  frame: true, reactor: true, boot_animation: true, hidden: [], positions: {}, disabled_monitors: [] };
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

function hudConfig() {
  try { return { ...HUD_DEFAULTS, ...JSON.parse(fs.readFileSync(P.hudCfg, 'utf8')) }; } catch { return { ...HUD_DEFAULTS }; }
}
function hudSave(patch) {
  const cfg = { ...hudConfig() };
  for (const k of Object.keys(HUD_DEFAULTS)) if (k in patch) cfg[k] = patch[k];
  fs.mkdirSync(path.dirname(P.hudCfg), { recursive: true });
  fs.writeFileSync(P.hudCfg, JSON.stringify(cfg, null, 2));
  return cfg;
}
function hudStart() {
  if (!fs.existsSync(P.hudExe)) { journal('JarvisHUD2.exe не найден', 'error'); return; }
  const child = cp.spawn(P.hudExe, [], { cwd: P.hudDir, detached: true, stdio: 'ignore' });
  child.unref();
  S.hud.running = true;
  journal('Обои HUD запущены', 'ok');
}
async function hudStop(quiet) {
  await run('taskkill.exe', ['/IM', 'JarvisHUD2.exe', '/F']);
  S.hud.running = false;
  if (!quiet) journal('Обои HUD остановлены');
}
async function hudApply(patch) {
  hudSave(patch);
  journal('Настройки обоев сохранены');
  if (S.hud.running) {
    S.hud.restarting = true;
    await hudStop(true);
    await new Promise((r) => setTimeout(r, 700));
    hudStart();
    S.hud.restarting = false;
  }
  hudPreview();
}
async function hudAutostartRead() {
  const { stdout } = await run('reg.exe', ['query', RUN_KEY, '/v', 'JarvisHUD2']);
  S.hud.autostart = stdout.includes(P.hudExe);
}
async function hudAutostart(on) {
  if (on) await run('reg.exe', ['add', RUN_KEY, '/v', 'JarvisHUD2', '/t', 'REG_SZ', '/d', `"${P.hudExe}"`, '/f']);
  else await run('reg.exe', ['delete', RUN_KEY, '/v', 'JarvisHUD2', '/f']);
  await hudAutostartRead();
  journal(S.hud.autostart ? 'Обои будут запускаться вместе с Windows' : 'Автозапуск обоев выключен');
}
const previewFile = path.join(P.launcherData, 'hud-preview.png');
async function hudPreview() {
  if (S.hud.previewBusy || !fs.existsSync(P.hudExe)) return;
  S.hud.previewBusy = true;
  await run(P.hudExe, ['--shot', previewFile, '--at', '99'], { timeout: 30000 });
  S.hud.previewBusy = false;
  if (fs.existsSync(previewFile)) S.hud.previewAt = fs.statSync(previewFile).mtimeMs;
}

// ---------------------------------------------------------------- Windows icons in the Jarvis style
// tools\win-style.ps1 does the work (per-user registry, desktop.ini, shortcuts) and keeps a backup.
const winStyleScript = path.join(__dirname, 'tools', 'win-style.ps1');
const winStyleBackup = path.join(P.launcherData, 'win-style-backup.json');
const winPreview = path.join(__dirname, 'icons', 'windows', 'strip.png');
S.win = { busy: false };
async function winStyle(action) {
  if (S.win.busy) return;
  S.win.busy = true;
  journal(action === 'apply' ? 'Применяю оформление Windows в стиле Джарвиса…' : 'Возвращаю стандартные значки Windows…');
  const { stdout, stderr } = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winStyleScript, '-Action', action],
    { timeout: 120000 });
  S.win.busy = false;
  let r = null;
  try { r = JSON.parse(stdout.trim().split(/\r?\n/).pop()); } catch {}
  if (!r) { journal('Оформление Windows: ошибка скрипта ' + stripAnsi(stderr).slice(0, 300), 'error'); return; }
  if (action === 'apply') journal(`Значки рабочего стола: ${r.clsid}, папки: ${r.folders}, ярлыки: ${r.shortcuts}`, 'ok');
  else journal(`Стандартные значки возвращены (${r.restored})`, 'ok');
  for (const e of r.errors || []) journal(e, 'warn');
}

// Jarvis taskbar: portable Windhawk + Taskbar Styler mod, managed by lib/windhawk.js.
const taskbarTheme = path.join(ROOT, 'docs', 'taskbar-jarvis.yaml');
const windhawk = createWindhawk({ root: ROOT, run, journal });
S.taskbar = null;
async function taskbarTick() { try { S.taskbar = await windhawk.status(); } catch {} }

// ---------------------------------------------------------------- telemetry
let cpuPrev = os.cpus();
function cpuTick() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const a = c.times, b = cpuPrev[i].times;
    const t = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + (a.idle - b.idle);
    idle += a.idle - b.idle; total += t;
  });
  cpuPrev = now;
  S.sys.cpu = total ? Math.round(100 * (1 - idle / total)) : 0;
  S.sys.ramUsed = os.totalmem() - os.freemem();
  try { const st = fs.statfsSync(P.models); S.sys.diskFree = st.bavail * st.bsize; } catch {}
}
const SMI = ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'].find((p) => fs.existsSync(p));
async function gpuTick() {
  if (!SMI) return;
  const { stdout } = await run(SMI, ['--query-gpu=name,memory.used,memory.total,utilization.gpu,temperature.gpu',
    '--format=csv,noheader,nounits']);
  const v = stdout.split(/\r?\n/)[0]?.split(',').map((s) => s.trim());
  if (v && v.length >= 5) S.sys.gpu = { name: v[0], vramUsed: +v[1], vramTotal: +v[2], load: +v[3], temp: +v[4] };
}
async function procTick() {
  const { stdout } = await run('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'latin1' });
  const sums = new Map();
  let hud = false;
  for (const line of stdout.split(/\r?\n/)) {
    const cols = line.match(/"([^"]*)"/g);
    if (!cols || cols.length < 5) continue;
    const name = cols[0].slice(1, -1);
    const kb = Number(cols[4].replace(/\D/g, '')) || 0;
    if (name.toLowerCase() === 'jarvishud2.exe') hud = true;
    sums.set(name, (sums.get(name) || 0) + kb);
  }
  if (!S.hud.restarting) S.hud.running = hud;
  S.sys.heavy = [...sums.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([name, kb]) => ({ name: name.replace(/\.exe$/i, ''), mb: Math.round(kb / 1024) }));
}

// ---------------------------------------------------------------- UI lifecycle
const clients = new Set();
let idleTimer = null;
function busyServices() {
  // A running Telegram bot may need the local model / ComfyUI through this server: stay up with it.
  return ['starting', 'on', 'stopping'].includes(S.agent.status) || models.busy() || comfy.busy() || telegram.running() || !!(S.taskbar && S.taskbar.step);
}
function scheduleIdleCheck() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (clients.size > 0 || busyServices()) return;
    journal('Окно лаунчера закрыто и агент не работает — выключаюсь');
    if (models.activeStatus() !== 'off') await models.stop(true);
    process.exit(0);
  }, 10000);
}
let uiWindowAt = 0;
function openLauncherWindow() {
  if (clients.size > 0) { broadcast('focus', {}); return; }
  if (Date.now() - uiWindowAt < 5000) return;
  uiWindowAt = Date.now();
  openEdgeApp(`http://127.0.0.1:${PORT}/`, path.join(P.launcherData, 'edge-profile'), '1360,880');
}
function snapshot() {
  const cfgAccent = hudConfig().accent;
  return {
    ...S,
    models: models.state(),
    comfy: comfy.state(),
    telegram: telegram.state(),
    agent: { ...S.agent, theme: themeEnabled() },
    win: { ...S.win, applied: fs.existsSync(winStyleBackup) },
    meta: { accent: cfgAccent, root: ROOT },
  };
}
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------------------------------------------------------------- HTTP
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function openPath(p) { cp.spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' }).unref(); }

const ACTIONS = {
  'agent/start': () => agentStart(),
  'agent/stop': () => agentStop(),
  'agent/open': () => agentOpen(),
  'agent/theme': (b) => setTheme(!!b.on),
  'model/start': async (b) => { await comfy.releaseForModel(); return models.start(String(b.id), Number(b.ctx)); },
  'model/stop': () => models.stop(),
  'model/chat': () => { if (models.activeStatus() === 'on') openEdgeApp('http://127.0.0.1:8081/', path.join(P.modelData, 'edge-profile'), '1100,820'); },
  'model/install': (b) => models.install(String(b.repo), String(b.quant)),
  'model/pause': (b) => models.pause(String(b.id)),
  'model/resume': (b) => models.resume(String(b.id)),
  'model/delete': (b) => models.remove(String(b.id)),
  'comfy/install': () => { comfy.install(); },
  // The agent's image tool (tools\mcp\comfyui) passes open:false: start quietly, no window.
  'comfy/start': (b) => comfy.start({ show: b.open !== false }),
  'comfy/open': () => comfy.open(),
  'comfy/stop': () => comfy.stop(),
  'comfy/delete': () => comfy.remove(),
  'comfy/folder': (b) => { const d = b.what === 'models' ? comfy.modelsDir : comfy.outputDir; fs.mkdirSync(d, { recursive: true }); openPath(d); },
  'tg/token': (b) => telegram.setToken(b.token),
  'tg/forget': () => telegram.forget(),
  'tg/start': () => telegram.start(),
  'tg/stop': () => telegram.stop(),
  'tg/pair': () => telegram.pair(),
  'tg/unpair': (b) => telegram.removeUser(b.id),
  'tg/autostart': (b) => telegram.setAutostart(!!b.on),
  'hw/refresh': async () => { S.hw = await detectHardware(run, path.dirname(P.llama)); },
  'hud/start': () => hudStart(),
  'hud/stop': () => hudStop(),
  'hud/apply': (b) => hudApply(b.config || {}),
  'hud/reset': () => hudApply({ ...HUD_DEFAULTS }),
  'hud/autostart': (b) => hudAutostart(!!b.on),
  'hud/preview': () => hudPreview(),
  'taskbar/install': (b) => { windhawk.install(Array.isArray(b.keys) ? b.keys : null).then(taskbarTick); setTimeout(taskbarTick, 300); },
  'taskbar/toggle': async (b) => { await windhawk.setEnabled(String(b.key || 'taskbar'), !!b.on); await taskbarTick(); },
  'taskbar/autostart': async (b) => { await windhawk.setAutostart(!!b.on); await taskbarTick(); },
  'taskbar/reload': async (b) => { windhawk.reloadTheme(b.key || null); await taskbarTick(); },
  'taskbar/windhawk': () => windhawk.openUi(),
  // Manual steps: the launcher only opens the right Windows page / folder, the user makes the change.
  'guide/cursors': () => {
    cp.spawn('control.exe', ['main.cpl,,1'], { detached: true, stdio: 'ignore' }).unref();
    openPath(path.join(__dirname, 'icons', 'cursors'));
  },
  'guide/accent': () => { cp.spawn('cmd.exe', ['/c', 'start', '', 'ms-settings:colors'], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); },
  'guide/lock': async () => {
    const img = path.join(P.launcherData, 'lockscreen.png');
    if (!fs.existsSync(img)) await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'tools', 'make-lockscreen.ps1'), '-Out', img], { timeout: 60000 });
    cp.spawn('cmd.exe', ['/c', 'start', '', 'ms-settings:lockscreen'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  },
  'win/apply': () => winStyle('apply'),
  'win/restore': () => winStyle('restore'),
  'tool/blender': () => { cp.spawn('cmd.exe', ['/c', P.blender], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); journal('Blender запускается вместе с MCP-сервером'); },
  'tool/open': (b) => {
    const map = { root: ROOT, models: P.models, projects: P.projects, logs: P.data, docs: P.docs, hud: P.hudDir, agent: path.join(ROOT, 'agent', 'home') };
    if (map[b.what]) openPath(map[b.what]);
  },
  'shutdown': async () => { await agentStop(); await models.stop(true); if (comfy.running()) await comfy.stop(); await telegram.stop(true); journal('Агент и модель отключены'); },
  'ui/open': () => openLauncherWindow(),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  // Only this machine's launcher page may talk to the API.
  const host = req.headers.host || '';
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { res.writeHead(403); return res.end(); }

  if (url.pathname === '/api/ping') return send(res, 200, { ok: true });
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: state\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    clearTimeout(idleTimer);
    req.on('close', () => { clients.delete(res); scheduleIdleCheck(); });
    return;
  }
  if (url.pathname === '/api/hud/config') return send(res, 200, hudConfig());
  // Hugging Face catalog (fetched by the core, so the page needs no network access of its own).
  if (url.pathname.startsWith('/api/catalog/')) {
    const ctx = Number(url.searchParams.get('ctx')) || 16384;
    try {
      if (url.pathname === '/api/catalog/recommended') return send(res, 200, await models.recommended(ctx));
      if (url.pathname === '/api/catalog/search') return send(res, 200, await models.search(url.searchParams.get('q') || '', url.searchParams.get('cursor') || null, ctx));
      if (url.pathname === '/api/catalog/details') return send(res, 200, await models.details(url.searchParams.get('repo') || '', ctx));
    } catch (e) { return send(res, 502, { error: String(e.message || e) }); }
  }
  if (url.pathname === '/api/taskbar/theme') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(taskbarTheme).pipe(res);
  }
  if (url.pathname === '/api/win/preview.png') {
    if (!fs.existsSync(winPreview)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return fs.createReadStream(winPreview).pipe(res);
  }
  if (url.pathname === '/api/hud/preview.png') {
    if (!fs.existsSync(previewFile)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    return fs.createReadStream(previewFile).pipe(res);
  }
  if (url.pathname === '/api/logs') {
    const files = { agent: path.join(P.agentData, 'dsh-web.err.log'), agentOut: path.join(P.agentData, 'dsh-web.log'),
      model: path.join(P.modelData, 'llama-server.err.log'), comfy: path.join(P.data, 'comfyui', 'comfyui.log'), telegram: path.join(P.data, 'telegram', 'bot.log'), launcher: path.join(P.launcherData, 'launcher.log') };
    const f = files[url.searchParams.get('which')] || files.launcher;
    return send(res, 200, { file: f, text: stripAnsi(tail(f, 200)) });
  }
  if (url.pathname.startsWith('/api/') && req.method === 'POST') {
    if (req.headers['x-jarvis'] !== '1') { res.writeHead(403); return res.end(); }
    const action = ACTIONS[url.pathname.slice(5)];
    if (!action) return send(res, 404, { error: 'unknown action' });
    const body = await readBody(req);
    try { await action(body); send(res, 200, { ok: true }); } catch (e) { journal(String(e.message || e), 'error'); send(res, 500, { error: String(e.message || e) }); }
    return;
  }

  // Static UI.
  let rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.join(P.ui, rel);
  if (!file.startsWith(P.ui) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  // Another launcher already owns the port: ask it to show its window and quit.
  if (e.code === 'EADDRINUSE') {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/ui/open', method: 'POST', headers: { 'X-Jarvis': '1' } },
      () => process.exit(0));
    req.on('error', () => process.exit(1));
    req.end();
  } else { throw e; }
});

server.listen(PORT, '127.0.0.1', async () => {
  journal('J.A.R.V.I.S. запущен');
  S.hw = await detectHardware(run, path.dirname(P.llama));
  journal(`Железо: ${S.hw.gpu ? `${S.hw.gpu.name} ${Math.round(S.hw.gpu.vramMB / 1024)} ГБ` : 'без дискретной видеокарты'}, ОЗУ ${Math.round(S.hw.ramMB / 1024)} ГБ, движок ${S.hw.engine.toUpperCase()}`);
  models.syncHarness();
  try { for (const name of applyFixes(ROOT)) journal('Исправлено: ' + name + ' (перезапустите агента)', 'ok'); }
  catch (e) { journal('Исправления плагинов: ' + e.message, 'warn'); }
  await adoptExisting();
  await comfy.adopt();
  hudAutostartRead();
  procTick(); gpuTick();
  if (fs.existsSync(previewFile)) S.hud.previewAt = fs.statSync(previewFile).mtimeMs;
  // An already open launcher window reconnects on its own (EventSource retry) after a restart;
  // only open a new one if none comes back.
  if (!process.argv.includes('--no-window')) setTimeout(() => { if (clients.size === 0) openLauncherWindow(); }, 4000);
  setInterval(() => { cpuTick(); models.tick(); models.poll(); comfy.tick(); comfy.poll(); broadcast('state', snapshot()); }, 1000);
  setInterval(gpuTick, 2000);
  setInterval(procTick, 3000);
  setInterval(agentPoll, 5000);
  windhawk.ensureRunning().then(taskbarTick);
  setInterval(taskbarTick, 3000);
  // Safety net: if the window never connects, don't hang around forever.
  setTimeout(() => { if (clients.size === 0) scheduleIdleCheck(); }, 60000);
});

process.on('uncaughtException', (e) => journal('Сбой: ' + (e.stack || e), 'error'));
