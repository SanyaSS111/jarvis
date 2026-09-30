// J.A.R.V.I.S. Telegram bot: the DeepSeek Harness agent in a Telegram chat (plain Node, no dependencies).
// - Telegram Bot API over HTTPS long polling; only users paired in the launcher may talk to it.
// - The agent runs as `dsh --profile telegram` (ACP over stdio): same home settings, presets, models and
//   session storage as the web agent. Permission requests become "Разрешить / Отклонить" buttons.
// - /model, /mode, /new, /stop, /status. Pictures the agent draws are sent back as photos; photos and
//   files from the chat are saved to <Projects>\Telegram and handed to the agent by path.
// Config (token, paired users, pairing code) lives in data\telegram\config.json, written by the launcher.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA = path.join(ROOT, 'data', 'telegram');
const CONFIG = path.join(DATA, 'config.json');
const STATE = path.join(DATA, 'state.json');
const STATUS = path.join(DATA, 'status.json');
const PID = path.join(DATA, 'bot.pid');
const PRESET_FILE = path.join(DATA, 'preset.txt');
const DSH_BIN = path.join(ROOT, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const AGENT_HOME = path.join(ROOT, 'agent', 'home');
const PROJECTS = fs.existsSync('C:\\Projects') ? 'C:\\Projects' : os.homedir();
const INBOX = path.join(PROJECTS, 'Telegram');
const COMFY_OUT = path.join(ROOT, 'data', 'comfyui', 'output');
const LAUNCHER = 'http://127.0.0.1:3190';
const API = process.env.JARVIS_TG_API || 'https://api.telegram.org'; // overridable for offline tests
const PRESETS = { full: 'Полный режим', lite: 'Лёгкий режим' };
const EFFORTS = { off: 'без рассуждений', low: 'коротко', high: 'обычно', max: 'максимум' };
const IDLE_CLOSE_MS = 15 * 60000; // close an idle ACP session so the web agent can open it cleanly

fs.mkdirSync(DATA, { recursive: true });
const logFile = fs.createWriteStream(path.join(DATA, 'bot.log'), { flags: 'a' });
const log = (m) => logFile.write(`${new Date().toISOString()} ${m}\n`);

// ---------------------------------------------------------------- single instance
try {
  const old = Number(fs.readFileSync(PID, 'utf8'));
  if (old && old !== process.pid) { process.kill(old, 0); log(`already running as ${old}, exiting`); process.exit(0); }
} catch {}
fs.writeFileSync(PID, String(process.pid));
const cleanup = () => { try { if (Number(fs.readFileSync(PID, 'utf8')) === process.pid) fs.unlinkSync(PID); } catch {} };
process.on('exit', cleanup);
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(0));

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.writeFileSync(f + '.tmp', JSON.stringify(v, null, 2)); fs.renameSync(f + '.tmp', f); };
const readConfig = () => readJson(CONFIG, {});
const config0 = readConfig();
if (!config0.token) { log('no token, exiting'); process.exit(1); }
const TOKEN = config0.token;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const status = { pid: process.pid, startedAt: Date.now(), username: null, telegram: 'connecting', agent: 'off', error: null, lastMessageAt: null };
function saveStatus(patch) { Object.assign(status, patch || {}); try { writeJson(STATUS, status); } catch {} }
saveStatus();
setInterval(() => saveStatus({ beat: Date.now() }), 10000);

// ---------------------------------------------------------------- Telegram API
function request(url, { method = 'GET', body, headers = {}, timeout = 70000 } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.request(url, { method, headers, timeout }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function tg(method, params = {}, timeout = 70000) {
  const body = Buffer.from(JSON.stringify(params));
  const r = await request(`${API}/bot${TOKEN}/${method}`, { method: 'POST', body, timeout,
    headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } });
  let j; try { j = JSON.parse(r.body.toString('utf8')); } catch { throw new Error(`Telegram ${method}: HTTP ${r.status}`); }
  if (!j.ok) { const e = new Error(`Telegram ${method}: ${j.description || r.status}`); e.retryAfter = j.parameters && j.parameters.retry_after; throw e; }
  return j.result;
}

async function tgUpload(method, fields, fileField, filePath) {
  const boundary = '----jarvis' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${typeof v === 'string' ? v : JSON.stringify(v)}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${path.basename(filePath).replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
  parts.push(fs.readFileSync(filePath), Buffer.from(`\r\n--${boundary}--\r\n`));
  const body = Buffer.concat(parts);
  const r = await request(`${API}/bot${TOKEN}/${method}`, { method: 'POST', body, timeout: 300000,
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } });
  const j = JSON.parse(r.body.toString('utf8'));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description}`);
  return j.result;
}

async function tgDownload(fileId, dest) {
  const f = await tg('getFile', { file_id: fileId });
  const r = await request(`${API}/file/bot${TOKEN}/${f.file_path}`, { timeout: 300000 });
  if (r.status !== 200) throw new Error('не удалось скачать файл из Telegram');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, r.body);
  return dest;
}

// ---------------------------------------------------------------- formatting
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// Markdown subset → Telegram HTML (code blocks, inline code, bold, headings, links).
function mdToHtml(md) {
  return md.split(/```/).map((part, i) => {
    if (i % 2 === 1) return '<pre>' + esc(part.replace(/^[\w+-]*\n/, '')) + '</pre>';
    let t = esc(part);
    t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
    t = t.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, a, u) => `<a href="${u.replace(/"/g, '&quot;')}">${a}</a>`);
    return t;
  }).join('');
}
// Split into Telegram-sized pieces on line breaks, keeping ``` fences balanced per piece.
function chunks(text, max = 3500) {
  const out = [];
  let rest = text, reopen = false;
  while (rest.length) {
    let piece = rest.length <= max ? rest : rest.slice(0, max);
    if (rest.length > max) { const cut = piece.lastIndexOf('\n'); if (cut > max * 0.5) piece = piece.slice(0, cut); }
    rest = rest.slice(piece.length).replace(/^\n/, '');
    if (reopen) piece = '```\n' + piece;
    const open = (piece.match(/```/g) || []).length % 2 === 1;
    if (open) piece += '\n```';
    reopen = open;
    out.push(piece);
  }
  return out.length ? out : [''];
}

async function send(chatId, text, extra = {}) {
  try { return await tg('sendMessage', { chat_id: chatId, text: mdToHtml(text), parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) {
    if (/parse entities|can't parse/i.test(e.message)) return tg('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra });
    throw e;
  }
}
async function edit(chatId, messageId, text, extra = {}) {
  try { return await tg('editMessageText', { chat_id: chatId, message_id: messageId, text: mdToHtml(text), parse_mode: 'HTML', disable_web_page_preview: true, ...extra }); }
  catch (e) {
    if (/not modified/i.test(e.message)) return null;
    if (/parse entities|can't parse/i.test(e.message)) return tg('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, ...extra }).catch(() => null);
    throw e;
  }
}

// ---------------------------------------------------------------- the agent over ACP
class Acp {
  constructor() { this.proc = null; this.ready = null; this.pending = new Map(); this.n = 0; this.onUpdate = null; this.onPermission = null; this.active = new Set(); this.imagePrompt = false; }

  start() {
    if (this.ready) return this.ready;
    saveStatus({ agent: 'starting' });
    const env = { ...process.env, DSH_HOME: AGENT_HOME, LOCAL_LLAMA_API_KEY: 'local', DSH_TELEMETRY_DISABLED: '1',
      PATH: `${path.join(ROOT, 'runtime', 'dsh')};${path.dirname(process.execPath)};${process.env.PATH}` };
    const err = fs.openSync(path.join(DATA, 'agent.err.log'), 'w');
    const p = cp.spawn(process.execPath, [DSH_BIN, '--profile', 'telegram'], { cwd: PROJECTS, env, windowsHide: true, stdio: ['pipe', 'pipe', err] });
    fs.closeSync(err);
    this.proc = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; } // plugin chatter on stdout
        this.dispatch(m);
      }
    });
    p.on('exit', (code) => {
      log(`agent exited ${code}`);
      if (this.proc !== p) return;
      this.proc = null; this.ready = null; this.active.clear();
      for (const [, w] of this.pending) w.reject(new Error('агент перезапускается'));
      this.pending.clear();
      saveStatus({ agent: 'off' });
    });
    p.stdin.on('error', () => {});
    this.ready = this.call('initialize', { protocolVersion: 1, clientCapabilities: {} }).then((r) => {
      this.imagePrompt = !!(r.agentCapabilities && r.agentCapabilities.promptCapabilities && r.agentCapabilities.promptCapabilities.image);
      saveStatus({ agent: 'on' });
      log('agent ready');
    }).catch((e) => { this.ready = null; saveStatus({ agent: 'error', error: e.message }); throw e; });
    return this.ready;
  }

  dispatch(m) {
    if (m.id !== undefined && (m.result !== undefined || m.error) && this.pending.has(m.id)) {
      const w = this.pending.get(m.id); this.pending.delete(m.id);
      if (m.error) w.reject(new Error((m.error.data && m.error.data.details) || m.error.message)); else w.resolve(m.result);
      return;
    }
    if (m.method === 'session/update') { if (this.onUpdate) this.onUpdate(m.params); return; }
    if (m.method === 'session/request_permission' && m.id !== undefined) {
      const reply = (optionId) => this.write({ jsonrpc: '2.0', id: m.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
      if (this.onPermission) this.onPermission(m.params, reply); else reply(null);
      return;
    }
    if (m.id !== undefined && m.method) this.write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'not supported' } });
  }

  write(obj) { if (this.proc) this.proc.stdin.write(JSON.stringify(obj) + '\n'); }
  call(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.proc) return reject(new Error('агент не запущен'));
      const id = ++this.n; this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }
  async request(method, params) { await this.start(); return this.call(method, params); }
  notify(method, params) { this.write({ jsonrpc: '2.0', method, params }); }
}
const acp = new Acp();

// ---------------------------------------------------------------- chats
const saved = readJson(STATE, { chats: {} });
const chats = new Map(); // chatId -> runtime chat
function chatOf(id) {
  if (!chats.has(id)) {
    const s = saved.chats[id] || {};
    chats.set(id, { id, sessionId: s.sessionId || null, preset: s.preset || 'full', model: s.model || null, effort: s.effort || null,
      options: null, busy: false, reply: '', tools: [], toolInfo: new Map(), progressId: null, lastEdit: 0, lastUse: Date.now(), turns: s.turns || 0, modelList: [] });
  }
  return chats.get(id);
}
function persist() {
  saved.chats = {};
  for (const c of chats.values()) saved.chats[c.id] = { sessionId: c.sessionId, preset: c.preset, model: c.model, effort: c.effort, turns: c.turns };
  try { writeJson(STATE, saved); } catch {}
}
const bySession = (sid) => [...chats.values()].find((c) => c.sessionId === sid);

async function ensureSession(c) {
  if (c.sessionId && acp.active.has(c.sessionId)) return;
  if (c.sessionId) {
    try {
      const r = await acp.request('session/resume', { sessionId: c.sessionId, cwd: PROJECTS, mcpServers: [] });
      acp.active.add(c.sessionId); c.options = r.configOptions || c.options;
      return;
    } catch (e) { log(`resume ${c.sessionId} failed: ${e.message}`); c.sessionId = null; c.turns = 0; }
  }
  fs.writeFileSync(PRESET_FILE, c.preset);
  const r = await acp.request('session/new', { cwd: PROJECTS, mcpServers: [] });
  c.sessionId = r.sessionId; c.options = r.configOptions; c.turns = 0;
  acp.active.add(c.sessionId);
  // The chat's chosen model / effort carry over to every new session.
  for (const [id, value] of [['model', c.model], ['reasoning_effort', c.effort]]) {
    const opt = (c.options || []).find((o) => o.id === id);
    if (value && opt && opt.currentValue !== value) {
      try { c.options = (await acp.request('session/set_config_option', { sessionId: c.sessionId, configId: id, value })).configOptions; }
      catch (e) { log(`set ${id} failed: ${e.message}`); }
    }
  }
  persist();
}

async function closeSession(c) {
  if (c.sessionId && acp.active.has(c.sessionId)) {
    try { await acp.call('session/close', { sessionId: c.sessionId }); } catch {}
    acp.active.delete(c.sessionId);
  }
}

// Close idle sessions (the web agent may open them) and stop the agent when nobody talks to it.
setInterval(async () => {
  for (const c of chats.values()) if (!c.busy && c.sessionId && acp.active.has(c.sessionId) && Date.now() - c.lastUse > IDLE_CLOSE_MS) await closeSession(c);
  if (acp.proc && !acp.active.size && ![...chats.values()].some((c) => c.busy)) { log('idle: stopping agent'); acp.proc.stdin.end(); }
}, 60000);

// ---------------------------------------------------------------- live progress in the chat
function progressText(c) {
  const tools = c.tools.slice(-6).map((t) => `${t.done ? (t.failed ? '✖' : '✓') : '⚙'} ${t.title}`).join('\n');
  const body = c.reply.trim();
  const tail = body.length > 3000 ? '…' + body.slice(-3000) : body;
  return [tools, tail || (c.thinking ? '💭 Думаю…' : '⏳ Работаю…')].filter(Boolean).join('\n\n');
}
async function refresh(c, force) {
  if (!c.progressId || (!force && Date.now() - c.lastEdit < 2500)) return;
  c.lastEdit = Date.now();
  try { await edit(c.id, c.progressId, progressText(c), stopKeyboard()); } catch (e) { if (e.retryAfter) c.lastEdit = Date.now() + e.retryAfter * 1000; }
}
const stopKeyboard = () => ({ reply_markup: { inline_keyboard: [[{ text: '⏹ Остановить', callback_data: 'stop' }]] } });

acp.onUpdate = (p) => {
  const c = bySession(p.sessionId);
  if (!c) return;
  const u = p.update;
  switch (u.sessionUpdate) {
    case 'agent_message_chunk': if (u.content && u.content.type === 'text') c.reply += u.content.text; c.thinking = false; break;
    case 'agent_thought_chunk': c.thinking = true; break;
    case 'tool_call': {
      const t = { id: u.toolCallId, title: String(u.title || u.kind || 'инструмент').slice(0, 80), done: false, raw: u.rawInput };
      c.tools.push(t); c.toolInfo.set(u.toolCallId, t);
      if (c.reply.trim()) c.reply += '\n\n'; // text before and after a tool call are separate paragraphs
      break;
    }
    case 'tool_call_update': {
      const t = c.toolInfo.get(u.toolCallId);
      if (t) { if (u.title) t.title = String(u.title).slice(0, 80); if (u.status === 'completed' || u.status === 'failed') { t.done = true; t.failed = u.status === 'failed'; } if (u.rawInput) t.raw = u.rawInput; }
      break;
    }
    default: return;
  }
  refresh(c);
};

// Permission requests → buttons; the answer goes back to the agent.
const permissions = new Map(); // key -> {reply, chatId, messageId, title}
acp.onPermission = async (params, reply) => {
  const c = bySession(params.sessionId);
  if (!c) return reply(null);
  const t = c.toolInfo.get(params.toolCall && params.toolCall.toolCallId) || {};
  const key = crypto.randomBytes(6).toString('hex');
  const allow = (params.options || []).find((o) => o.kind === 'allow_once') || (params.options || [])[0];
  const reject = (params.options || []).find((o) => o.kind === 'reject_once') || (params.options || [])[1];
  let detail = '';
  if (t.raw) { try { detail = typeof t.raw === 'string' ? t.raw : JSON.stringify(t.raw, null, 1); } catch {} }
  const text = `🔐 Агент просит разрешение:\n**${t.title || 'действие'}**` + (detail ? '\n```\n' + detail.slice(0, 1500) + '\n```' : '');
  try {
    const m = await send(c.id, text, { reply_markup: { inline_keyboard: [[
      { text: '✅ Разрешить', callback_data: `p:${key}:a` }, { text: '❌ Отклонить', callback_data: `p:${key}:r` }]] } });
    permissions.set(key, { reply, chatId: c.id, messageId: m.message_id, title: t.title || 'действие', allow: allow && allow.optionId, reject: reject && reject.optionId });
  } catch (e) { log('permission message failed: ' + e.message); reply(null); }
};

// ---------------------------------------------------------------- files from the agent's answer
function picturesIn(text) {
  const found = new Set();
  for (const m of text.matchAll(/https?:\/\/127\.0\.0\.1:8188\/view\?([^\s)"'<>]+)/g)) {
    const q = new URLSearchParams(m[1].replace(/&amp;/g, '&'));
    if (q.get('filename')) found.add(path.join(COMFY_OUT, q.get('subfolder') || '', q.get('filename')));
  }
  for (const m of text.matchAll(/[A-Za-z]:\\[^\s"'`<>|*?\n]+?\.(?:png|jpe?g|webp|gif)/gi)) found.add(m[0]);
  return [...found].filter((f) => { try { return fs.statSync(f).isFile(); } catch { return false; } }).slice(0, 10);
}
const stripImageLinks = (text) => text.replace(/!\[[^\]]*\]\(https?:\/\/127\.0\.0\.1:8188\/view\?[^)]*\)/g, '').replace(/\n{3,}/g, '\n\n');

// ---------------------------------------------------------------- prompts
async function prompt(c, blocks, label) {
  if (c.busy) return send(c.id, '⏳ Ещё работаю над прошлым запросом. /stop — прервать его.');
  c.busy = true; c.reply = ''; c.tools = []; c.toolInfo = new Map(); c.thinking = false; c.lastUse = Date.now();
  const typing = setInterval(() => tg('sendChatAction', { chat_id: c.id, action: 'typing' }).catch(() => {}), 5000);
  tg('sendChatAction', { chat_id: c.id, action: 'typing' }).catch(() => {});
  let stop = 'error';
  try {
    const m = await send(c.id, acp.proc ? '⏳ Работаю…' : '⏳ Запускаю агента (секунд 10–20)…', stopKeyboard());
    c.progressId = m.message_id; c.lastEdit = Date.now();
    await ensureSession(c);
    await maybeStartLocalModel(c);
    const r = await acp.request('session/prompt', { sessionId: c.sessionId, prompt: blocks });
    stop = r.stopReason; c.turns += 1; persist();
  } catch (e) {
    log(`prompt failed: ${e.stack || e}`);
    c.reply += (c.reply ? '\n\n' : '') + '⚠️ Ошибка: ' + e.message;
  } finally { clearInterval(typing); }
  const note = { cancelled: '\n\n⏹ Остановлено.', max_tokens: '\n\n✂️ Ответ обрезан по лимиту длины.', refusal: '\n\n🚫 Модель отказалась отвечать.' }[stop] || '';
  const full = (c.reply.trim() || (stop === 'end_turn' ? '✓ Готово.' : '')) + note;
  const pics = picturesIn(full);
  const text = stripImageLinks(full).trim() || '✓ Готово.';
  const parts = chunks(text);
  try {
    const toolsLine = c.tools.length ? `🔧 ${c.tools.length} ${c.tools.length === 1 ? 'действие' : 'действий'}: ` + c.tools.slice(-4).map((t) => t.title).join(', ') + '\n\n' : '';
    await edit(c.id, c.progressId, (toolsLine + parts[0]).slice(0, 4000), { reply_markup: { inline_keyboard: [] } });
  } catch { await send(c.id, parts[0]).catch(() => {}); }
  for (const p of parts.slice(1)) await send(c.id, p).catch((e) => log('send failed: ' + e.message));
  for (const f of pics) {
    const big = fs.statSync(f).size > 9.5 * 1048576;
    await tgUpload(big ? 'sendDocument' : 'sendPhoto', { chat_id: String(c.id), caption: path.basename(f) }, big ? 'document' : 'photo', f)
      .catch((e) => log('photo failed: ' + e.message));
  }
  c.busy = false; c.progressId = null; c.lastUse = Date.now();
  saveStatus({ lastMessageAt: Date.now() });
  void label;
}

// ---------------------------------------------------------------- local models: start through the launcher
const httpJson = (url, method = 'GET', body) => new Promise((resolve) => {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  const req = http.request(url, { method, timeout: 8000, headers: { 'Content-Type': 'application/json', 'X-Jarvis': '1', ...(data ? { 'Content-Length': data.length } : {}) } }, (res) => {
    let d = ''; res.on('data', (x) => (d += x)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
  });
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  req.on('error', () => resolve({ status: 0, body: '' }));
  if (data) req.write(data);
  req.end();
});

async function ensureLauncher() {
  if ((await httpJson(LAUNCHER + '/api/ping')).status === 200) return true;
  cp.spawn(process.execPath, [path.join(ROOT, 'launcher', 'server.js'), '--no-window'], { cwd: path.join(ROOT, 'launcher'), detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let i = 0; i < 20; i++) { await sleep(1000); if ((await httpJson(LAUNCHER + '/api/ping')).status === 200) return true; }
  return false;
}

async function maybeStartLocalModel(c) {
  const opt = (c.options || []).find((o) => o.id === 'model');
  let sel; try { sel = JSON.parse(opt && opt.currentValue); } catch { return; }
  if (!Array.isArray(sel) || !String(sel[0]).startsWith('local-')) return;
  if ((await httpJson('http://127.0.0.1:8081/health')).status === 200) return;
  const reg = readJson(path.join(ROOT, 'models', 'registry.json'), { models: [] }).models.find((e) => e.id === sel[1]);
  if (!reg) throw new Error('локальная модель не найдена в лаунчере — выберите другую: /model');
  if (c.progressId) await edit(c.id, c.progressId, `⏳ Загружаю локальную модель ${reg.title} (1–3 минуты)…`).catch(() => {});
  if (!(await ensureLauncher())) throw new Error('не удалось запустить лаунчер, чтобы загрузить локальную модель');
  await httpJson(LAUNCHER + '/api/model/start', 'POST', { id: reg.id, ctx: reg.ctx });
  for (let i = 0; i < 180; i++) {
    await sleep(2000);
    if ((await httpJson('http://127.0.0.1:8081/health')).status === 200) return;
  }
  throw new Error('локальная модель не загрузилась за 6 минут — посмотрите лаунчер');
}

// ---------------------------------------------------------------- commands and menus
const HELP = [
  '**J.A.R.V.I.S. на связи.** Пишите задачу обычным сообщением — агент работает на вашем ПК.',
  '',
  '/model — выбрать модель и глубину рассуждений',
  '/mode — Полный режим (все инструменты) или Лёгкий (для локальных моделей)',
  '/new — начать новую сессию',
  '/stop — прервать текущую задачу',
  '/status — что сейчас выбрано',
  '',
  'Можно присылать фото и файлы — они сохранятся в папку Telegram в проектах, и агент их увидит.',
  'Фото с подписью вроде «убери со стола всё лишнее» или «добавь на полку цветок» — агент отредактирует его и пришлёт результат (2–6 минут).',
  'Опасные действия агент выполнит только после вашей кнопки «Разрешить».',
].join('\n');

function modelMenu(c) {
  const opt = (c.options || []).find((o) => o.id === 'model');
  const eff = (c.options || []).find((o) => o.id === 'reasoning_effort');
  const rows = [];
  c.modelList = [];
  for (const g of (opt && opt.options) || []) {
    for (const o of g.options || [g]) {
      const i = c.modelList.push(o.value) - 1;
      rows.push([{ text: (o.value === opt.currentValue ? '✅ ' : '') + (g.options ? `${o.name}` : o.name), callback_data: `m:${i}` }]);
    }
  }
  if (eff) rows.push((eff.options || []).map((o) => ({ text: (o.value === eff.currentValue ? '✅ ' : '') + (EFFORTS[o.value] || o.name), callback_data: `e:${o.value}` })));
  return rows;
}

async function showModels(c) {
  await ensureSession(c);
  const cur = currentModelName(c);
  await send(c.id, `🧠 Модель сейчас: **${cur}**\nВыберите другую (для текущей сессии и следующих). Нижний ряд — глубина рассуждений.`,
    { reply_markup: { inline_keyboard: modelMenu(c) } });
}
function currentModelName(c) {
  const opt = (c.options || []).find((o) => o.id === 'model');
  if (!opt) return 'по умолчанию';
  for (const g of opt.options || []) for (const o of g.options || [g]) if (o.value === opt.currentValue) return (g.name && g.options ? `${g.name} · ` : '') + o.name;
  return String(opt.currentValue);
}

async function showStatus(c) {
  const eff = (c.options || []).find((o) => o.id === 'reasoning_effort');
  const llama = (await httpJson('http://127.0.0.1:8081/health')).status === 200;
  const comfy = (await httpJson('http://127.0.0.1:8188/system_stats')).status === 200;
  await send(c.id, [
    `**Сессия:** ${c.sessionId ? `${c.turns} сообщ.` : 'новая'} · ${PRESETS[c.preset] || c.preset}`,
    `**Модель:** ${c.options ? currentModelName(c) : (c.model ? 'выбрана' : 'по умолчанию')}` + (eff ? ` · рассуждения: ${EFFORTS[eff.currentValue] || eff.currentValue}` : ''),
    `**Локальная модель:** ${llama ? 'загружена' : 'не загружена'} · **ComfyUI:** ${comfy ? 'запущен' : 'выключен'}`,
    `**Папка:** ${PROJECTS}`,
  ].join('\n'));
}

async function onCallback(q) {
  const c = chatOf(q.message.chat.id);
  const data = q.data || '';
  let answer = '';
  try {
    if (data === 'stop') { if (c.busy && c.sessionId) acp.notify('session/cancel', { sessionId: c.sessionId }); answer = 'Останавливаю…'; }
    else if (data.startsWith('p:')) {
      const [, key, choice] = data.split(':');
      const p = permissions.get(key);
      if (!p) answer = 'Запрос уже неактуален';
      else {
        permissions.delete(key);
        p.reply(choice === 'a' ? p.allow : p.reject);
        answer = choice === 'a' ? 'Разрешено' : 'Отклонено';
        await edit(p.chatId, p.messageId, `${choice === 'a' ? '✅ Разрешено' : '❌ Отклонено'}: ${p.title}`, { reply_markup: { inline_keyboard: [] } }).catch(() => {});
      }
    } else if (data.startsWith('m:') || data.startsWith('e:')) {
      await ensureSession(c);
      const isModel = data.startsWith('m:');
      const value = isModel ? c.modelList[Number(data.slice(2))] : data.slice(2);
      if (value === undefined) answer = 'Меню устарело — /model';
      else {
        c.options = (await acp.request('session/set_config_option', { sessionId: c.sessionId, configId: isModel ? 'model' : 'reasoning_effort', value })).configOptions;
        if (isModel) c.model = value; else c.effort = value;
        persist();
        answer = 'Готово';
        let note = '';
        try { if (isModel && String(JSON.parse(value)[0]).startsWith('local-')) note = '\n💻 Локальная модель: загружу её сама при следующем сообщении. Для неё удобнее /mode → Лёгкий режим.'; } catch {}
        await edit(c.id, q.message.message_id, `🧠 Модель: **${currentModelName(c)}**${note}`, { reply_markup: { inline_keyboard: modelMenu(c) } }).catch(() => {});
      }
    } else if (data.startsWith('mode:')) {
      const id = data.slice(5);
      if (!PRESETS[id]) answer = '?';
      else {
        const changed = c.preset !== id;
        c.preset = id; persist();
        const started = c.sessionId && c.turns > 0;
        answer = PRESETS[id];
        await edit(c.id, q.message.message_id, `⚙️ ${PRESETS[id]}.` + (changed && started ? ' Применится в новой сессии.' : ''), {
          reply_markup: { inline_keyboard: changed && started ? [[{ text: '🆕 Начать новую сессию', callback_data: 'new' }]] : [] } }).catch(() => {});
        if (changed && !started) { await closeSession(c); c.sessionId = null; persist(); }
      }
    } else if (data === 'new') { await closeSession(c); c.sessionId = null; c.turns = 0; persist(); answer = 'Новая сессия'; await send(c.id, '🆕 Новая сессия. Слушаю.'); }
  } catch (e) { answer = 'Ошибка: ' + e.message.slice(0, 150); log('callback: ' + e.message); }
  await tg('answerCallbackQuery', { callback_query_id: q.id, text: answer }).catch(() => {});
}

// ---------------------------------------------------------------- incoming messages
const warned = new Map(); // strangers: one reply per hour
async function onMessage(msg) {
  if (!msg.chat || msg.chat.type !== 'private' || !msg.from) return;
  const cfg = readConfig();
  const allowed = (cfg.users || []).some((u) => u.id === msg.from.id);
  const text = (msg.text || msg.caption || '').trim();
  if (!allowed) {
    const code = (text.match(/^(?:\/start\s+)?(\d{6})$/) || [])[1];
    if (code && cfg.pair && cfg.pair.until > Date.now()) {
      if (String(cfg.pair.code).length === 6 && crypto.timingSafeEqual(Buffer.from(code), Buffer.from(String(cfg.pair.code)))) {
        cfg.users = [...(cfg.users || []), { id: msg.from.id, name: [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' '), username: msg.from.username || null, pairedAt: Date.now() }];
        delete cfg.pair;
        writeJson(CONFIG, cfg);
        log(`paired user ${msg.from.id}`);
        return send(msg.chat.id, '✅ Телефон привязан к вашему J.A.R.V.I.S.\n\n' + HELP);
      }
      cfg.pair.fails = (cfg.pair.fails || 0) + 1;
      if (cfg.pair.fails >= 5) delete cfg.pair; // brute force: the code dies
      writeJson(CONFIG, cfg);
      return send(msg.chat.id, '❌ Неверный код.');
    }
    if (Date.now() - (warned.get(msg.from.id) || 0) > 3600000) {
      warned.set(msg.from.id, Date.now());
      log(`stranger ${msg.from.id} (${msg.from.username || ''})`);
      return send(msg.chat.id, '🔒 Это личный бот J.A.R.V.I.S. Доступ выдаёт владелец в лаунчере: «Telegram-бот» → «Привязать телефон».');
    }
    return;
  }

  const c = chatOf(msg.chat.id);
  const cmd = (text.match(/^\/(\w+)/) || [])[1];
  if (cmd === 'start' || cmd === 'help') return send(c.id, HELP);
  if (cmd === 'new') { await closeSession(c); c.sessionId = null; c.turns = 0; persist(); return send(c.id, `🆕 Новая сессия (${PRESETS[c.preset]}). Слушаю.`); }
  if (cmd === 'stop') { if (c.busy && c.sessionId) { acp.notify('session/cancel', { sessionId: c.sessionId }); return send(c.id, '⏹ Останавливаю…'); } return send(c.id, 'Сейчас ничего не выполняется.'); }
  if (cmd === 'status') return showStatus(c);
  if (cmd === 'model') return showModels(c).catch((e) => send(c.id, '⚠️ ' + e.message));
  if (cmd === 'mode') {
    return send(c.id, `Режим сейчас: **${PRESETS[c.preset]}**.\nПолный — все инструменты (браузер, Windows, картинки, Blender…), лучше с DeepSeek. Лёгкий — компактный набор для локальных моделей.`,
      { reply_markup: { inline_keyboard: [Object.entries(PRESETS).map(([id, name]) => ({ text: (id === c.preset ? '✅ ' : '') + name, callback_data: `mode:${id}` }))] } });
  }
  if (cmd) return send(c.id, 'Не знаю такой команды. /help — список.');

  // Photos and files: saved into the projects folder, the agent gets the path (it has read/read_image).
  const notes = [];
  try {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    if (msg.photo && msg.photo.length) notes.push(await tgDownload(msg.photo[msg.photo.length - 1].file_id, path.join(INBOX, `photo_${stamp}.jpg`)));
    if (msg.document) notes.push(await tgDownload(msg.document.file_id, path.join(INBOX, `${stamp}_${(msg.document.file_name || 'file').replace(/[<>:"/\\|?*]/g, '_')}`)));
    if (msg.voice || msg.audio || msg.video_note) return send(c.id, '🎙 Голосовые пока не понимаю — напишите текстом.');
  } catch (e) { return send(c.id, '⚠️ Не удалось получить файл: ' + e.message); }
  if (!text && !notes.length) return;
  const body = (text || (notes.length ? 'Посмотри присланный файл.' : '')) +
    (notes.length ? '\n\n[Файлы из Telegram сохранены: ' + notes.join(', ') + ']' : '');
  return prompt(c, [{ type: 'text', text: body }]);
}

// ---------------------------------------------------------------- main loop
(async () => {
  log(`bot starting (pid ${process.pid})`);
  let me;
  for (let i = 0; ; i++) {
    try { me = await tg('getMe', {}, 20000); break; }
    catch (e) {
      saveStatus({ telegram: 'error', error: e.message });
      log('getMe: ' + e.message);
      if (/Unauthorized|401|Not Found/i.test(e.message)) process.exit(2); // bad token: the launcher shows the error
      await sleep(Math.min(60000, 5000 * (i + 1)));
    }
  }
  saveStatus({ telegram: 'on', username: me.username, error: null });
  log(`connected as @${me.username}`);
  await tg('setMyCommands', { commands: [
    { command: 'model', description: 'Выбрать модель' }, { command: 'mode', description: 'Полный / Лёгкий режим' },
    { command: 'new', description: 'Новая сессия' }, { command: 'stop', description: 'Прервать задачу' },
    { command: 'status', description: 'Что сейчас выбрано' }, { command: 'help', description: 'Помощь' }] }).catch(() => {});
  let offset = 0;
  for (;;) {
    try {
      const updates = await tg('getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] }, 70000);
      if (status.telegram !== 'on') saveStatus({ telegram: 'on', error: null });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) onMessage(u.message).catch((e) => log('message: ' + (e.stack || e)));
        else if (u.callback_query) {
          const allowed = (readConfig().users || []).some((x) => x.id === u.callback_query.from.id);
          if (allowed) onCallback(u.callback_query).catch((e) => log('callback: ' + (e.stack || e)));
        }
      }
    } catch (e) {
      log('getUpdates: ' + e.message);
      saveStatus({ telegram: 'error', error: e.message });
      if (/Unauthorized/i.test(e.message)) process.exit(2);
      if (/Conflict/i.test(e.message)) await sleep(15000); // another copy polls with this token
      else await sleep(e.retryAfter ? e.retryAfter * 1000 : 5000);
    }
  }
})();
