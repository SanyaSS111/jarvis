// Local models: registry of installed GGUF models, download queue (resume + SHA-256),
// "how will it run on this PC" estimates, and the llama-server process.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const hf = require('./hf');
const harness = require('./harness');
const { T } = require('./i18n');

const PORT = 8081;
const GB = 1024 ** 3;
// The agent's own prompt ("Лёгкий режим") is ~13K tokens, so anything below 16K overflows at once.
const CONTEXTS = [16384, 32768, 65536, 131072];
const DEFAULT_CTX = 16384;

// Curated starting points from tiny to large; the launcher shows how each fits this PC.
const RECOMMENDED = [
  { repo: 'LiquidAI/LFM2.5-2.6B-GGUF', note: ['Очень лёгкая. Для слабых ПК и ноутбуков без видеокарты.', 'Very light. For weak PCs and laptops without a GPU.'] },
  { repo: 'ggml-org/gemma-4-E4B-it-GGUF', note: ['Лёгкая модель Google Gemma 4, понимает картинки.', 'Light Google Gemma 4, understands images.'] },
  { repo: 'HauhauCS/Gemma-4-E4B-Uncensored-HauhauCS-Aggressive', note: ['Лёгкая Gemma 4 без цензуры.', 'Light uncensored Gemma 4.'] },
  { repo: 'unsloth/Qwen3.5-9B-GGUF', note: ['Средняя Qwen 3.5: хороший баланс ума и скорости.', 'Mid-size Qwen 3.5: a good balance of smarts and speed.'] },
  { repo: 'unsloth/gemma-4-12b-it-GGUF', note: ['Средняя Gemma 4 12B.', 'Mid-size Gemma 4 12B.'] },
  { repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF', note: ['MoE для программирования: быстрая даже частично в ОЗУ.', 'MoE for coding: fast even when partly in RAM.'] },
  { repo: 'unsloth/Qwen3.6-35B-A3B-GGUF', note: ['Мощная MoE Qwen 3.6, понимает картинки.', 'Powerful MoE Qwen 3.6, understands images.'] },
  { repo: 'HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive', note: ['Мощная Qwen 3.6 без цензуры.', 'Powerful uncensored Qwen 3.6.'] },
  { repo: 'unsloth/Qwen3.8-27B-GGUF', note: ['Самая умная из подборки. Нужна мощная видеокарта.', 'The smartest in the picks. Needs a powerful GPU.'] },
];

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const fileLen = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

// ---------------------------------------------------------------- fit estimate
// Very rough, but good enough to sort "fast / ok / slow / won't fit" for a given PC.
function estimate(info, modelBytes, mmBytes, ctx, hw) {
  const paramsB = info.params ? info.params / 1e9 : modelBytes / 0.6e9;
  const kvKB = info.moe ? 16 + 1.2 * paramsB : 16 + 3.5 * paramsB; // q8_0 KV cache per token
  const need = modelBytes + mmBytes + ctx * kvKB * 1024 + 0.9 * GB;
  const vram = hw.vramMB ? Math.max(0, hw.vramMB * 1048576 - 0.7 * GB) : 0;
  const total = hw.ramMB * 1048576;
  const ram = Math.max(0, total - Math.max(2.5 * GB, 0.25 * total)); // leave room for Windows and apps
  let level;
  if (vram && need <= vram) level = 'fast';
  else if (need <= vram + ram) {
    if (!vram) level = modelBytes < 3 * GB ? 'ok' : 'slow';
    else {
      const offload = (need - vram) / modelBytes;
      level = info.moe ? (offload < 0.85 ? 'ok' : 'slow') : (offload < 0.3 ? 'ok' : 'slow');
    }
    // Squeezing into the last ~10% of memory means swapping: call it slow.
    if (level === 'ok' && need > 0.9 * (vram + ram)) level = 'slow';
  } else level = 'no';
  return { level, needGB: +(need / GB).toFixed(1) };
}

// Image/video models (ComfyUI): the diffusion model wants the GPU, the text encoder sits in RAM and runs
// once per prompt. Uses the card itself, whatever llama.cpp engine is installed.
function estimateImage(modelBytes, teBytes, hw) {
  const g = hw.gpu && !hw.gpu.integrated ? hw.gpu : null;
  const vram = g ? Math.max(0, g.vramMB * 1048576 - 0.7 * GB) : 0;
  const total = hw.ramMB * 1048576;
  const ram = Math.max(0, total - Math.max(2.5 * GB, 0.25 * total));
  const need = modelBytes + 1.5 * GB;
  let level;
  if (vram && need <= vram && teBytes <= ram) level = 'fast';
  else if (need + teBytes <= vram + ram) level = vram && need <= vram ? 'ok' : 'slow'; // split between card and RAM = slow
  else level = 'no';
  return { level, needGB: +(need / GB).toFixed(1), ramGB: +(teBytes / GB).toFixed(1) };
}
const isImage = (info) => info.kind === 'image' || info.kind === 'video';
const teSize = (info) => (info.companions && info.companions.text_encoders ? info.companions.text_encoders.size : 0);
function fitOf(info, modelBytes, mmBytes, ctx, hw) {
  return isImage(info) ? estimateImage(modelBytes, teSize(info), hw) : estimate(info, modelBytes, mmBytes, ctx, hw);
}

// Best variant for this PC: quality first (4-5 bits is the sweet spot, below 3 bits models get
// noticeably dumber), speed second; ties go to the smaller file.
function recommendQuant(info, hw, ctx = DEFAULT_CTX) {
  const speed = { fast: 6, ok: 3, slow: -4 };
  // Q4 is the sweet spot; Q5-Q6 add a little, Q8 only costs memory; below 2.5 bits is a last resort.
  const quality = (bits) => (bits < 2.5 ? -5 : bits < 3 ? 3 : bits < 4 ? 6 : bits < 5 ? 10 : bits <= 6.5 ? 10.5 : 10.2);
  let best = null, bestScore = -Infinity, bestBytes = Infinity;
  for (const qn of info.quants) {
    if (qn.bits >= 16) continue;
    const e = fitOf(info, qn.bytes, info.mmproj ? info.mmproj.size : 0, ctx, hw);
    if (e.level === 'no') continue;
    // When it is going to be slow anyway, extra bits only make it slower: prefer the lighter file.
    const q = e.level === 'slow' ? Math.min(quality(qn.bits), 10) - (qn.bytes / GB) * 0.1 : quality(qn.bits);
    const s = speed[e.level] + q;
    if (s > bestScore || (s === bestScore && qn.bytes < bestBytes)) { bestScore = s; best = qn.key; bestBytes = qn.bytes; }
  }
  // Only a sub-3-bit, slow variant fits: nothing worth recommending on this PC.
  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------- manager
function createModels({ root, run, killTree, listeningPid, httpGet, journal, getHw, agentHome }) {
  const dir = path.join(root, 'models');
  const dataDir = path.join(root, 'data', 'model');
  const regFile = path.join(dir, 'registry.json');
  const llama = path.join(root, 'runtime', 'llama.cpp', 'llama-server.exe');
  const curl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });

  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(regFile, 'utf8')).models || []; } catch {}
  // A download interrupted by closing the launcher resumes as "paused".
  for (const e of entries) if (e.status === 'downloading' || e.status === 'queued') e.status = 'paused';

  const active = { status: 'off', id: null, ctx: null, pid: null, error: null, since: null };
  let job = null;   // current download: {entry, file, proc, phase, samples, fails, retryAt, cancel, verifyDone}
  let modelProc = null;

  const save = () => fs.writeFileSync(regFile, JSON.stringify({ models: entries }, null, 2));
  const find = (id) => entries.find((e) => e.id === id);
  const modelDir = (e) => path.join(dir, e.dir);
  // Image models: files go to models\comfyui\<ComfyUI folder> (shared by every model that uses them).
  const finalPath = (e, f) => (f.subdir ? path.join(dir, 'comfyui', f.subdir, f.name) : path.join(modelDir(e), f.name));
  const partPath = (e, f) => finalPath(e, f) + '.part';
  const doneBytes = (e) => e.files.reduce((a, f) => a + (fileLen(finalPath(e, f)) === f.size ? f.size : fileLen(partPath(e, f))), 0);
  const installed = () => entries.filter((e) => e.status === 'installed');
  const chatInstalled = () => installed().filter((e) => !isImage(e));

  function syncHarness() {
    try {
      const patch = path.join(agentHome, 'cordis.patch.yml');
      const changed = harness.syncPatch(patch, chatInstalled(), PORT);
      const repaired = harness.repairDefault(path.join(agentHome, 'settings.yaml'), chatInstalled());
      if (repaired) journal(T('Модель агента по умолчанию снова DeepSeek-V4-Flash (прежняя локальная удалена)', 'The agent default model is DeepSeek-V4-Flash again (the local one was removed)'));
      return changed;
    } catch (e) { journal(T('Не удалось обновить список моделей в агенте: ', 'Could not update the model list in the agent: ') + e.message, 'error'); return false; }
  }

  // ------------------------------------------------------------ downloads
  function pump() {
    if (job) return;
    const next = entries.find((e) => e.status === 'queued');
    if (next) { next.status = 'downloading'; save(); nextFile(next); }
  }

  function finishJob() { job = null; save(); pump(); }

  function nextFile(e) {
    for (const f of e.files) fs.mkdirSync(path.dirname(finalPath(e, f)), { recursive: true });
    for (const f of e.files) {
      if (fileLen(finalPath(e, f)) === f.size) continue;
      if (fileLen(partPath(e, f)) === f.size) return verify(e, f);
      const proc = cp.spawn(curl, ['-L', '--fail', '-s', '-S', '-C', '-', '-o', partPath(e, f), f.url],
        { windowsHide: true, stdio: 'ignore' });
      const fails = job && job.entry === e ? job.fails : 0;
      job = { entry: e, file: f, proc, phase: 'download', samples: [], fails, retryAt: 0, cancel: null, verifyDone: 0, message: '' };
      proc.on('exit', (code) => onCurlExit(e, f, code));
      return;
    }
    e.status = 'installed'; e.error = null;
    journal(T(`Модель «${e.title} ${e.quant}» установлена`, `Model "${e.title} ${e.quant}" installed`), 'ok');
    syncHarness();
    finishJob();
  }

  function onCurlExit(e, f, code) {
    if (!job || job.entry !== e) return;
    if (job.cancel === 'pause') { e.status = 'paused'; journal(T(`Загрузка «${e.title}» на паузе`, `Download of "${e.title}" paused`)); return finishJob(); }
    if (job.cancel === 'remove') return; // remove() finishes the job
    if (fileLen(partPath(e, f)) === f.size) { job.fails = 0; return verify(e, f); }
    job.fails += 1;
    if (job.fails <= 30) {
      job.phase = 'wait'; job.retryAt = Date.now() + 5000;
      job.message = T(`Обрыв связи (curl ${code}), повтор через 5 с · попытка ${job.fails}/30`, `Connection lost (curl ${code}), retrying in 5 s · attempt ${job.fails}/30`);
    } else {
      e.status = 'error'; e.error = T(`Ошибка загрузки (curl ${code}). Проверьте интернет и нажмите «Продолжить».`, `Download error (curl ${code}). Check your connection and press "Resume".`);
      journal(T(`Загрузка «${e.title}» прервана`, `Download of "${e.title}" failed`), 'error');
      finishJob();
    }
  }

  function verify(e, f) {
    if (!f.sha) { fs.renameSync(partPath(e, f), finalPath(e, f)); return nextFile(e); }
    job = { ...(job || {}), entry: e, file: f, proc: null, phase: 'verify', verifyDone: 0, message: '' };
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(partPath(e, f), { highWaterMark: 4 * 1024 * 1024 });
    job.stream = stream;
    stream.on('data', (c) => { hash.update(c); if (job) job.verifyDone += c.length; });
    stream.on('error', (err) => { e.status = 'error'; e.error = T('Не удалось прочитать файл: ', 'Could not read the file: ') + err.message; finishJob(); });
    stream.on('end', () => {
      if (!job || job.entry !== e || job.cancel) return;
      if (hash.digest('hex') === f.sha) { fs.renameSync(partPath(e, f), finalPath(e, f)); nextFile(e); }
      else {
        try { fs.unlinkSync(partPath(e, f)); } catch {}
        e.status = 'error'; e.error = T(`Файл ${f.name} повреждён при загрузке и удалён. Нажмите «Продолжить», чтобы скачать заново.`, `File ${f.name} was corrupted during download and removed. Press "Resume" to download it again.`);
        journal(e.error, 'error');
        finishJob();
      }
    });
  }

  function tick() {
    if (!job) return;
    if (job.phase === 'download') {
      const now = Date.now(), done = doneBytes(job.entry);
      job.samples.push([now, done]);
      while (job.samples.length > 20) job.samples.shift();
      const [t0, b0] = job.samples[0];
      job.speed = now > t0 ? ((done - b0) * 1000) / (now - t0) : 0;
    } else if (job.phase === 'wait' && Date.now() >= job.retryAt) {
      nextFile(job.entry);
    }
  }

  async function install(repo, key) {
    const info = await hf.details(repo);
    if (info.gated) throw new Error(T('Эта модель требует входа на Hugging Face — скачать её отсюда нельзя.', 'This model requires a Hugging Face login — it cannot be downloaded from here.'));
    const qn = info.quants.find((x) => x.key === key);
    if (!qn) throw new Error(T('Такого варианта модели нет', 'No such model variant'));
    const id = slugify(`${info.title}-${key}`);
    const have = find(id);
    if (have) { if (have.status !== 'installed') resume(id); return; }
    const hfUrl = (p) => `https://huggingface.co/${repo}/resolve/main/${encodePath(p)}?download=true`;
    const image = isImage(info);
    const files = qn.files.map((f) => ({ name: path.basename(f.path), size: f.size, sha: f.sha, role: 'model', url: hfUrl(f.path),
      ...(image ? { subdir: 'diffusion_models' } : {}) }));
    if (info.mmproj) files.push({ name: path.basename(info.mmproj.path), size: info.mmproj.size, sha: info.mmproj.sha, role: 'mmproj', url: hfUrl(info.mmproj.path) });
    for (const [subdir, c] of Object.entries(info.companions || {})) {
      files.push({ name: path.basename(c.path), size: c.size, sha: c.sha, role: subdir, subdir, url: hfUrl(c.path) });
    }
    const bytes = files.reduce((a, f) => a + f.size, 0);
    const st = fs.statfsSync(dir);
    if (st.bavail * st.bsize < bytes + 2 * GB) throw new Error(T(`Недостаточно места: нужно ${(bytes / GB).toFixed(1)} ГБ + 2 ГБ запаса.`, `Not enough disk space: ${(bytes / GB).toFixed(1)} GB + 2 GB spare needed.`));
    entries.push({
      id, repo, title: info.title, quant: key, kind: info.kind || 'chat', arch: info.arch, params: info.params, moe: info.moe, tools: info.tools,
      vision: !!info.mmproj, uncensored: info.uncensored, ctxMax: info.ctxMax || 32768,
      ctx: Math.min(DEFAULT_CTX, info.ctxMax || DEFAULT_CTX), dir: slugify(repo.replace('/', '--')) + '--' + slugify(key),
      files, bytes, status: 'queued', error: null, addedAt: Date.now(),
    });
    save();
    journal(T(`В очередь загрузки: «${info.title} ${key}» (${(bytes / GB).toFixed(1)} ГБ)`, `Queued for download: "${info.title} ${key}" (${(bytes / GB).toFixed(1)} GB)`));
    pump();
  }

  function pause(id) {
    const e = find(id);
    if (!e) return;
    if (job && job.entry === e) {
      if (job.phase === 'download' && job.proc) { job.cancel = 'pause'; killTree(job.proc.pid); }
      else if (job.phase === 'wait') { e.status = 'paused'; finishJob(); }
    } else if (e.status === 'queued') { e.status = 'paused'; save(); }
  }

  function resume(id) {
    const e = find(id);
    if (!e || e.status === 'installed') return;
    e.status = 'queued'; e.error = null; save(); pump();
  }

  async function remove(id) {
    const e = find(id);
    if (!e) return;
    if (active.id === id && active.status !== 'off') await stop(true);
    if (job && job.entry === e) {
      job.cancel = 'remove';
      if (job.proc) await killTree(job.proc.pid);
      if (job.stream) job.stream.destroy();
      job = null;
    }
    await new Promise((r) => setTimeout(r, 600));
    try {
      if (isImage(e)) {
        // Text encoder / VAE may be used by another installed variant: keep those.
        const others = new Set(entries.filter((x) => x !== e).flatMap((x) => x.files.map((f) => finalPath(x, f))));
        for (const f of e.files) if (!others.has(finalPath(e, f))) for (const p of [finalPath(e, f), partPath(e, f)]) fs.rmSync(p, { force: true });
      } else fs.rmSync(modelDir(e), { recursive: true, force: true });
    } catch (err) {
      e.error = T('Не удалось удалить файлы: ', 'Could not delete the files: ') + err.message; save(); journal(e.error, 'error'); return;
    }
    entries = entries.filter((x) => x !== e);
    save();
    journal(e.status === 'installed'
      ? T(`Модель «${e.title} ${e.quant}» удалена, освобождено ${(e.bytes / GB).toFixed(1)} ГБ`, `Model "${e.title} ${e.quant}" deleted, ${(e.bytes / GB).toFixed(1)} GB freed`)
      : T(`Загрузка «${e.title} ${e.quant}» отменена, скачанные файлы удалены`, `Download of "${e.title} ${e.quant}" cancelled, downloaded files deleted`));
    syncHarness();
    pump();
  }

  // ------------------------------------------------------------ llama-server
  async function start(id, ctx) {
    const e = find(id);
    if (!e || e.status !== 'installed') throw new Error(T('Модель не установлена', 'The model is not installed'));
    if (isImage(e)) throw new Error(T(`«${e.title}» рисует картинки — она запускается в ComfyUI, а не в llama.cpp.`, `"${e.title}" draws images — it runs in ComfyUI, not in llama.cpp.`));
    ctx = Math.min(Number(ctx) || e.ctx || DEFAULT_CTX, e.ctxMax || 131072);
    if (['loading', 'on'].includes(active.status)) {
      if (active.id === id && active.ctx === ctx) return;
      await stop(true);
    }
    e.ctx = ctx; save();
    syncHarness();
    Object.assign(active, { status: 'loading', id, ctx, pid: null, error: null, since: Date.now() });
    journal(T(`Загрузка модели «${e.title}», контекст ${Math.round(ctx / 1024)}K…`, `Loading model "${e.title}", context ${Math.round(ctx / 1024)}K…`));
    const busy = await listeningPid(PORT);
    if (busy) await killTree(busy);
    const hw = getHw() || { vramMB: 0, threads: 4 };
    const modelFile = finalPath(e, e.files.find((f) => f.role === 'model'));
    const mm = e.files.find((f) => f.role === 'mmproj');
    const qwen = /qwen/i.test(e.arch || '') || /qwen/i.test(e.repo);
    const args = ['-m', modelFile,
      ...(mm ? ['--mmproj', finalPath(e, mm)] : []), ...(mm && qwen ? ['--image-min-tokens', '1024'] : []),
      '--alias', e.id, '--host', '127.0.0.1', '--port', String(PORT), '-c', String(ctx), '--fit', 'on',
      '-ctk', 'q8_0', '-ctv', 'q8_0', '-b', '2048', '-ub', hw.vramMB >= 8000 ? '1024' : '512', '-cram', '0', '-np', '1',
      '-t', String(Math.max(2, Math.min(8, Math.floor((hw.threads || 4) / 2)))), '--jinja'];
    const outFd = fs.openSync(path.join(dataDir, 'llama-server.log'), 'w');
    const errFd = fs.openSync(path.join(dataDir, 'llama-server.err.log'), 'w');
    // detached: survives a launcher restart (the next launcher adopts it by port).
    const proc = cp.spawn(llama, args, { cwd: path.dirname(llama), windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd] });
    fs.closeSync(outFd); fs.closeSync(errFd);
    modelProc = proc;
    active.pid = proc.pid;
    proc.on('exit', (code) => {
      if (modelProc !== proc) return;
      modelProc = null;
      if (active.status === 'stopping' || active.status === 'off') { active.status = 'off'; }
      else {
        active.status = 'error';
        let tail = '';
        try { tail = fs.readFileSync(path.join(dataDir, 'llama-server.err.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-8).join('\n'); } catch {}
        const unknownArch = /unknown model architecture|unsupported/i.test(tail);
        active.error = (unknownArch ? T('Движок llama.cpp не знает эту архитектуру модели — нужна более новая версия движка.\n', 'The llama.cpp engine does not know this model architecture — a newer engine is needed.\n')
          : T(`llama-server завершился (код ${code}) — возможно, не хватило памяти. Попробуйте контекст поменьше или вариант модели полегче.\n`, `llama-server exited (code ${code}) — probably out of memory. Try a smaller context or a lighter model variant.\n`)) + tail;
        journal(T('Локальная модель упала', 'The local model crashed'), 'error');
      }
      active.pid = null;
    });
  }

  async function stop(quiet) {
    const pid = active.pid || await listeningPid(PORT);
    active.status = 'stopping';
    modelProc = null;
    if (pid) await killTree(pid);
    Object.assign(active, { status: 'off', pid: null });
    if (!quiet) journal(T('Локальная модель выгружена', 'Local model unloaded'));
  }

  async function poll() {
    if (active.status !== 'loading') return;
    const r = await httpGet(`http://127.0.0.1:${PORT}/health`, 1500);
    if (r.status === 200 && active.status === 'loading') {
      active.status = 'on';
      journal(T(`Модель готова за ${Math.round((Date.now() - active.since) / 1000)} с`, `Model ready in ${Math.round((Date.now() - active.since) / 1000)} s`), 'ok');
    }
  }

  async function adopt() {
    const pid = await listeningPid(PORT);
    if (!pid) return;
    const r = await httpGet(`http://127.0.0.1:${PORT}/v1/models`);
    let alias = null;
    try { alias = JSON.parse(r.body).data[0].id; } catch {}
    const e = alias && find(alias);
    if (!e) return;
    const props = await httpGet(`http://127.0.0.1:${PORT}/props`);
    let ctx = e.ctx;
    try { ctx = JSON.parse(props.body).default_generation_settings.n_ctx || ctx; } catch {}
    Object.assign(active, { status: 'loading', id: e.id, ctx, pid, since: Date.now() });
    journal(T(`Найдена работающая модель «${e.title}» — подключился`, `Found a running model "${e.title}" — connected`));
  }

  // ------------------------------------------------------------ catalog
  function withFit(info, ctx) {
    const hw = getHw() || { vramMB: 0, ramMB: 8192 };
    const mm = info.mmproj ? info.mmproj.size : 0;
    const have = new Set(entries.map((e) => e.repo + '|' + e.quant));
    return {
      ...info,
      mmproj: info.mmproj ? { size: info.mmproj.size } : null,
      recommendedQuant: recommendQuant(info, hw, ctx),
      extraBytes: Object.values(info.companions || {}).reduce((a, c) => a + c.size, 0),
      quants: info.quants.map((qn) => ({ key: qn.key, bytes: qn.bytes + mm, parts: qn.files.length, bits: qn.bits,
        fit: fitOf(info, qn.bytes, mm, ctx, hw), installed: have.has(info.repo + '|' + qn.key) })),
    };
  }

  async function recommended(ctx = DEFAULT_CTX) {
    const out = await Promise.all(RECOMMENDED.map(async (r) => {
      try { return { ...withFit(await hf.details(r.repo), ctx), note: T(...r.note) }; } catch { return null; }
    }));
    return out.filter((x) => x && x.quants.length);
  }

  async function details(repo, ctx = DEFAULT_CTX) { return withFit(await hf.details(repo), ctx); }

  // Search results have no file sizes yet: estimate the lightest good variant (IQ4_XS, ~0.55 bytes per weight).
  async function search(query, cursor, ctx = DEFAULT_CTX) {
    const hw = getHw() || { vramMB: 0, ramMB: 8192 };
    const page = await hf.search(query, cursor);
    return {
      next: page.next,
      items: page.items.map((r) => ({
        ...r,
        fitApprox: !r.params ? null : isImage(r) ? estimateImage(r.params * 0.6, 0, hw)
          : estimate(r, r.params * 0.55, r.vision ? 0.9 * GB : 0, ctx, hw),
      })),
    };
  }

  function state() {
    const hw = getHw();
    return {
      port: PORT,
      contexts: CONTEXTS,
      active: { ...active },
      job: job ? { id: job.entry.id, file: job.file && job.file.name, phase: job.phase, message: job.message,
        speed: job.speed || 0, done: doneBytes(job.entry), total: job.entry.bytes,
        verifyDone: job.verifyDone || 0, verifyTotal: job.file ? job.file.size : 0 } : null,
      installed: entries.map((e) => ({
        id: e.id, repo: e.repo, title: e.title, quant: e.quant, kind: e.kind || 'chat', image: isImage(e), bytes: e.bytes, vision: e.vision, tools: e.tools,
        moe: e.moe, uncensored: e.uncensored, ctx: e.ctx, ctxMax: e.ctxMax, status: e.status, error: e.error,
        done: e.status === 'installed' ? e.bytes : doneBytes(e),
        fit: !hw ? null : isImage(e)
          ? estimateImage((e.files.find((f) => f.role === 'model') || { size: 0 }).size, (e.files.find((f) => f.role === 'text_encoders') || { size: 0 }).size, hw)
          : estimate(e, e.bytes - (e.files.find((f) => f.role === 'mmproj') || { size: 0 }).size,
            (e.files.find((f) => f.role === 'mmproj') || { size: 0 }).size, e.ctx || DEFAULT_CTX, hw),
      })),
    };
  }

  // Installed image/video models with their files, for ComfyUI workflows.
  const imageModels = () => installed().filter(isImage).map((e) => ({ title: e.title, quant: e.quant, arch: e.arch, files: e.files }));

  return { state, install, pause, resume, remove, start, stop, poll, tick, adopt, recommended, details, imageModels,
    search, syncHarness, busy: () => !!job, activeStatus: () => active.status };
}

module.exports = { createModels, estimate, recommendQuant };
