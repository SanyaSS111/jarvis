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
    throw new Error('ComfyUI не установлен. Попроси пользователя открыть лаунчер J.A.R.V.I.S. → «Модели» → панель «Картинки · ComfyUI» → «Установить ComfyUI».');
  }
  log('Запускаю ComfyUI…');
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
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} запуск ComfyUI (фоном, без лаунчера) =====\n`);
    const out = fs.openSync(logFile, 'a');
    cp.spawn(path.join(COMFY_DIR, 'python_embeded', 'python.exe'), args, { cwd: COMFY_DIR, windowsHide: true, detached: true, stdio: ['ignore', out, out] }).unref();
  }
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    if ((await request(COMFY + '/system_stats', { timeout: 3000 })).status === 200) return;
  }
  throw new Error('ComfyUI не запустился за 4 минуты — лог: ' + path.join(ROOT, 'data', 'comfyui', 'comfyui.log'));
}

// ---------------------------------------------------------------- tools
const TOOLS = [
  {
    name: 'generate_image',
    description: 'Нарисовать картинку локальной моделью (Qwen-Image и др.) через ComfyUI на этом ПК. Бесплатно, офлайн, без цензуры. ' +
      'Пиши prompt подробно, лучше на английском: объект, стиль, освещение, композиция. ' +
      'По умолчанию 768×768 (2–4 минуты); 1024×1024 и больше бери, только если пользователь просит качество или размер — на слабых видеокартах это 5–10 минут. ' +
      'Результат: путь к PNG и ссылка url — покажи картинку пользователю в ответе markdown-изображением ![](url) и назови путь к файлу.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Описание картинки (лучше по-английски, подробно).' },
        negative_prompt: { type: 'string', description: 'Чего не должно быть на картинке (необязательно).' },
        width: { type: 'integer', description: 'Ширина, 256–2048, кратно 32. По умолчанию 768.' },
        height: { type: 'integer', description: 'Высота, 256–2048, кратно 32. По умолчанию 768.' },
        steps: { type: 'integer', description: 'Шаги, 8–50: меньше — быстрее черновик, больше — детальнее. По умолчанию 20.' },
        seed: { type: 'integer', description: 'Зерно для повторения той же картинки (необязательно).' },
        model: { type: 'string', description: 'id модели из list_image_models (необязательно — берётся первая установленная).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description: 'Отредактировать готовое фото локальной моделью через ComfyUI: добавить или убрать предметы, навести порядок, ' +
      'поменять фон, одежду, освещение, стиль, перенести предмет с другого фото. Размер и кадр берутся с исходного фото. ' +
      'Фото из Telegram лежат в папке Telegram проектов (путь есть в сообщении пользователя). ' +
      'instruction пиши по-английски, как точное указание монтажёру: начни с действия ("Add…", "Remove…", "Replace…"), ' +
      'конкретно опиши ТОЛЬКО то, что меняется (что, где, какого вида), изменение должно быть заметным; ' +
      'остальное зафиксируй одной фразой, не описывая его подробно (например "Keep the room layout, furniture, lighting, camera angle and everything else unchanged"). ' +
      'Если что-то убираешь — скажи, что должно оказаться на освободившемся месте. Люди на фото: "keep the person\'s face and identity unchanged". ' +
      'Несколько фото: первое — основное (холст), к остальным обращайся <image2>, <image3> и скажи, что именно из них взять. ' +
      'Занимает 2–6 минут. Результат покажи пользователю markdown-изображением ![](url) и назови путь к файлу.',
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Полный путь к фото, которое редактируем (jpg/png/webp).' },
        instruction: { type: 'string', description: 'Что сделать, точное указание по-английски (см. описание инструмента).' },
        extra_images: { type: 'array', items: { type: 'string' }, description: 'До 3 дополнительных фото-образцов (<image2>, <image3>…), необязательно.' },
        resolution: { type: 'integer', description: 'Размер результата по площади, 512–1536 (≈ N×N пикселей, пропорции как у фото). По умолчанию 768; 1024 — детальнее, но в 2 раза дольше.' },
        steps: { type: 'integer', description: 'Шаги, 8–50. По умолчанию 20.' },
        seed: { type: 'integer', description: 'Зерно для повторения результата (необязательно).' },
      },
      required: ['image', 'instruction'],
    },
  },
  {
    name: 'list_image_models',
    description: 'Какие модели для картинок установлены на этом ПК и готов ли ComfyUI.',
    inputSchema: { type: 'object', properties: {} },
  },
];

const clamp32 =(v, d) => Math.min(2048, Math.max(256, Math.round((Number(v) || d) / 32) * 32));

const seedOf = (a) => (Number.isInteger(a.seed) && a.seed >= 0 ? a.seed : Math.floor(Math.random() * 2 ** 48));

// The image model to use and a check that its recipe and files are there.
function pickModel(a, recipes) {
  const models = imageModels();
  if (!models.length) throw new Error('Нет ни одной модели для картинок. В лаунчере: «Модели» → фильтр «Картинки (ComfyUI)» → например abenzerps/Qwen-Image-2.1-Uncensored-GGUF → «Скачать для ComfyUI».');
  const m = a.model ? models.find((x) => x.id === a.model || x.title === a.model) : models.find((x) => recipes[x.arch]) || models[0];
  if (!m) throw new Error('Модель не найдена. Установлены: ' + models.map((x) => x.id).join(', '));
  if (!recipes[m.arch]) throw new Error(`Для «${m.title}» (архитектура ${m.arch}) нет готового рецепта — открой ComfyUI в лаунчере и работай там вручную (Workflow → Browse Templates).`);
  if (!m.model || !m.te || !m.vae) throw new Error(`У «${m.title}» не хватает файлов (текстовый кодировщик / VAE) — переустанови модель в лаунчере.`);
  return m;
}

// A photo from disk into ComfyUI's input folder (POST /upload/image, multipart); returns the LoadImage name.
function uploadImage(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error('Файл не найден: ' + file);
  if (!/\.(png|jpe?g|webp|bmp)$/i.test(file)) throw new Error('Это не картинка (нужен jpg, png или webp): ' + file);
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
        catch { reject(new Error('ComfyUI не принял фото: ' + d.slice(0, 200))); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('ComfyUI не ответил на загрузку фото')));
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
  if (!args.prompt) throw new Error('Пустой prompt');
  const r = await runGraph(() => RECIPES[m.arch](m, args), `Рисую: ${m.title}, ${args.width}×${args.height}, ${args.steps} шагов…`, log);
  return { ...r, model: m.title, size: `${args.width}×${args.height}`, steps: args.steps, seed: args.seed };
}

async function edit(a, log) {
  const m = pickModel(a, EDIT_RECIPES);
  const files = [a.image, ...(Array.isArray(a.extra_images) ? a.extra_images.slice(0, 3) : [])].map((f) => String(f || '').trim()).filter(Boolean);
  if (!files.length) throw new Error('Не указано фото (image)');
  const instruction = String(a.instruction || '').trim();
  if (!instruction) throw new Error('Не указано, что сделать с фото (instruction)');
  for (const f of files) if (!fs.existsSync(f)) throw new Error('Файл не найден: ' + f);
  const args = {
    prompt: instruction, seed: seedOf(a),
    resolution: Math.min(1536, Math.max(512, Math.round((Number(a.resolution) || 768) / 32) * 32)),
    steps: Math.min(50, Math.max(8, Math.round(Number(a.steps) || 20))), inputs: [],
  };
  const r = await runGraph(async () => {
    for (const f of files) args.inputs.push(await uploadImage(f));
    return EDIT_RECIPES[m.arch](m, args);
  }, `Редактирую фото: ${m.title}, ≈${args.resolution}², ${args.steps} шагов…`, log);
  return { ...r, model: m.title, size: `≈${args.resolution}²`, steps: args.steps, seed: args.seed };
}

// Starts ComfyUI if needed, queues the graph, waits for the picture.
async function runGraph(build, label, log) {
  // A local chat model holds most of the video memory: ComfyUI then works in what is left (slower).
  const llama = (await request(LLAMA + '/health', { timeout: 2000 })).status === 200;
  if (llama) log('Локальная модель занимает видеопамять — работаю в оставшейся памяти, это медленнее обычного…');
  await ensureComfy(log);
  const t0 = Date.now();
  const graph = await build();
  const q = await request(COMFY + '/prompt', { method: 'POST', body: { prompt: graph, client_id: 'jarvis-agent' } });
  if (q.status !== 200) throw new Error('ComfyUI отклонил задание: ' + q.body.slice(0, 600));
  const id = JSON.parse(q.body).prompt_id;
  log(label);
  let down = 0;
  for (;;) {
    await sleep(3000);
    const h = await request(COMFY + '/history/' + id);
    // ComfyUI died mid-job: say so at once instead of waiting out the 30 minutes.
    if (h.status === 0) {
      if (++down >= 5) throw new Error('ComfyUI упал во время работы. Лог: ' + path.join(ROOT, 'data', 'comfyui', 'comfyui.log') + ' — попробуй ещё раз (он запустится заново).');
      continue;
    }
    down = 0;
    let item = null;
    try { item = JSON.parse(h.body)[id]; } catch {}
    if (!item) {
      if (Date.now() - t0 > 30 * 60000) throw new Error('Генерация идёт дольше 30 минут — прервано ожидание (ComfyUI продолжает).');
      continue;
    }
    const st = item.status || {};
    if (st.status_str === 'error') {
      const err = (st.messages || []).find((x) => x[0] === 'execution_error');
      if (llama) await stopComfyIfIdle();
      const text = err ? `${err[1].node_type}: ${err[1].exception_message}` : 'неизвестно';
      const oom = /out of memory|OOM|allocat/i.test(text);
      throw new Error('Ошибка ComfyUI: ' + text.slice(0, 600) + (oom ? (llama
        ? '\nНе хватило памяти: её занимает локальная модель. Попробуй размер поменьше (например 768×768) или попроси пользователя выгрузить модель в лаунчере.'
        : '\nНе хватило памяти видеокарты — попробуй размер поменьше.') : ''));
    }
    if (!st.completed) continue;
    const images = Object.values(item.outputs || {}).flatMap((o) => o.images || []);
    if (!images.length) throw new Error('ComfyUI закончил, но не сохранил картинку');
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
    return JSON.stringify({ comfyui: installed ? (up ? 'запущен' : 'установлен, запустится сам') : 'не установлен',
      models: imageModels().map((m) => ({ id: m.id, title: m.title, arch: m.arch, ready: m.supported })) }, null, 2);
  }
  if (name === 'generate_image' || name === 'edit_image') {
    const r = await (name === 'edit_image' ? edit : generate)(a || {}, log);
    return `Готово за ${r.seconds} с: ${r.model}, ${r.size}, ${r.steps} шагов, seed ${r.seed}.\nФайл: ${r.file}\nurl: ${r.url}\n` +
      `Покажи пользователю: ![картинка](${r.url})`;
  }
  throw new Error('Неизвестный инструмент ' + name);
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
