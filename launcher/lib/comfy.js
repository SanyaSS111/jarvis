// ComfyUI for image/video models (the GGUFs llama.cpp can't run): official portable build in
// tools\comfyui (variant picked for this GPU, SHA-256 checked), the ComfyUI-GGUF node, model folders in
// models\comfyui (extra_model_paths.yaml), ready workflows for known models, and the server on :8188.
'use strict';
const { T } = require('./i18n');
const lbl = (o) => (Array.isArray(o.label) ? T(...o.label) : o.label);
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const PORT = 8188;
const VERSION = 'v0.37.0';
const BASE = `https://github.com/Comfy-Org/ComfyUI/releases/download/${VERSION}/`;
// Official portable builds (release assets, digests from GitHub).
const VARIANTS = {
  // CUDA 13: RTX 20xx and newer.
  nvidia: { file: 'ComfyUI_windows_portable_nvidia.7z', size: 1925204508, sha: '7805f634fab51f63a238aaf0cfe2a9833bb7c86ddfc8400a60919f44460d7d65', bat: 'run_nvidia_gpu.bat', label: 'NVIDIA RTX (CUDA 13)' },
  // CUDA 12.6: the last one with GTX 10xx / 9xx and Volta, also fine for no-GPU (CPU mode).
  nvidia_cu126: { file: 'ComfyUI_windows_portable_nvidia_cu126.7z', size: 1867201814, sha: '4f8c587c8319a3595dcdc6b8fbfc7234d2d02fa6b1a328c1ab3e819c97d95fb8', bat: 'run_nvidia_gpu.bat', label: ['NVIDIA GTX/старые карты (CUDA 12.6)', 'NVIDIA GTX/older cards (CUDA 12.6)'] },
  amd: { file: 'ComfyUI_windows_portable_amd.7z', size: 1595844037, sha: '563da2462a866f8fdf8ccd091a8c0e185e785394408735f8e99647593a67dd79', bat: 'run_amd_gpu.bat', label: 'AMD Radeon' },
  intel: { file: 'ComfyUI_windows_portable_intel.7z', size: 1512836652, sha: '1041af3a25ca2c7b3615db3027ca0fd40df37c1758c4e9955e762672193ac4cc', bat: 'run_intel_gpu.bat', label: 'Intel Arc' },
};
// GGUF loader nodes; the leejet fork knows the newest image architectures (Qwen-Image 2.1).
const GGUF_NODE = { url: 'https://codeload.github.com/leejet/ComfyUI-GGUF/zip/edd981b10e107d3b8f58e16c498f2d08f631bc47',
  sha: 'fc01808afffb4f6a9fcfda916569963f05c7b50d58dfe8f7d0d3a2cf187be199' };
// Official Comfy-Org workflow per GGUF architecture; the UNETLoader in it becomes the GGUF loader.
const TEMPLATES = {
  qwen_image21: [
    { url: 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_t2i.json', suffix: '' },
    { url: 'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/image_qwen_image_2_1_image_edit.json', suffix: [' — редактирование фото', ' — photo edit'] },
  ],
};

// The AMD build runs on ROCm, which needs RDNA 2 or newer: RX 6000 / 7000 / 9000, Radeon AI PRO, Ryzen AI
// Max. Older Radeons (RX 400/500, Vega, RX 5000) get the CPU mode. The Intel build needs an Arc GPU.
const AMD_ROCM = /\bRX\s*(6\d{3}|7\d{3}|9\d{3})|Radeon\s+(AI\s+)?PRO\s+(W7|W9|R9)|Radeon\s+80[56]0S|Ryzen\s+AI\s+Max/i;

function pickVariant(hw) {
  const g = hw && hw.gpu;
  if (!g) return { key: 'nvidia_cu126', cpu: true };
  if (g.vendor === 'amd') return AMD_ROCM.test(g.name) ? { key: 'amd' } : { key: 'nvidia_cu126', cpu: true, unsupported: true };
  if (g.vendor === 'intel') return /\barc\b/i.test(g.name) ? { key: 'intel' } : { key: 'nvidia_cu126', cpu: true, unsupported: true };
  if (g.vendor === 'nvidia') return { key: /\bRTX\b|\bA\d{3,4}\b|\bL\d{1,2}S?\b|\bH\d{3}\b/i.test(g.name) ? 'nvidia' : 'nvidia_cu126' };
  return { key: 'nvidia_cu126', cpu: true };
}

function createComfy({ root, run, killTree, listeningPid, httpGet, journal, getHw, openEdge, imageModels }) {
  const dir = path.join(root, 'tools', 'comfyui');
  const py = path.join(dir, 'python_embeded', 'python.exe');
  const main = path.join(dir, 'ComfyUI', 'main.py');
  const modelsDir = path.join(root, 'models', 'comfyui');
  const dataDir = path.join(root, 'data', 'comfyui');
  const outputDir = path.join(dataDir, 'output');
  const dlDir = path.join(root, 'data', 'downloads');
  const infoFile = path.join(dir, 'jarvis.json');
  const curl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  fs.mkdirSync(dataDir, { recursive: true });

  const st = { status: 'off', step: null, done: 0, total: 0, speed: 0, error: null, pid: null, since: null };
  let busy = false;
  let proc = null;
  let samples = [];
  let dl = null; // {file, total}

  const installed = () => fs.existsSync(py) && fs.existsSync(main);
  const readInfo = () => { try { return JSON.parse(fs.readFileSync(infoFile, 'utf8')); } catch { return {}; } };
  const fileLen = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

  function sha256(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
        .on('data', (c) => { h.update(c); st.done += c.length; })
        .on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  }

  // curl with resume; progress comes from the .part size (tick()).
  async function download(url, file, size, sha, label) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (size ? fileLen(file) === size : fs.existsSync(file)) return;
    const part = file + '.part';
    for (let attempt = 1; ; attempt++) {
      st.step = label; st.total = size; dl = { file: part, total: size }; samples = [];
      const code = await new Promise((resolve) => {
        const p = cp.spawn(curl, ['-L', '--fail', '-s', '-S', '-C', '-', '--retry', '5', '--retry-all-errors', '-o', part, url], { windowsHide: true, stdio: 'ignore' });
        p.on('exit', resolve); p.on('error', () => resolve(-1));
      });
      dl = null;
      if (code === 0 && (!size || fileLen(part) === size)) break;
      if (attempt >= 20) throw new Error(T(`Не удалось скачать ${path.basename(file)} (curl ${code}). Проверьте интернет и нажмите «Установить» ещё раз — загрузка продолжится.`, `Could not download ${path.basename(file)} (curl ${code}). Check your connection and press "Install" again — the download will resume.`));
      st.step = T(`${label}: обрыв связи, повтор через 5 с (попытка ${attempt}/20)`, `${label}: connection lost, retrying in 5 s (attempt ${attempt}/20)`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (sha) {
      st.step = T(`${label}: проверка целостности`, `${label}: verifying`); st.done = 0; st.total = fileLen(part);
      if ((await sha256(part)) !== sha) { fs.unlinkSync(part); throw new Error(T(`${path.basename(file)} повреждён при загрузке и удалён — нажмите «Установить» ещё раз.`, `${path.basename(file)} was corrupted during download and removed — press "Install" again.`)); }
    }
    fs.renameSync(part, file);
  }

  function writeModelPaths() {
    for (const d of ['diffusion_models', 'text_encoders', 'vae', 'loras', 'checkpoints']) fs.mkdirSync(path.join(modelsDir, d), { recursive: true });
    const base = modelsDir.replace(/\\/g, '/');
    fs.writeFileSync(path.join(dir, 'ComfyUI', 'extra_model_paths.yaml'),
      `# Written by the J.A.R.V.I.S. launcher: models downloaded from its catalog.\njarvis:\n  base_path: ${base}\n` +
      '  diffusion_models: diffusion_models\n  unet: diffusion_models\n  text_encoders: text_encoders\n  clip: text_encoders\n' +
      '  vae: vae\n  loras: loras\n  checkpoints: checkpoints\n');
  }

  // replace: a new build for a changed GPU over the installed one; keepOld moves the old build to
  // tools\comfyui-<variant> (switching back is then instant), otherwise it is deleted once the new one is ready.
  async function install({ replace = false, keepOld = false } = {}) {
    if (busy || (installed() && !replace)) return;
    const hw = getHw();
    const pick = pickVariant(hw);
    const v = VARIANTS[pick.key];
    const oldVariant = readInfo().variant;
    busy = true; st.status = 'installing'; st.error = null;
    journal(T(`Установка ComfyUI ${VERSION} (${lbl(v)}, ${(v.size / 1073741824).toFixed(1)} ГБ)…`, `Installing ComfyUI ${VERSION} (${lbl(v)}, ${(v.size / 1073741824).toFixed(1)} GB)…`));
    try {
      const free = fs.statfsSync(root);
      if (free.bavail * free.bsize < v.size * 3) throw new Error(T(`Нужно около ${(v.size * 3 / 1073741824).toFixed(0)} ГБ свободного места (архив + распаковка).`, `About ${(v.size * 3 / 1073741824).toFixed(0)} GB of free space is needed (archive + unpacking).`));
      const archive = path.join(dlDir, v.file);
      await download(BASE + v.file, archive, v.size, v.sha, T('Скачиваю ComfyUI', 'Downloading ComfyUI'));

      st.step = T('Распаковываю ComfyUI (несколько минут)…', 'Unpacking ComfyUI (a few minutes)…'); st.done = 0; st.total = 0;
      const tmp = dir + '.tmp';
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      const r = await run(tar, ['-xf', archive, '-C', tmp], { timeout: 30 * 60000 });
      if (r.err) throw new Error(T('Не удалось распаковать архив ComfyUI: ', 'Could not unpack the ComfyUI archive: ') + (r.stderr || r.err.message).trim().slice(0, 300));
      const top = fs.readdirSync(tmp).map((n) => path.join(tmp, n)).find((p) => fs.existsSync(path.join(p, 'python_embeded')));
      if (!top) throw new Error(T('В архиве ComfyUI нет python_embeded — архив не того формата.', 'The ComfyUI archive has no python_embeded — wrong archive format.'));
      if (keepOld && oldVariant && fs.existsSync(dir)) {
        const stash = dir + '-' + oldVariant;
        fs.rmSync(stash, { recursive: true, force: true });
        fs.renameSync(dir, stash);
      }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(top, dir);
      fs.rmSync(tmp, { recursive: true, force: true });

      st.step = T('Дополнение ComfyUI-GGUF (модели в формате GGUF)', 'ComfyUI-GGUF extension (GGUF models)');
      const zip = path.join(dlDir, 'ComfyUI-GGUF.zip');
      await download(GGUF_NODE.url, zip, 0, GGUF_NODE.sha, T('Скачиваю ComfyUI-GGUF', 'Downloading ComfyUI-GGUF'));
      const nodes = path.join(dir, 'ComfyUI', 'custom_nodes');
      const x = await run(tar, ['-xf', zip, '-C', nodes], { timeout: 120000 });
      if (x.err) throw new Error(T('Не удалось распаковать ComfyUI-GGUF', 'Could not unpack ComfyUI-GGUF'));
      const unpacked = fs.readdirSync(nodes).find((n) => /^ComfyUI-GGUF-[0-9a-f]{40}$/.test(n));
      const target = path.join(nodes, 'ComfyUI-GGUF');
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(path.join(nodes, unpacked), target);
      st.step = T('Библиотеки для ComfyUI-GGUF (pip)', 'Libraries for ComfyUI-GGUF (pip)');
      const pip = await run(py, ['-s', '-m', 'pip', 'install', '--no-warn-script-location', '-r', path.join(target, 'requirements.txt')], { timeout: 15 * 60000 });
      if (pip.err) throw new Error(T('pip не установил зависимости ComfyUI-GGUF: ', 'pip did not install the ComfyUI-GGUF dependencies: ') + (pip.stderr || '').trim().split(/\r?\n/).slice(-3).join(' '));

      writeModelPaths();
      fs.writeFileSync(infoFile, JSON.stringify({ version: VERSION, variant: pick.key, cpu: !!pick.cpu, installedAt: new Date().toISOString() }, null, 2));
      try { fs.unlinkSync(archive); } catch {}
      st.status = 'off';
      journal(T(`ComfyUI установлен (${lbl(v)})`, `ComfyUI installed (${lbl(v)})`), 'ok');
    } catch (e) {
      st.status = 'error'; st.error = String(e.message || e);
      journal('ComfyUI: ' + st.error, 'error');
    } finally { busy = false; st.step = null; dl = null; }
  }

  // Official template for the model's architecture, loader swapped to UnetLoaderGGUF, our file names in.
  // (Every CLIPLoader gets our text encoder — including the edit template's optional prompt-enhancer
  // loader, which is switched off but must still point at an existing file to pass validation.)
  async function writeWorkflow(m) {
    for (const t of TEMPLATES[m.arch] || []) await writeOneWorkflow(m, t.url, t.suffix);
  }
  async function writeOneWorkflow(m, url, suffix) {
    const sfx = Array.isArray(suffix) ? suffix : [suffix, suffix];
    const nameOf = (s) => `${m.title} ${m.quant}${s}.json`.replace(/[<>:"/\\|?*]/g, '_');
    const name = nameOf(T(...sfx));
    const out = path.join(dir, 'ComfyUI', 'user', 'default', 'workflows', name);
    if (fs.existsSync(out)) return;
    for (const s of sfx) {
      const twin = path.join(path.dirname(out), nameOf(s));
      if (twin !== out && fs.existsSync(twin)) { fs.renameSync(twin, out); return; }
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(T('шаблон workflow недоступен (', 'workflow template unavailable (') + res.status + ')');
    const w = await res.json();
    const file = (role) => (m.files.find((f) => f.subdir === role) || {}).name;
    const unet = file('diffusion_models'), te = file('text_encoders'), vae = file('vae');
    const renames = new Map();
    const graphs = [w, ...((w.definitions && w.definitions.subgraphs) || [])];
    for (const g of graphs) {
      for (const n of g.nodes || []) {
        const wv = n.widgets_values;
        if (n.type === 'UNETLoader' && unet) {
          if (Array.isArray(wv) && wv[0]) renames.set(wv[0], unet);
          n.type = 'UnetLoaderGGUF'; n.widgets_values = [unet];
          n.properties = { ...(n.properties || {}), 'Node name for S&R': 'UnetLoaderGGUF' };
        } else if (n.type === 'CLIPLoader' && te && Array.isArray(wv)) { renames.set(wv[0], te); wv[0] = te; }
        else if (n.type === 'VAELoader' && vae && Array.isArray(wv)) { renames.set(wv[0], vae); wv[0] = vae; }
        if (n.properties) delete n.properties.models; // no "download the original model" prompt
      }
    }
    // Widgets promoted onto the subgraph node carry the same file names.
    for (const g of graphs) for (const n of g.nodes || []) {
      if (Array.isArray(n.widgets_values)) n.widgets_values = n.widgets_values.map((v) => (renames.has(v) ? renames.get(v) : v));
    }
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(w, null, 2));
    journal(T(`ComfyUI: готовый workflow «${name}»`, `ComfyUI: workflow "${name}" ready`), 'ok');
  }

  // show: open the window when ready (false when the agent starts ComfyUI for image generation).
  let showWhenReady = true;
  // quiet: started in the background for the agent (nobody looks at its window) — may be stopped when idle.
  let quiet = false;
  let lastBusy = 0;
  async function start({ show = true } = {}) {
    if (!installed()) throw new Error(T('ComfyUI не установлен', 'ComfyUI is not installed'));
    if (st.status === 'starting') { showWhenReady = showWhenReady || show; return; }
    // Models installed while ComfyUI was already open get their workflow too (it lists files on refresh).
    for (const m of imageModels()) { try { await writeWorkflow(m); } catch (e) { journal(T(`ComfyUI: workflow для «${m.title}» не создан: ${e.message}`, `ComfyUI: workflow for "${m.title}" not created: ${e.message}`), 'warn'); } }
    if (st.status === 'on') { if (show) quiet = false; return show ? open() : undefined; }
    showWhenReady = show;
    writeModelPaths();
    const busyPid = await listeningPid(PORT);
    if (busyPid) {
      const r = await httpGet(`http://127.0.0.1:${PORT}/system_stats`, 2000);
      if (r.status === 200) { Object.assign(st, { status: 'on', pid: busyPid, since: Date.now(), error: null }); return show ? open() : undefined; }
      await killTree(busyPid);
    }
    const info = readInfo();
    const hw = getHw() || {};
    // Pictures live outside tools\comfyui: removing or reinstalling ComfyUI never takes them along.
    fs.mkdirSync(outputDir, { recursive: true });
    const args = ['-s', main, '--windows-standalone-build', '--listen', '127.0.0.1', '--port', String(PORT), '--disable-auto-launch',
      '--output-directory', outputDir];
    // An NVIDIA build on a PC whose GPU is now another vendor's (update postponed) can only use the CPU.
    const foreign = hw.gpu && hw.gpu.vendor !== 'nvidia' && /^nvidia/.test(info.variant || '');
    if (info.cpu || !hw.gpu || foreign) args.push('--cpu');
    else if (hw.gpu.vramMB && hw.gpu.vramMB < 8000) args.push('--lowvram');
    // Cards without bf16 (GTX 10xx/9xx, Volta, RTX 20xx) decode in fp16, which overflows in the Qwen/Wan VAE:
    // green/purple blotches and black squares. fp32 there costs almost nothing (the VAE is small).
    if (!info.cpu && hw.gpu && (info.variant === 'nvidia_cu126' || /RTX\s*20\d\d/i.test(hw.gpu.name))) args.push('--fp32-vae');
    // "Windows fatal exception: access violation" while loading or unloading models = the commit limit (RAM +
    // page file) ran out. ComfyUI pins ~40% of RAM by default (6.5 GB of 16): on PCs with ≤ 32 GB that pinned
    // block plus an 8.7 GB text encoder plus a GGUF model is more than Windows will give. Pinning off.
    // (Don't pass --disable-dynamic-vram: with GGUF models that crashes right at the first load.)
    if (!info.cpu && (!hw.ramMB || hw.ramMB <= 32768)) args.push('--disable-pinned-memory');
    // Appended, not overwritten: after a crash and restart the reason must still be in the log.
    const logFile = path.join(dataDir, 'comfyui.log');
    try { if (fs.statSync(logFile).size > 5 * 1048576) fs.renameSync(logFile, logFile + '.old'); } catch {}
    fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} ComfyUI start (${show ? 'window' : 'background, for the agent'}) =====\n`);
    const outFd = fs.openSync(logFile, 'a');
    quiet = !show; lastBusy = Date.now();
    // detached: keeps running after the launcher closes, like the local model.
    proc = cp.spawn(py, args, { cwd: dir, windowsHide: true, detached: true, stdio: ['ignore', outFd, outFd] });
    fs.closeSync(outFd);
    Object.assign(st, { status: 'starting', pid: proc.pid, since: Date.now(), error: null });
    journal(T('Запуск ComfyUI…', 'Starting ComfyUI…'));
    const me = proc;
    proc.on('exit', (code) => {
      if (proc !== me) return;
      proc = null;
      if (st.status === 'stopping' || st.status === 'off') { st.status = 'off'; return; }
      st.status = 'error';
      let t = '';
      try { t = fs.readFileSync(path.join(dataDir, 'comfyui.log'), 'utf8').split(/\r?\n/).filter(Boolean).slice(-8).join('\n'); } catch {}
      st.error = T(`ComfyUI завершился (код ${code}).\n`, `ComfyUI exited (code ${code}).\n`) + t;
      journal(T('ComfyUI упал', 'ComfyUI crashed'), 'error');
    });
  }

  function open() { openEdge(`http://127.0.0.1:${PORT}/`, path.join(dataDir, 'edge-profile'), '1440,920'); }

  async function stop() {
    const pid = st.pid || await listeningPid(PORT);
    st.status = 'stopping';
    proc = null;
    if (pid) await killTree(pid);
    Object.assign(st, { status: 'off', pid: null });
    journal(T('ComfyUI остановлен', 'ComfyUI stopped'));
  }

  async function remove() {
    if (busy) return;
    if (['starting', 'on'].includes(st.status)) await stop();
    busy = true;
    try {
      await new Promise((r) => setTimeout(r, 800));
      fs.rmSync(dir, { recursive: true, force: true });
      journal(T('ComfyUI удалён (модели в models\\comfyui и картинки в data\\comfyui\\output остались)', 'ComfyUI removed (models in models\\comfyui and images in data\\comfyui\\output were kept)'), 'ok');
    } catch (e) { st.error = T('Не удалось удалить: ', 'Could not delete: ') + e.message; journal(st.error, 'error'); }
    finally { busy = false; st.status = 'off'; }
  }

  async function poll() {
    if (st.status !== 'starting') return;
    const r = await httpGet(`http://127.0.0.1:${PORT}/system_stats`, 1500);
    if (r.status === 200 && st.status === 'starting') {
      st.status = 'on';
      journal(T(`ComfyUI готов за ${Math.round((Date.now() - st.since) / 1000)} с`, `ComfyUI ready in ${Math.round((Date.now() - st.since) / 1000)} s`), 'ok');
      if (showWhenReady) open();
    }
  }

  async function adopt() {
    if (!installed()) return;
    const pid = await listeningPid(PORT);
    if (!pid) return;
    const r = await httpGet(`http://127.0.0.1:${PORT}/system_stats`, 2000);
    if (r.status === 200) Object.assign(st, { status: 'on', pid, since: Date.now() });
  }

  // ComfyUI's own unload (/free) crashes the GGUF node on Windows (access violation while moving the weights
  // to RAM), so video memory is freed by stopping a background ComfyUI that has nothing to draw.
  async function queueBusy() {
    const r = await httpGet(`http://127.0.0.1:${PORT}/queue`, 3000);
    if (r.status !== 200) return null;
    try { const j = JSON.parse(r.body); return (j.queue_running || []).length + (j.queue_pending || []).length > 0; } catch { return null; }
  }
  // Before a local chat model loads: stop an idle background ComfyUI; a window the user opened stays.
  async function releaseForModel() {
    if (st.status !== 'on') return;
    const b = await queueBusy();
    if (quiet && b === false) { await stop(); journal(T('ComfyUI остановлен, чтобы освободить видеопамять для локальной модели', 'ComfyUI stopped to free VRAM for the local model')); }
    else journal(T('ComfyUI открыт и занимает видеопамять — локальная модель может загрузиться медленнее', 'ComfyUI is open and uses VRAM — the local model may load slower'), 'warn');
  }
  let idleCheckAt = 0;
  async function idleCheck() {
    if (st.status !== 'on' || !quiet || Date.now() < idleCheckAt) return;
    idleCheckAt = Date.now() + 60000;
    const b = await queueBusy();
    if (b) lastBusy = Date.now();
    else if (b === false && Date.now() - lastBusy > 15 * 60000) { await stop(); journal(T('ComfyUI остановлен: 15 минут без работы (освобождена видеопамять)', 'ComfyUI stopped: idle for 15 minutes (VRAM freed)')); }
  }

  function tick() {
    idleCheck().catch(() => {});
    if (!dl) return;
    const now = Date.now(), done = fileLen(dl.file);
    st.done = done;
    samples.push([now, done]);
    while (samples.length > 20) samples.shift();
    const [t0, b0] = samples[0];
    st.speed = now > t0 ? ((done - b0) * 1000) / (now - t0) : 0;
  }

  // GPU ↔ CPU mode of the installed build (the same build runs either way); takes effect on the next start.
  function setMode(cpu) {
    const info = readInfo();
    fs.writeFileSync(infoFile, JSON.stringify({ ...info, cpu: !!cpu }, null, 2));
  }

  function state() {
    const info = readInfo();
    const pick = pickVariant(getHw());
    return {
      ...st, installed: installed(), busy, port: PORT, version: info.version || null,
      variant: info.variant ? lbl(VARIANTS[info.variant]) : null,
      plan: { label: lbl(VARIANTS[pick.key]), bytes: VARIANTS[pick.key].size, cpu: !!pick.cpu, unsupported: !!pick.unsupported, version: VERSION },
      cpu: !!info.cpu,
    };
  }

  return { install, start, stop, remove, poll, tick, adopt, open, state, installed, releaseForModel, setMode, info: readInfo,
    busy: () => busy, running: () => ['starting', 'on'].includes(st.status), lastError: () => st.error, dir, modelsDir, outputDir };
}

module.exports = { createComfy, pickVariant, VARIANTS, VERSION };
