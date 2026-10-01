// dsh-jarvis — client half (browser).
//
// A reactor button in conversation.input.right opens a full-screen voice mode:
//   * animated arc reactor that reacts to the state (listening / thinking / speaking);
//   * speech is recognized by the browser (Web Speech API, ru-RU) and sent into the
//     SAME chat via the composer (setDraft + submit), so the conversation stays in chat;
//   * when the agent finishes (session.running goes false) the newest finished
//     assistant message is read from the chat view (useConversation → views 'chat' →
//     legacy.nodes), synthesized on the host (/dsh-jarvis/speak, Edge voice) and played;
//     then the mode listens again;
//   * click the reactor (or press Esc) to go back to the normal chat.
// The overlay is plain DOM on document.body (react-dom is not exposed to plugins).
//
// Why not host-side session events: session events are delivered only inside the
// session's own (agent-preset) scope, so a root-level plugin never sees the turns.

window.__ModuleLoader__.load({
  id: 'dsh-jarvis',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const STYLE_ID = 'dsh-jarvis-style'
    const CSS = `
.dj-btn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;border:0;background:transparent;cursor:pointer;padding:0}
.dj-btn:hover{background:rgba(120,200,255,.12)}
.dj-btn svg{width:22px;height:22px}
.dj-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;align-items:center;justify-content:center;
  background:radial-gradient(ellipse at center,rgba(8,20,32,.94) 0%,rgba(2,6,12,.98) 70%);color:#bfefff;font-family:"Segoe UI",system-ui,sans-serif;
  opacity:0;transition:opacity .25s ease}
.dj-overlay.dj-open{opacity:1}
.dj-reactor{position:relative;width:min(56vmin,340px);height:min(56vmin,340px);cursor:pointer;border:0;background:transparent;padding:0;
  --lvl:0;--hue:195}
.dj-reactor:focus-visible{outline:2px solid #6fdcff;outline-offset:8px;border-radius:50%}
.dj-glow{position:absolute;inset:-18%;border-radius:50%;
  background:radial-gradient(circle,hsla(var(--hue),100%,70%,calc(.35 + var(--lvl)*.5)) 0%,hsla(var(--hue),100%,55%,.12) 38%,transparent 66%);
  filter:blur(6px);transition:background .2s}
.dj-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.dj-spin{transform-origin:50% 50%;animation:dj-rot 14s linear infinite}
.dj-spin-rev{transform-origin:50% 50%;animation:dj-rot 9s linear infinite reverse}
.dj-core{transform-origin:50% 50%;transform:scale(calc(1 + var(--lvl)*.18));transition:transform .08s linear}
@keyframes dj-rot{to{transform:rotate(360deg)}}
@keyframes dj-pulse{0%,100%{opacity:.55}50%{opacity:1}}
.dj-state-thinking .dj-spin{animation-duration:2.6s}
.dj-state-thinking .dj-spin-rev{animation-duration:1.8s}
.dj-state-thinking .dj-core-ring{animation:dj-pulse 1.1s ease-in-out infinite}
.dj-state-speaking .dj-spin{animation-duration:6s}
.dj-state-idle .dj-spin,.dj-state-idle .dj-spin-rev{animation-duration:30s}
.dj-status{margin-top:34px;font-size:15px;letter-spacing:.18em;text-transform:uppercase;color:#8fd8ff;min-height:20px;text-align:center}
.dj-caption{margin-top:14px;max-width:min(80vw,720px);min-height:48px;font-size:17px;line-height:1.45;text-align:center;color:#e6f7ff;opacity:.92}
.dj-hint{position:absolute;bottom:22px;font-size:12px;color:#5aa9c9;letter-spacing:.06em;text-align:center;padding:0 16px}
.dj-err{color:#ff9a8a}
`

    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = CSS
      document.head.appendChild(el)
    }

    const REACTOR_SVG = `
<svg class="dj-svg" viewBox="0 0 200 200" aria-hidden="true">
  <defs>
    <radialGradient id="djCore" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="35%" stop-color="#cff6ff"/>
      <stop offset="70%" stop-color="#5fd6ff"/>
      <stop offset="100%" stop-color="#1b8fd6" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <circle cx="100" cy="100" r="92" fill="none" stroke="#1e6f96" stroke-width="2" opacity=".55"/>
  <g class="dj-spin">
    <circle cx="100" cy="100" r="84" fill="none" stroke="#6fdcff" stroke-width="3" stroke-dasharray="22 10" opacity=".85"/>
  </g>
  <g class="dj-spin-rev">
    <circle cx="100" cy="100" r="70" fill="none" stroke="#9beaff" stroke-width="1.6" stroke-dasharray="4 7" opacity=".9"/>
  </g>
  <g>
    ${Array.from({ length: 10 }).map((_, i) => {
      const a = (i * 36) * Math.PI / 180
      const x1 = 100 + Math.cos(a) * 42, y1 = 100 + Math.sin(a) * 42
      const x2 = 100 + Math.cos(a) * 60, y2 = 100 + Math.sin(a) * 60
      return `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#bff3ff" stroke-width="7" stroke-linecap="round" opacity=".9"/>`
    }).join('')}
  </g>
  <g class="dj-core">
    <circle class="dj-core-ring" cx="100" cy="100" r="36" fill="none" stroke="#e9fbff" stroke-width="4"/>
    <circle cx="100" cy="100" r="30" fill="url(#djCore)"/>
    <polygon points="100,78 119,111 81,111" fill="none" stroke="#ffffff" stroke-width="2.4" opacity=".85"/>
  </g>
</svg>`

    const ICON_SVG = React.createElement('svg', { viewBox: '0 0 24 24', 'aria-hidden': true },
      React.createElement('circle', { cx: 12, cy: 12, r: 10, fill: 'none', stroke: '#4fc8f5', strokeWidth: 1.6 }),
      React.createElement('circle', { cx: 12, cy: 12, r: 6.5, fill: 'none', stroke: '#8fe3ff', strokeWidth: 1.2, strokeDasharray: '2 1.6' }),
      React.createElement('circle', { cx: 12, cy: 12, r: 3.2, fill: '#bff3ff' }))

    // Interface language from the launcher (sent with the theme state, see syncTheme); English by default.
    let LANG = 'en'
    const L = (ru, en) => (LANG === 'ru' ? ru : en)
    const STATUS = () => ({
      idle: L('Готов', 'Ready'),
      listening: L('Слушаю…', 'Listening…'),
      thinking: L('Думаю…', 'Thinking…'),
      speaking: L('Говорю…', 'Speaking…'),
      error: L('Ошибка', 'Error'),
    })

    // ---------------------------------------------------------------- chat reading

    /** Prefix put on spoken messages; ~/.dsh/AGENTS.md tells the agent to answer these briefly, Jarvis-style. */
    const VOICE_MARKER = () => L('[Голос]', '[Voice]')

    /** Only the spoken part: everything before a line consisting of `---` (details for the chat come after it). */
    function spokenPart(text) {
      const s = String(text || '')
      const m = s.match(/(^|\n)\s*-{3,}\s*(\n|$)/)
      return (m ? s.slice(0, m.index) : s).trim()
    }

    /** Newest finished (not interrupted) assistant message of the chat view (spoken part only), or null. */
    function lastAssistantFromChat(chat) {
      const nodes = chat && chat.legacy && chat.legacy.nodes
      if (!nodes || !nodes.length) return null
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]
        if (!n || n.kind !== 'assistant' || n.interrupted) continue
        const text = (n.blocks || []).filter((b) => b && b.kind === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim()
        if (!text) continue
        const spoken = spokenPart(text)
        if (!spoken) continue
        return { seq: n.seq, text: spoken }
      }
      return null
    }

    // ---------------------------------------------------------------- voice session

    function createVoiceMode(getLive) {
      ensureStyle()
      const root = document.createElement('div')
      root.className = 'dj-overlay dj-state-idle'
      root.setAttribute('role', 'dialog')
      root.setAttribute('aria-label', L('Голосовой режим Джарвис', 'Jarvis voice mode'))
      root.innerHTML = `
        <button class="dj-reactor" type="button" aria-label="${L('Вернуться в чат', 'Back to chat')}">
          <div class="dj-glow"></div>${REACTOR_SVG}
        </button>
        <div class="dj-status" aria-live="polite"></div>
        <div class="dj-caption"></div>
        <div class="dj-hint">${L('Нажмите на реактор или Esc, чтобы вернуться в чат', 'Click the reactor or press Esc to return to the chat')}</div>`
      document.body.appendChild(root)
      requestAnimationFrame(() => root.classList.add('dj-open'))

      const reactor = root.querySelector('.dj-reactor')
      const statusEl = root.querySelector('.dj-status')
      const captionEl = root.querySelector('.dj-caption')

      let state = 'idle'
      let closed = false
      let recognition = null
      let audio = null
      let watchTimer = null
      let meterRaf = 0
      let mediaStream = null
      let audioCtx = null
      let waiting = null   // { sinceSeq, sentAt, sawRunning }

      function setState(next, caption) {
        state = next
        root.className = 'dj-overlay dj-open dj-state-' + next
        statusEl.textContent = STATUS()[next] || ''
        statusEl.classList.toggle('dj-err', next === 'error')
        if (caption !== undefined) captionEl.textContent = caption
      }

      function setLevel(v) { reactor.style.setProperty('--lvl', String(Math.max(0, Math.min(1, v)))) }

      async function startMeter() {
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
          audioCtx = new (window.AudioContext || window.webkitAudioContext)()
          const src = audioCtx.createMediaStreamSource(mediaStream)
          const an = audioCtx.createAnalyser()
          an.fftSize = 512
          src.connect(an)
          const buf = new Uint8Array(an.fftSize)
          const tick = () => {
            if (closed) return
            if (state === 'listening') {
              an.getByteTimeDomainData(buf)
              let sum = 0
              for (let i = 0; i < buf.length; i++) { const d = (buf[i] - 128) / 128; sum += d * d }
              setLevel(Math.sqrt(sum / buf.length) * 4)
            }
            meterRaf = requestAnimationFrame(tick)
          }
          tick()
          return true
        } catch (e) {
          setState('error', L('Нет доступа к микрофону. Разрешите микрофон для этого окна и откройте режим снова.', 'No microphone access. Allow the microphone for this window and open voice mode again.'))
          return false
        }
      }

      function speechCtor() { return window.SpeechRecognition || window.webkitSpeechRecognition || null }

      function listen() {
        if (closed) return
        const Ctor = speechCtor()
        if (!Ctor) { setState('error', L('Этот браузер не умеет распознавать речь. Откройте DeepSeek Harness ярлыком (окно Edge).', 'This browser cannot recognize speech. Open DeepSeek Harness from its shortcut (an Edge window).')); return }
        if (recognition) { try { recognition.abort() } catch (e) {} }
        const rec = new Ctor()
        recognition = rec
        rec.lang = L('ru-RU', 'en-US')
        rec.continuous = false
        rec.interimResults = true
        rec.maxAlternatives = 1
        let finalText = ''
        rec.onstart = () => setState('listening', '')
        rec.onresult = (ev) => {
          let interim = ''
          for (let i = ev.resultIndex; i < ev.results.length; i++) {
            const r = ev.results[i]
            if (r.isFinal) finalText += r[0].transcript
            else interim += r[0].transcript
          }
          captionEl.textContent = (finalText + ' ' + interim).trim()
        }
        rec.onerror = (ev) => {
          if (closed) return
          if (ev.error === 'no-speech' || ev.error === 'aborted') return
          if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
            setState('error', L('Распознавание речи запрещено. Разрешите микрофон для этого окна.', 'Speech recognition is blocked. Allow the microphone for this window.'))
            return
          }
          setState('error', L('Ошибка распознавания: ', 'Recognition error: ') + ev.error)
        }
        rec.onend = () => {
          if (closed || recognition !== rec) return
          const text = finalText.trim()
          if (text) { send(text); return }
          if (state === 'listening') setTimeout(listen, 250)   // nothing heard — keep listening
        }
        try { rec.start() } catch (e) { setTimeout(listen, 500) }
      }

      function send(text) {
        const live = getLive()
        const actions = live.inputActions
        if (!actions || typeof actions.setDraft !== 'function' || typeof actions.submit !== 'function') {
          setState('error', L('Поле ввода недоступно — откройте сессию и попробуйте снова.', 'The input box is unavailable — open a session and try again.'))
          return
        }
        const last = live.lastAssistant
        waiting = { sinceSeq: last ? last.seq : -Infinity, sentAt: Date.now(), sawRunning: false }
        setLevel(0)
        setState('thinking', text)
        // The marker tells the agent (see ~/.dsh/AGENTS.md) this was spoken: short Jarvis-style reply.
        actions.setDraft(VOICE_MARKER() + ' ' + text)
        setTimeout(() => { try { actions.submit() } catch (e) { setState('error', L('Не удалось отправить сообщение.', 'Could not send the message.')) } }, 0)
      }

      async function speak(text) {
        try {
          const res = await fetch('/dsh-jarvis/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
          const data = await res.json()
          if (!data || !data.ok) return { text, error: (data && data.error) || 'tts failed' }
          return { text: data.text || text, mime: data.mime, audioBase64: data.audioBase64 }
        } catch (e) { return { text, error: String(e) } }
      }

      function play(item) {
        return new Promise((resolve) => {
          if (item.error || !item.audioBase64) { captionEl.textContent = item.text || ''; resolve(); return }
          setState('speaking', item.text)
          audio = new Audio('data:' + (item.mime || 'audio/mpeg') + ';base64,' + item.audioBase64)
          let raf = 0
          const wobble = () => { if (state === 'speaking' && !closed) { setLevel(0.35 + Math.random() * 0.45); raf = requestAnimationFrame(wobble) } }
          audio.onplay = () => wobble()
          const done = () => { cancelAnimationFrame(raf); setLevel(0); audio = null; resolve() }
          audio.onended = done
          audio.onerror = done
          audio.play().catch(done)
        })
      }

      // Watch the chat: once the turn we started has finished, speak the newest reply.
      async function watch() {
        if (closed) return
        try {
          if (waiting) {
            const live = getLive()
            if (live.running) waiting.sawRunning = true
            const last = live.lastAssistant
            const fresh = last && last.seq > waiting.sinceSeq
            const turnOver = !live.running && (waiting.sawRunning || Date.now() - waiting.sentAt > 4000)
            if (fresh && turnOver) {
              waiting = null
              const item = await speak(last.text)
              if (!closed) await play(item)
              if (!closed) listen()
            } else if (turnOver && !fresh && Date.now() - waiting.sentAt > 20000) {
              // Turn ended without a text reply (e.g. only tool output) — listen again.
              waiting = null
              if (!closed) listen()
            }
          }
        } catch (e) { /* transient */ }
        if (!closed) watchTimer = setTimeout(watch, 400)
      }

      async function greet() {
        const item = await speak(L('Слушаю, сэр.', 'At your service, sir.'))
        if (!closed) await play(item)
      }

      function close() {
        if (closed) return
        closed = true
        clearTimeout(watchTimer)
        cancelAnimationFrame(meterRaf)
        if (recognition) { try { recognition.abort() } catch (e) {} recognition = null }
        if (audio) { try { audio.pause() } catch (e) {} audio = null }
        if (mediaStream) { mediaStream.getTracks().forEach((t) => t.stop()); mediaStream = null }
        if (audioCtx) { try { audioCtx.close() } catch (e) {} audioCtx = null }
        document.removeEventListener('keydown', onKey, true)
        root.classList.remove('dj-open')
        setTimeout(() => root.remove(), 260)
      }

      function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close() } }

      reactor.addEventListener('click', () => {
        // Speaking → tap interrupts and listens; otherwise tap returns to chat.
        if (state === 'speaking' && audio) { try { audio.pause() } catch (e) {} audio = null; setLevel(0); listen(); return }
        close()
      })
      document.addEventListener('keydown', onKey, true)

      setState('idle', '')
      watch()
      startMeter().then(async (ok) => {
        if (!ok || closed) return
        await greet()
        if (!closed && state !== 'error') listen()
      })

      return { close, isClosed: () => closed }
    }

    // ---------------------------------------------------------------- composer button

    const selectChat = (s) => (s && s.views && typeof s.views.get === 'function') ? s.views.get('chat') : undefined

    function ReactorButton(props) {
      const chat = typeof props.useConversation === 'function' ? props.useConversation(selectChat) : undefined
      const lastAssistant = lastAssistantFromChat(chat)
      const running = !!(props.session && props.session.running)

      const liveRef = React.useRef(null)
      liveRef.current = { inputActions: props.inputActions, running, lastAssistant, sessionId: props.session && props.session.sessionId }
      const modeRef = React.useRef(null)

      React.useEffect(() => {
        // Debug helper for verification from devtools.
        window.__djLastAssistant = () => {
          const live = liveRef.current || {}
          const la = live.lastAssistant
          return { sessionId: live.sessionId || null, running: !!live.running, seq: la ? la.seq : null, text: la ? la.text.slice(0, 200) : null }
        }
        return () => { if (modeRef.current) modeRef.current.close() }
      }, [])

      const open = React.useCallback(() => {
        if (modeRef.current && !modeRef.current.isClosed()) return
        modeRef.current = createVoiceMode(() => liveRef.current || {})
      }, [])

      return React.createElement('button', {
        type: 'button',
        className: 'dj-btn',
        title: L('Голосовой режим (Джарвис)', 'Voice mode (Jarvis)'),
        'aria-label': L('Голосовой режим (Джарвис)', 'Voice mode (Jarvis)'),
        onClick: open,
      }, ICON_SVG)
    }

    // ------------------------------------------------------------ Jarvis skin
    // The skin is plain CSS over Harness's own design tokens (lib/theme.css, served by the
    // host) plus a click-through HUD frame. The switch lives in a small JSON file that the
    // J.A.R.V.I.S. launcher also writes, so it is polled and applied live.
    const THEME_LINK_ID = 'dsh-jarvis-theme-css'
    const FRAME_ID = 'dsh-jarvis-frame'
    let themeTimer = null
    let localeRuntime = null

    // The launcher's language → this window, once per switch in the launcher (stamp = time of the switch).
    // The window keeps its own last language and writes it back to the settings on load (the Russian UI
    // plugin follows it), which would undo the launcher's switch. A language picked later in the agent's
    // own menu is left alone until the launcher switches again. The stamp is stored only once the window
    // really shows the language, so a plugin that switches it back at boot gets corrected on the next poll.
    function syncUiLang(lang, stamp) {
      if (!localeRuntime || (lang !== 'ru' && lang !== 'en')) return
      const key = lang + '@' + (stamp || 'initial')
      let applied = null
      try { applied = localStorage.getItem('jarvis-ui-lang') } catch (e) {}
      if (applied === key) return
      try {
        const st = localeRuntime.getLocale()
        if (st.active === lang) { try { localStorage.setItem('jarvis-ui-lang', key) } catch (e) {} return }
        if (!st.locales.some((l) => l.id === lang)) return // "ru" appears once the Russian UI plugin is up
        localeRuntime.setLocale(lang)
      } catch (e) { /* locale runtime not ready yet */ }
    }

    function ensureThemeAssets() {
      if (!document.getElementById(THEME_LINK_ID)) {
        const link = document.createElement('link')
        link.id = THEME_LINK_ID
        link.rel = 'stylesheet'
        link.href = '/dsh-jarvis/theme.css'
        document.head.appendChild(link)
      }
      if (!document.getElementById(FRAME_ID)) {
        const frame = document.createElement('div')
        frame.id = FRAME_ID
        frame.className = 'jv-frame'
        frame.setAttribute('aria-hidden', 'true')
        frame.innerHTML = '<div class="jv-grid"></div><div class="jv-scan"></div><div class="jv-top"></div>' +
          '<i class="jv-c jv-tl"></i><i class="jv-c jv-tr"></i><i class="jv-c jv-bl"></i><i class="jv-c jv-br"></i>' +
          '<div class="jv-tag"><i></i>J.A.R.V.I.S. online</div>'
        document.body.appendChild(frame)
      }
    }

    function applyTheme(state) {
      const body = document.body
      if (state.enabled) {
        ensureThemeAssets()
        if (Array.isArray(state.accent)) body.style.setProperty('--jv-acc', state.accent.join(', '))
        if (!body.hasAttribute('data-jarvis-theme')) body.setAttribute('data-jarvis-theme', '')
      } else if (body.hasAttribute('data-jarvis-theme')) {
        body.removeAttribute('data-jarvis-theme')
      }
    }

    async function syncTheme() {
      try {
        const r = await fetch('/dsh-jarvis/theme', { cache: 'no-store' })
        const j = await r.json()
        if (j && j.ok) { if (j.lang === 'ru' || j.lang === 'en') { LANG = j.lang; syncUiLang(j.lang, j.langStamp) } applyTheme(j) }
      } catch (e) { /* server restarting — keep the current look */ }
    }

    function startTheme() {
      if (themeTimer) return
      syncTheme()
      themeTimer = setInterval(syncTheme, 4000)
    }

    exports.inject = ['slots', 'locale']
    exports.apply = function apply(ctx) {
      ensureStyle()
      localeRuntime = ctx.locale || null
      startTheme()
      ctx.slots.inject('conversation.input.right', () => ctx.slots.register(
        { name: 'conversation.input.right', id: 'dsh-jarvis', order: 1, label: () => L('Джарвис', 'Jarvis') },
        (props) => React.createElement(ReactorButton, {
          input: props.input,
          inputActions: props.inputActions,
          session: props.session,
          useConversation: props.useConversation,
        }),
      ))
    }
    return module.exports
  },
})
