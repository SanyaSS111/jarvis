// dsh-jarvis — host half.
//
// Speaks finished assistant replies for sessions whose voice mode is open in the
// browser. Speech is synthesized with the free Microsoft Edge voices through the
// `edge-tts` CLI run by uv (cached, so it starts offline).
//
// Routes:
//   POST /dsh-jarvis/mode     {sessionId, active}          -> {ok}
//   GET  /dsh-jarvis/pending  ?session=<id>&after=<seq>    -> {ok, items:[{seq, text, mime, audioBase64}]}
//   POST /dsh-jarvis/speak    {text}                       -> {ok, mime, audioBase64}   (greeting / test)
//   GET  /dsh-jarvis/status                                -> {ok, activeSessions, voices}
//   GET  /dsh-jarvis/theme                                 -> {ok, enabled, accent:[r,g,b]}   (Jarvis skin)
//   POST /dsh-jarvis/theme    {enabled}                    -> {ok, enabled}
//   GET  /dsh-jarvis/theme.css                             -> the skin stylesheet (lib/theme.css)

// No third-party imports on purpose: the package is linked from C:\LLM\agent\plugins,
// where the profile's node_modules are not resolvable, and a failed import here
// would stop the whole Harness from booting.
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const THEME_CSS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'theme.css')

export const name = 'dsh-jarvis'
export const inject = ['webServer']

const DEFAULTS = {
  uvx: 'C:\\LLM\\runtime\\uv\\uvx.exe',
  voiceRu: 'ru-RU-DmitryNeural',
  voiceEn: 'en-GB-RyanNeural',
  rate: '-6%',
  pitch: '-6Hz',
  maxSpokenChars: 900,
  timeoutMs: 60000,
  // Jarvis skin switch (shared with the J.A.R.V.I.S. launcher) and the wallpaper config whose
  // accent colour the skin follows.
  themeFile: 'C:\\LLM\\data\\agent\\jarvis-theme.json',
  hudConfig: path.join(process.env.APPDATA || '', 'JarvisHUD2', 'config.json'),
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}

async function themeState(cfg) {
  const saved = await readJson(cfg.themeFile)
  const hud = await readJson(cfg.hudConfig)
  const accent = Array.isArray(hud && hud.accent) && hud.accent.length === 3
    ? hud.accent.map((v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 255))
    : [92, 225, 255]
  return { enabled: !saved || saved.enabled !== false, accent }
}

// ------------------------------------------------------------ text helpers

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && (b.type === 'text' || typeof b.text === 'string') && b.type !== 'thinking' && b.type !== 'reasoning')
    .map((b) => b.text || '')
    .join('')
}

/** Markdown → something pleasant to hear. Code is summarized, not read. */
export function toSpeech(text, maxChars) {
  let s = String(text || '')
  s = s.replace(/```[\s\S]*?```/g, ' (код показан в чате) ')
  s = s.replace(/`([^`]+)`/g, '$1')
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  s = s.replace(/^\s{0,3}#{1,6}\s*/gm, '')
  s = s.replace(/^\s*[-*+]\s+/gm, '')
  s = s.replace(/^\s*\d+\.\s+/gm, '')
  s = s.replace(/^\s*\|.*\|\s*$/gm, ' ')
  s = s.replace(/[*_~>#]/g, '')
  s = s.replace(/https?:\/\/\S+/g, ' ссылка ')
  s = s.replace(/\s+/g, ' ').trim()
  if (s.length > maxChars) {
    const cut = s.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
    s = (end > maxChars * 0.5 ? cut.slice(0, end + 1) : cut) + ' Остальное — в чате.'
  }
  return s
}

function pickVoice(text, cfg) {
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length
  const lat = (text.match(/[A-Za-z]/g) || []).length
  return cyr >= lat ? cfg.voiceRu : cfg.voiceEn
}

function runEdgeTts(cfg, text, outFile) {
  return new Promise((resolve, reject) => {
    const args = ['--offline', '--python', '3.12', 'edge-tts',
      '--voice', pickVoice(text, cfg), `--rate=${cfg.rate}`, `--pitch=${cfg.pitch}`,
      '--text', text, '--write-media', outFile]
    const env = {
      ...process.env,
      UV_PYTHON_INSTALL_DIR: 'C:\\LLM\\runtime\\uv\\python',
      UV_CACHE_DIR: 'C:\\LLM\\runtime\\uv\\cache',
      UV_PYTHON_PREFERENCE: 'only-managed',
    }
    const child = spawn(cfg.uvx, args, { env, windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d.toString() })
    const timer = setTimeout(() => { child.kill(); reject(new Error('edge-tts timeout')) }, cfg.timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`edge-tts exit ${code}: ${stderr.slice(-300)}`))
    })
  })
}

async function synthesize(cfg, text) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dsh-jarvis-'))
  const out = path.join(dir, 'out.mp3')
  try {
    await runEdgeTts(cfg, text, out)
    const bytes = await readFile(out)
    if (!bytes || bytes.length < 64) throw new Error('edge-tts produced empty audio')
    return { mime: 'audio/mpeg', audioBase64: bytes.toString('base64') }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ------------------------------------------------------------ http helpers

function writeJson(res, status, body) {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(data)
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

// ------------------------------------------------------------ plugin

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const active = new Map()      // sessionId -> lastSeenAt
  const collectors = new Map()  // sessionId -> string[]
  const queues = new Map()      // sessionId -> [{seq, text, mime, audioBase64}]
  let seq = 0

  const isActive = (sid) => {
    const at = active.get(sid)
    if (!at) return false
    if (Date.now() - at > 10 * 60 * 1000) { active.delete(sid); return false }
    return true
  }

  const enqueue = (sid, item) => {
    const q = queues.get(sid) || []
    q.push(item)
    while (q.length > 20) q.shift()
    queues.set(sid, q)
  }

  // Diagnostics: last session events seen by this plugin (shown on /dsh-jarvis/status).
  const recentEvents = []
  const noteEvent = (sid, type, activeNow) => {
    recentEvents.push({ at: new Date().toISOString(), sessionId: sid || null, type: type || null, active: activeNow })
    while (recentEvents.length > 30) recentEvents.shift()
  }

  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sid = session && session.id
    noteEvent(sid, event && event.type, !!(sid && isActive(sid)))
    if (!sid || !isActive(sid) || !event) return
    if (event.type === 'assistant/message') {
      const text = blocksToText(event.data && event.data.message && event.data.message.content)
      if (text) {
        const parts = collectors.get(sid) || []
        parts.push(text)
        collectors.set(sid, parts)
      }
      return
    }
    if (event.type !== 'turn/end') return
    const parts = collectors.get(sid) || []
    collectors.delete(sid)
    // Speak the final answer: the last assistant message of the turn.
    const last = parts.length ? parts[parts.length - 1] : ''
    const spoken = toSpeech(last, cfg.maxSpokenChars)
    if (!spoken) return
    const id = ++seq
    synthesize(cfg, spoken)
      .then((out) => enqueue(sid, { seq: id, text: spoken, ...out }))
      .catch((err) => enqueue(sid, { seq: id, text: spoken, error: String(err && err.message || err) }))
  }), 'dsh-jarvis: speak finished replies')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/mode',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false }); return }
      try {
        const body = await readBody(req)
        const sid = String(body.sessionId || '')
        if (!sid) { writeJson(res, 400, { ok: false, error: 'sessionId required' }); return }
        if (body.active) active.set(sid, Date.now())
        else { active.delete(sid); collectors.delete(sid) }
        writeJson(res, 200, { ok: true })
      } catch (e) { writeJson(res, 400, { ok: false, error: String(e && e.message || e) }) }
    },
  }), 'dsh-jarvis: /mode route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/pending',
    handler: async (req, res) => {
      if (req.method !== 'GET') { writeJson(res, 405, { ok: false }); return }
      const url = new URL(req.url, 'http://local')
      const sid = url.searchParams.get('session') || ''
      const after = Number(url.searchParams.get('after') || 0)
      if (sid && active.has(sid)) active.set(sid, Date.now())
      const items = (queues.get(sid) || []).filter((x) => x.seq > after)
      writeJson(res, 200, { ok: true, items })
    },
  }), 'dsh-jarvis: /pending route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/speak',
    handler: async (req, res) => {
      if (req.method !== 'POST') { writeJson(res, 405, { ok: false }); return }
      try {
        const body = await readBody(req)
        const spoken = toSpeech(String(body.text || ''), cfg.maxSpokenChars)
        if (!spoken) { writeJson(res, 400, { ok: false, error: 'text required' }); return }
        const out = await synthesize(cfg, spoken)
        writeJson(res, 200, { ok: true, text: spoken, ...out })
      } catch (e) { writeJson(res, 500, { ok: false, error: String(e && e.message || e) }) }
    },
  }), 'dsh-jarvis: /speak route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/status',
    handler: async (req, res) => {
      writeJson(res, 200, {
        ok: true,
        activeSessions: [...active.keys()].filter(isActive),
        voices: { ru: cfg.voiceRu, en: cfg.voiceEn, rate: cfg.rate, pitch: cfg.pitch },
        queued: Object.fromEntries([...queues.entries()].map(([sid, q]) => [sid, q.map((x) => ({ seq: x.seq, error: x.error || null, chars: (x.text || '').length }))])),
        recentEvents: recentEvents.slice(-15),
      })
    },
  }), 'dsh-jarvis: /status route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/theme',
    handler: async (req, res) => {
      try {
        if (req.method === 'POST') {
          const body = await readBody(req)
          await mkdir(path.dirname(cfg.themeFile), { recursive: true })
          await writeFile(cfg.themeFile, JSON.stringify({ enabled: !!body.enabled }, null, 2))
        } else if (req.method !== 'GET') { writeJson(res, 405, { ok: false }); return }
        writeJson(res, 200, { ok: true, ...(await themeState(cfg)) })
      } catch (e) { writeJson(res, 500, { ok: false, error: String(e && e.message || e) }) }
    },
  }), 'dsh-jarvis: /theme route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-jarvis/theme.css',
    handler: async (req, res) => {
      try {
        const css = await readFile(THEME_CSS, 'utf8')
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' })
        res.end(css)
      } catch (e) { res.writeHead(404); res.end() }
    },
  }), 'dsh-jarvis: /theme.css route')
}
