// J.A.R.V.I.S. images for the agent: a tiny MCP server (stdio, plain Node, no dependencies) that draws
// pictures and edits photos with the image models installed from the launcher catalog, through ComfyUI.
// ComfyUI is started via the launcher (or directly if the launcher is closed) and stays running.
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const COMFY = 'http://127.0.0.1:8188';
const LAUNCHER = 'http://127.0.0.1:3190';
const COMFY_DIR = path.join(ROOT, 'tools', 'comfyui');
const OUTPUT = path.join(ROOT, 'data', 'comfyui', 'output');
const REGISTRY = path.join(ROOT, 'models', 'registry.json');
const LLAMA = 'http://127.0.0.1:8081'; // local chat model (launcher's llama-server)

// Messages a person may see (errors, progress) follow the launcher's language (data\launcher\settings.json);
// tool descriptions are for the model and stay in English.
function lang() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'launcher', 'settings.json'), 'utf8')).lang === 'ru' ? 'ru' : 'en'; } catch { return 'en'; }
}
const L = (ru, en) => (lang() === 'ru' ? ru : en);

// ---------------------------------------------------------------- recipes per GGUF architecture
// API-format graphs, same settings as the official Comfy-Org templates.
const RECIPES = {
  qwen_image21: (m, a) => ({
    1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: m.model } },
    2: { class_type: 'CLIPLoader', inputs: { clip_name: m.te, type: 'qwen_image', device: 'default' } },
    3: { class_type: 'VAELoader', inputs: { vae_name: m.vae } },
    4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: a.prompt, negative_prompt: a.negative_prompt || '', resolution: 1024, vae: ['3', 0] } },
    5: { class_type: 'EmptyLatentImage', inputs: { width: a.width, height: a.height, batch_size: 1 } },
    6: { class_type: 'KSampler', inputs: { model: ['1', 0], seed: a.seed, steps: a.steps, cfg: a.negative_prompt ? 2.5 : 1, sampler_name: 'euler', scheduler: 'simple',
      positive: ['4', 0], negative: ['4', 1], latent_image: ['5', 0], denoise: 1 } },
    7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'jarvis/agent' } },
  }),
};

// Photo editing: the same model reads the reference photos through its text encoder and keeps their size
// (official "Image Edit (Qwen Image 2.1)" template, without its optional prompt-enhancer LLM: the agent
// writes the precise instruction itself). a.inputs = names returned by ComfyUI's /upload/image.
const EDIT_RECIPES = {
  qwen_image21: (m, a) => {
    const g = {
      1: { class_type: 'UnetLoaderGGUF', inputs: { unet_name: m.model } },
      2: { class_type: 'CLIPLoader', inputs: { clip_name: m.te, type: 'qwen_image', device: 'default' } },
      3: { class_type: 'VAELoader', inputs: { vae_name: m.vae } },
      5: { class_type: 'QwenImage21Cache', inputs: { model: ['1', 0], device: 'auto', dtype: 'default' } },
      4: { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt: a.prompt, negative_prompt: '', resolution: a.resolution, vae: ['3', 0] } },
      6: { class_type: 'KSampler', inputs: { model: ['5', 0], seed: a.seed, steps: a.steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple',
        positive: ['4', 0], negative: ['4', 1], latent_image: ['4', 2], denoise: 1 } },
      7: { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
      8: { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'jarvis/edit' } },
    };
    a.inputs.forEach((name, i) => {
      g[20 + i] = { class_type: 'LoadImage', inputs: { image: name } };
      g[4].inputs[`images.image_${i + 1}`] = [String(20 + i), 0];
    });
    return g;
  },
};

function imageModels() {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')).models || []; } catch {}
  return list.filter((e) => e.status === 'installed' && (e.kind === 'image' || e.kind === 'video')).map((e) => {
    const f = (role) => (e.files.find((x) => x.subdir === role) || {}).name;
    return { id: e.id, title: `${e.title} ${e.quant}`, arch: e.arch, model: f('diffusion_models'), te: f('text_encoders'), vae: f('vae'), supported: !!RECIPES[e.arch] };
  });
}

// ---------------------------------------------------------------- http helpers
function request(url, { method = 'GET', body, headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const req = http.request(url, { method, timeout, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ComfyUI up? Otherwise ask the launcher (it tracks the process), or start it directly.
// ComfyUI's own unload (/free) crashes the GGUF node on Windows ("access violation" while moving the
// weights to RAM, seen 2026-09-25). Memory is released by stopping an idle ComfyUI instead — only one
// this server started itself, never a window the user opened. The next picture starts it again (~30 s).
let startedByMe = false;
let idleTimer = null;
function portPid(port) {
  try {
    const out = cp.execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true });
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().split(/\s+/);
      if (m.length >= 5 && /LISTEN/i.test(m[3]) && m[1].endsWith(':' + port)) return Number(m[4]);
    }
  } catch {}
  return null;
}
async function stopComfyIfIdle() {
  if (!startedByMe) return 'not-mine';
  const q = await request(COMFY + '/queue', { timeout: 3000 });
  if (q.status !== 200) { startedByMe = false; return 'down'; }
  let j = {}; try { j = JSON.parse(q.body); } catch {}
  if ((j.queue_running || []).length || (j.queue_pending || []).length) return 'busy';
  const viaLauncher = await request(LAUNCHER + '/api/comfy/stop', { method: 'POST', body: {}, headers: { 'X-Jarvis': '1' } });
  if (viaLauncher.status !== 200) {
    const pid = portPid(8188);
    if (pid) { try { cp.execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
  }
  startedByMe = false;
  return 'stopped';
}
function scheduleIdleStop(ms) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => { if ((await stopComfyIfIdle()) === 'busy') scheduleIdleStop(5 * 60000); }, ms);
}

async function ensureComfy(log) {
  if ((await request(COMFY + '/system_stats', { timeout: 3000 })).status === 200) return;
  startedByMe = true;
  if (!fs.existsSync(path.join(COMFY_DIR, 'python_embeded', 'python.exe'))) {
    throw new Error(L('ComfyUI не установлен. Попроси пользователя открыть лаунчер J.A.R.V.I.S. → «Модели» → панель «Картинки · ComfyUI» → «Установить ComfyUI».',
      'ComfyUI is not installed. Ask the user to open the J.A.R.V.I.S. launcher → "Models" → the "Images · ComfyUI" panel → "Install ComfyUI".'));
  }
  log(L('Запускаю ComfyUI…', 'Starting ComfyUI…'));
  const viaLauncher = await request(LAUNCHER + '/api/comfy/start', { method: 'POST', body: { open: false }, headers: { 'X-Jarvis': '1' } });
  if (viaLauncher.status !== 200) {
    let info = {};
    try { info = JSON.parse(fs.readFileSync(path.join(COMFY_DIR, 'jarvis.json'), 'utf8')); } catch {}
    fs.mkdirSync(OUTPUT, { recursive: true });
    const args = ['-s', path.join(COMFY_DIR, 'ComfyUI', 'main.py'), '--windows-standalone-build', '--listen', '127.0.0.1', '--port', '8188',
      '--disable-auto-launch', '--output-directory', OUTPUT, ...(info.cpu ? ['--cpu'] : []),
      // no-bf16 cards: fp16 VAE overflows (blotches, black squares) — same flag the launcher uses
      ...(!info.cpu && info.variant === 'nvidia_cu126' ? ['--fp32-vae'] : []),
      // pinned RAM (40% of it) + text encoder + GGUF model exceed the commit limit on ≤ 32 GB PCs → access
      // violation; same flag the launcher uses
      ...(!info.cpu && require('os').totalmem() <= 34 * 2 ** 30 ? ['--disable-pinned-memory'] : [])];
    const logFile = path.join(ROOT, 'data', 'comfyui', 'comfyui.log');
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ComfyUI start (background, without the launcher) =====\n`);
    const out = fs.openSync(logFile, 'a');
    cp.spawn(path.join(COMFY_DIR, 'python_embeded', 'python.exe'), args, { cwd: COMFY_DIR, windowsHide: true, detached: true, stdio: ['ignore', out, out] }).unref();
  }
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    if ((await request(COMFY + '/system_stats', { timeout: 3000 })).status === 200) return;
  }
  throw new Error(L('ComfyUI не запустился за 4 минуты — лог: ', 'ComfyUI did not start within 4 minutes — log: ') + path.join(ROOT, 'data', 'comfyui', 'comfyui.log'));
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'generate_image',
    description: 'Draw a picture with a local model (Qwen-Image etc.) through ComfyUI on this PC. Free, offline, uncensored. ' +
      'Write a detailed prompt, preferably in English: subject, style, lighting, composition. ' +
      'Default 768×768 (2–4 minutes); use 1024×1024 or more only when the user asks for quality or size — on weak GPUs that takes 5–10 minutes. ' +
      'Result: the PNG path and a url — show the picture to the user in your reply as a markdown image ![](url) and give the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Picture description (preferably English, detailed).' },
        negative_prompt: { type: 'string', description: 'What must not be in the picture (optional).' },
        width: { type: 'integer', description: 'Width, 256–2048, a multiple of 32. Default 768.' },
        height: { type: 'integer', description: 'Height, 256–2048, a multiple of 32. Default 768.' },
        steps: { type: 'integer', description: 'Steps, 8–50: fewer for a quick draft, more for detail. Default 20.' },
        seed: { type: 'integer', description: 'Seed to repeat the same picture (optional).' },
        model: { type: 'string', description: 'Model id from list_image_models (optional — the first installed one is used).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: 'Edit an existing photo with a local model through ComfyUI: add or remove objects, tidy up, ' +
      'change the background, clothes, lighting or style, move an object over from another photo. Size and framing come from the source photo. ' +
      'Photos from Telegram are in the Telegram folder of the projects (the path is in the user message). ' +
      'Write the instruction in English, like a precise note to a retoucher: start with the action ("Add…", "Remove…", "Replace…"), ' +
      'describe ONLY what changes (what, where, what it looks like) — the change must be clearly visible; ' +
      'pin down the rest in one sentence without describing it (e.g. "Keep the room layout, furniture, lighting, camera angle and everything else unchanged"). ' +
      'When removing something, say what should fill the freed space. People in the photo: "keep the person\'s face and identity unchanged". ' +
      'Several photos: the first is the main one (the canvas); refer to the others as <image2>, <image3> and say what to take from them. ' +
      'Takes 2–6 minutes. Show the result to the user as a markdown image ![](url) and give the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Full path of the photo to edit (jpg/png/webp).' },
        instruction: { type: 'string', description: 'What to do: a precise instruction in English (see the tool description).' },
        extra_images: { type: 'array', items: { type: 'string' }, description: 'Up to 3 extra reference photos (<image2>, <image3>…), optional.' },
        resolution: { type: 'integer', description: 'Result size by area, 512–1536 (≈ N×N pixels, the photo\'s aspect ratio). Default 768; 1024 is more detailed but twice as slow.' },
        steps: { type: 'integer', description: 'Steps, 8–50. Default 20.' },
        seed: { type: 'integer', description: 'Seed to repeat the result (optional).' },
      },
      required: ['image', 'instruction'],
    },
  },
  {
    name: 'list_image_models',
    description: 'Which image models are installed on this PC and whether ComfyUI is ready.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const clamp32 =(v, d) => Math.min(2048, Math.max(256, Math.round((Number(v) || d) / 32) * 32));

const seedOf = (a) => (Number.isInteger(a.seed) && a.seed >= 0 ? a.seed : Math.floor(Math.random() * 2 ** 48));

// The image model to use and a check that its recipe and files are there.
function pickModel(a, recipes) {
  const models = imageModels();
  if (!models.length) throw new Error(L('Нет ни одной модели для картинок. В лаунчере: «Модели» → фильтр «Картинки (ComfyUI)» → например abenzerps/Qwen-Image-2.1-Uncensored-GGUF → «Скачать для ComfyUI».',
    'No image models installed. In the launcher: "Models" → the "Images (ComfyUI)" filter → e.g. abenzerps/Qwen-Image-2.1-Uncensored-GGUF → "Download for ComfyUI".'));
  const m = a.model ? models.find((x) => x.id === a.model || x.title === a.model) : models.find((x) => recipes[x.arch]) || models[0];
  if (!m) throw new Error(L('Модель не найдена. Установлены: ', 'Model not found. Installed: ') + models.map((x) => x.id).join(', '));
  if (!recipes[m.arch]) throw new Error(L(`Для «${m.title}» (архитектура ${m.arch}) нет готового рецепта — открой ComfyUI в лаунчере и работай там вручную (Workflow → Browse Templates).`,
    `There is no ready recipe for "${m.title}" (architecture ${m.arch}) — open ComfyUI from the launcher and work there by hand (Workflow → Browse Templates).`));
  if (!m.model || !m.te || !m.vae) throw new Error(L(`У «${m.title}» не хватает файлов (текстовый кодировщик / VAE) — переустанови модель в лаунчере.`, `"${m.title}" is missing files (text encoder / VAE) — reinstall the model in the launcher.`));
  return m;
}

// A photo from disk into ComfyUI's input folder (POST /upload/image, multipart); returns the LoadImage name.
function uploadImage(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(L('Файл не найден: ', 'File not found: ') + file);
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) throw new Error(L('Это не картинка (нужен jpg, png или webp): ', 'Not an image (jpg, png or webp needed): ') + file);
  const boundary = '----jarvis' + Date.now().toString(16) + Math.random().toString(16).slice(2);
  const name = `${Date.now()}_${path.basename(file).replace(/[^\w.-]+/g, '_')}`;
  const head = (field, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${field}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(head('subfolder', 'jarvis') + head('overwrite', 'true') +
      `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    fs.readFileSync(file), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return new Promise((resolve, reject) => {
    const req = http.request(COMFY + '/upload/image', { method: 'POST', timeout: 60000,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { const j = JSON.parse(d); resolve(j.subfolder ? `${j.subfolder}/${j.name}` : j.name); }
        catch { reject(new Error(L('ComfyUI не принял фото: ', 'ComfyUI did not accept the photo: ') + d.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(L('ComfyUI не ответил на загрузку фото', 'ComfyUI did not respond to the photo upload'))));
    req.on('error', reject);
    req.end(body);
  });
}

async function generate(a, log) {
  const m = pickModel(a, RECIPES);
  const args = {
    prompt: String(a.prompt || '').trim(), negative_prompt: a.negative_prompt ? String(a.negative_prompt) : '',
    width: clamp32(a.width, 768), height: clamp32(a.height, 768),
    steps: Math.min(50, Math.max(8, Math.round(Number(a.steps) || 20))), seed: seedOf(a),
  };
  if (!args.prompt) throw new Error(L('Пустой prompt', 'Empty prompt'));
  const r = await runGraph(() => RECIPES[m.arch](m, args), L(`Рисую: ${m.title}, ${args.width}×${args.height}, ${args.steps} шагов…`, `Drawing: ${m.title}, ${args.width}×${args.height}, ${args.steps} steps…`), log);
  return { ...r, model: m.title, size: `${args.width}×${args.height}`, steps: args.steps, seed: args.seed };
}

async function edit(a, log) {
  const m = pickModel(a, EDIT_RECIPES);
  const files = [a.image, ...(Array.isArray(a.extra_images) ? a.extra_images.slice(0, 3) : [])].map((f) => String(f || '').trim()).filter(Boolean);
  if (!files.length) throw new Error(L('Не указано фото (image)', 'No photo given (image)'));
  const instruction = String(a.instruction || '').trim();
  if (!instruction) throw new Error(L('Не указано, что сделать с фото (instruction)', 'No instruction for the photo (instruction)'));
  for (const f of files) if (!fs.existsSync(f)) throw new Error(L('Файл не найден: ', 'File not found: ') + f);
  const args = {
    prompt: instruction, seed: seedOf(a),
    resolution: Math.min(1536, Math.max(512, Math.round((Number(a.resolution) || 768) / 32) * 32)),
    steps: Math.min(50, Math.max(8, Math.round(Number(a.steps) || 20))), inputs: [],
  };
  const r = await runGraph(async () => {
    for (const f of files) args.inputs.push(await uploadImage(f));
    return EDIT_RECIPES[m.arch](m, args);
  }, L(`Редактирую фото: ${m.title}, ≈${args.resolution}², ${args.steps} шагов…`, `Editing the photo: ${m.title}, ≈${args.resolution}², ${args.steps} steps…`), log);
  return { ...r, model: m.title, size: `≈${args.resolution}²`, steps: args.steps, seed: args.seed };
}

// Starts ComfyUI if needed, queues the graph, waits for the picture.
async function runGraph(build, label, log) {
  // A local chat model holds most of the video memory: ComfyUI then works in what is left (slower).
  const llama = (await request(LLAMA + '/health', { timeout: 2000 })).status === 200;
  if (llama) log(L('Локальная модель занимает видеопамять — работаю в оставшейся памяти, это медленнее обычного…', 'A local model holds the VRAM — working in what is left, slower than usual…'));
  await ensureComfy(log);
  const t0 = Date.now();
  const graph = await build();
  const q = await request(COMFY + '/prompt', { method: 'POST', body: { prompt: graph, client_id: 'jarvis-agent' } });
  if (q.status !== 200) throw new Error(L('ComfyUI отклонил задание: ', 'ComfyUI rejected the job: ') + q.body.slice(0, 600));
  const id = JSON.parse(q.body).prompt_id;
  log(label);
  let down = 0;
  for (;;) {
    await sleep(3000);
    const h = await request(COMFY + '/history/' + id);
    // ComfyUI died mid-job: say so at once instead of waiting out the 30 minutes.
    if (h.status === 0) {
      if (++down >= 5) throw new Error(L('ComfyUI упал во время работы. Лог: ', 'ComfyUI crashed while working. Log: ') + path.join(ROOT, 'data', 'comfyui', 'comfyui.log') + L(' — попробуй ещё раз (он запустится заново).', ' — try again (it will restart).'));
      continue;
    }
    down = 0;
    let item = null;
    try { item = JSON.parse(h.body)[id]; } catch {}
    if (!item) {
      if (Date.now() - t0 > 30 * 60000) throw new Error(L('Генерация идёт дольше 30 минут — прервано ожидание (ComfyUI продолжает).', 'Generation has taken over 30 minutes — stopped waiting (ComfyUI keeps going).'));
      continue;
    }
    const st = item.status || {};
    if (st.status_str === 'error') {
      const err = (st.messages || []).find((x) => x[0] === 'execution_error');
      if (llama) await stopComfyIfIdle();
      const text = err ? `${err[1].node_type}: ${err[1].exception_message}` : L('неизвестно', 'unknown');
      const oom = /out of memory|OOM|allocat/i.test(text);
      throw new Error(L('Ошибка ComfyUI: ', 'ComfyUI error: ') + text.slice(0, 600) + (oom ? (llama
        ? L('\nНе хватило памяти: её занимает локальная модель. Попробуй размер поменьше (например 768×768) или попроси пользователя выгрузить модель в лаунчере.',
          '\nOut of memory: the local model holds it. Try a smaller size (e.g. 768×768) or ask the user to unload the model in the launcher.')
        : L('\nНе хватило памяти видеокарты — попробуй размер поменьше.', '\nOut of GPU memory — try a smaller size.')) : ''));
    }
    if (!st.completed) continue;
    const images = Object.values(item.outputs || {}).flatMap((o) => o.images || []);
    if (!images.length) throw new Error(L('ComfyUI закончил, но не сохранил картинку', 'ComfyUI finished but saved no image'));
    // With a local chat model loaded, give the memory back right away so its answer isn't slowed down;
    // otherwise keep ComfyUI warm for the next picture, but not forever (VRAM for games / local models).
    if (llama) await stopComfyIfIdle(); else scheduleIdleStop(10 * 60000);
    const im = images[0];
    const file = path.join(OUTPUT, im.subfolder || '', im.filename);
    const url = `${COMFY}/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=output`;
    return { file, url, seconds: Math.round((Date.now() - t0) / 1000) };
  }
}

async function callTool(name, a, log) {
  if (name === 'list_image_models') {
    const up = (await request(COMFY + '/system_stats', { timeout: 3000 })).status === 200;
    const installed = fs.existsSync(path.join(COMFY_DIR, 'python_embeded', 'python.exe'));
    return JSON.stringify({ comfyui: installed ? (up ? 'running' : 'installed, starts on demand') : 'not installed',
      models: imageModels().map((m) => ({ id: m.id, title: m.title, arch: m.arch, ready: m.supported })) }, null, 2);
  }
  if (name === 'generate_image' || name === 'edit_image') {
    const r = await (name === 'edit_image' ? edit : generate)(a || {}, log);
    return `Done in ${r.seconds} s: ${r.model}, ${r.size}, ${r.steps} steps, seed ${r.seed}.\nFile: ${r.file}\nurl: ${r.url}\n` +
      `Show it to the user: ![image](${r.url})`;
  }
  throw new Error('Unknown tool ' + name);
}

// ---------------------------------------------------------------- MCP over stdio (newline-delimited JSON-RPC)
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }
function log(text) { send({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', logger: 'comfyui', data: text } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notifications (initialized, cancelled)
  try {
    let result;
    if (method === 'initialize') {
      result = { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {}, logging: {} },
        serverInfo: { name: 'jarvis-comfyui', version: '1.0.0' } };
    } else if (method === 'ping') result = {};
    else if (method === 'tools/list') result = { tools: TOOLS };
    else if (method === 'tools/call') {
      try { result = { content: [{ type: 'text', text: await callTool(params.name, params.arguments, log) }] }; }
      catch (e) { result = { content: [{ type: 'text', text: String(e.message || e) }], isError: true }; }
    } else if (method === 'logging/setLevel') result = {};
    else { send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } }); return; }
    send({ jsonrpc: '2.0', id, result });
  } catch (e) { send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e.message || e) } }); }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
process.stdin.on('end', () => process.exit(0));
