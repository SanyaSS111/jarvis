// Engines for this PC's GPU, and what to do when the GPU changes.
// - Detects a changed configuration (data\launcher\hardware.json keeps the last one seen) and works out what
//   no longer fits: the llama.cpp build (CUDA / Vulkan / CPU) and the ComfyUI build or its GPU/CPU mode.
// - apply(): new engines are fetched next to the old ones first, then swapped in; the old ones are kept as
//   runtime\llama.cpp-<kind> / tools\comfyui-<variant> (switching back is instant) or deleted, as the person chooses.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { T } = require('./i18n');
const { fingerprint } = require('./hardware');
const { pickVariant, VARIANTS } = require('./comfy');

// The llama.cpp release the installer ships (same files and SHA-256 as Installer.cs).
const LLAMA_BASE = 'https://github.com/ggml-org/llama.cpp/releases/download/b10964/';
const LLAMA = {
  cuda: [
    { file: 'llama-b10964-bin-win-cuda-12.4-x64.zip', size: 254067651, sha: '264f20d7ee3860aecca9ec12418357a9f3e80349a2b186f66c63859ded1a9593' },
    { file: 'cudart-llama-bin-win-cuda-12.4-x64.zip', size: 391443627, sha: '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' },
  ],
  vulkan: [{ file: 'llama-b10964-bin-win-vulkan-x64.zip', size: 31674542, sha: '1ee3ad952f4ba71f438bd6d7bebef19e1c7af04adcaa35d08b4ddabb27d4c642' }],
  cpu: [{ file: 'llama-b10964-bin-win-cpu-x64.zip', size: 18427629, sha: '917f39c076402c421224824607397af20f53625a60defc20e8dd22446bf4c5d7' }],
};
const ENGINE_LABEL = () => ({ cuda: 'CUDA (NVIDIA)', vulkan: 'Vulkan', sycl: 'SYCL (Intel)', cpu: T('процессор', 'CPU') });

async function dirSize(dir) {
  let total = 0;
  const walk = async (d) => {
    let items;
    try { items = await fs.promises.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) await walk(p);
      else if (it.isFile()) { try { total += (await fs.promises.stat(p)).size; } catch {} }
    }
  };
  await walk(dir);
  return total;
}

function createEngines({ root, run, journal, getHw, refreshHw, models, comfy }) {
  const llamaDir = path.join(root, 'runtime', 'llama.cpp');
  const dlDir = path.join(root, 'data', 'downloads');
  const hwFile = path.join(root, 'data', 'launcher', 'hardware.json');
  const curl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  const llamaStash = (kind) => llamaDir + '-' + kind;
  const comfyStash = (variant) => comfy.dir + '-' + variant;
  const hasLlama = (dir) => fs.existsSync(path.join(dir, 'llama-server.exe'));
  const hasComfy = (dir) => fs.existsSync(path.join(dir, 'python_embeded', 'python.exe'));

  const st = { busy: false, step: null, done: 0, total: 0, error: null, hidden: false };
  let saved = null;        // {fingerprint, summary, ack}
  let change = null;       // {from, to} summaries when the configuration differs from the saved one
  let actions = [];        // see plan()
  let stashes = [];        // kept old engines: [{id, kind, label, dir, bytes}]
  let dl = null;           // {file, base} while downloading (progress)

  const readSaved = () => { try { return JSON.parse(fs.readFileSync(hwFile, 'utf8')); } catch { return null; } };
  function writeSaved(extra) {
    const hw = getHw();
    saved = { fingerprint: fingerprint(hw), summary: summary(hw), at: new Date().toISOString(), ...extra };
    fs.mkdirSync(path.dirname(hwFile), { recursive: true });
    fs.writeFileSync(hwFile, JSON.stringify(saved, null, 2));
  }
  function summary(hw) {
    return { gpu: hw.gpu ? hw.gpu.name : null, vramGB: hw.gpu ? Math.round(hw.gpu.vramMB / 1024) : 0, ramGB: Math.round(hw.ramMB / 1024) };
  }
  const actionsKey = () => actions.map((a) => `${a.id}:${a.kind}:${a.to}`).join('|');

  // What the current GPU needs that is not there.
  async function plan() {
    const hw = getHw();
    const next = [];
    if (!hw) { actions = next; return; }
    const engine = hw.engine, want = hw.recommendedEngine;
    // Vulkan also runs on NVIDIA, so it stays there — unless a kept CUDA engine makes the switch back instant.
    const ready = hasLlama(llamaStash(want));
    if (engine !== 'none' && engine !== want && (!(engine === 'vulkan' && want === 'cuda') || ready)) {
      next.push({ id: 'llama', kind: 'switch', from: engine, to: want, ready,
        bytes: ready ? 0 : LLAMA[want].filter((f) => !cached(f)).reduce((s, f) => s + f.size, 0), oldBytes: await dirSize(llamaDir) });
    }
    if (comfy.installed()) {
      const info = comfy.info();
      const pick = pickVariant(hw);
      if (info.variant && info.variant !== pick.key) {
        const ready = hasComfy(comfyStash(pick.key));
        next.push({ id: 'comfy', kind: 'reinstall', from: info.variant, to: pick.key, cpu: !!pick.cpu, unsupported: !!pick.unsupported, ready,
          bytes: ready ? 0 : VARIANTS[pick.key].size, oldBytes: await dirSize(comfy.dir) });
      } else if (!!info.cpu !== !!pick.cpu) {
        next.push({ id: 'comfy', kind: 'mode', from: info.cpu ? 'cpu' : 'gpu', to: pick.cpu ? 'cpu' : 'gpu', unsupported: !!pick.unsupported, bytes: 0, oldBytes: 0 });
      }
    }
    actions = next;
    // Old engines kept from an earlier switch.
    const list = [];
    for (const kind of Object.keys(LLAMA)) {
      const d = llamaStash(kind);
      if (hasLlama(d)) list.push({ id: 'llama-' + kind, dir: d, kind: 'llama', name: kind, bytes: await dirSize(d) });
    }
    for (const v of Object.keys(VARIANTS)) {
      const d = comfyStash(v);
      if (hasComfy(d)) list.push({ id: 'comfy-' + v, dir: d, kind: 'comfy', name: v, bytes: await dirSize(d) });
    }
    stashes = list;
  }

  // At launcher start, after the hardware probe.
  async function check() {
    saved = readSaved();
    const hw = getHw();
    if (!hw) return;
    const fp = fingerprint(hw);
    if (!saved) writeSaved({}); // first start: this is the baseline
    else if (JSON.stringify(saved.fingerprint) !== JSON.stringify(fp)) {
      change = { from: saved.summary, to: summary(hw) };
      journal(T(`Конфигурация ПК изменилась: ${saved.summary.gpu || 'без видеокарты'} → ${summary(hw).gpu || 'без видеокарты'}`,
        `PC configuration changed: ${saved.summary.gpu || 'no GPU'} → ${summary(hw).gpu || 'no GPU'}`), 'warn');
    }
    await plan();
    if (actions.length) journal(T('Движки не подходят к видеокарте — нужно обновление (окно в лаунчере)', 'The engines do not match the GPU — an update is needed (see the launcher)'), 'warn');
  }

  function visible() {
    if (st.busy || st.error) return true;
    if (st.hidden) return false;
    if (change) return true;
    return actions.length > 0 && !(saved && saved.ack === actionsKey());
  }

  // ---------------------------------------------------------------- downloads
  // A verified copy that is already on this PC: the installer's build cache (developer PC) or an earlier download.
  function cached(f) {
    for (const d of [path.join(root, 'installer', 'cache', 'dl'), dlDir]) {
      const p = path.join(d, f.file);
      try { if (fs.statSync(p).size === f.size) return p; } catch {}
    }
    return null;
  }
  function sha256(file) {
    return new Promise((resolve, reject) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file, { highWaterMark: 4 * 1024 * 1024 }).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
    });
  }
  async function fetchFile(f, base, label) {
    const have = cached(f);
    if (have && (await sha256(have)) === f.sha) return have;
    fs.mkdirSync(dlDir, { recursive: true });
    const file = path.join(dlDir, f.file), part = file + '.part';
    for (let attempt = 1; ; attempt++) {
      st.step = label; dl = { file: part, base };
      const code = await new Promise((resolve) => {
        const p = cp.spawn(curl, ['-L', '--fail', '-s', '-S', '-C', '-', '--retry', '5', '--retry-all-errors', '-o', part, LLAMA_BASE + f.file], { windowsHide: true, stdio: 'ignore' });
        p.on('exit', resolve); p.on('error', () => resolve(-1));
      });
      dl = null;
      let len = 0; try { len = fs.statSync(part).size; } catch {}
      if (code === 0 && len === f.size) break;
      if (attempt >= 10) throw new Error(T(`Не удалось скачать ${f.file} (curl ${code}). Проверьте интернет и нажмите «Обновить» ещё раз.`, `Could not download ${f.file} (curl ${code}). Check your connection and press "Update" again.`));
      st.step = T(`${label}: обрыв связи, повтор…`, `${label}: connection lost, retrying…`);
      await new Promise((r) => setTimeout(r, 5000));
    }
    st.step = T(`${label}: проверка целостности`, `${label}: verifying`);
    if ((await sha256(part)) !== f.sha) { fs.rmSync(part, { force: true }); throw new Error(T(`${f.file} повреждён при загрузке — нажмите «Обновить» ещё раз.`, `${f.file} was corrupted during download — press "Update" again.`)); }
    fs.renameSync(part, file);
    return file;
  }

  // ---------------------------------------------------------------- llama.cpp
  async function switchLlama(a, removeOld) {
    const labels = ENGINE_LABEL();
    if (models.activeStatus() !== 'off') { await models.stop(true); await new Promise((r) => setTimeout(r, 1000)); }
    let fresh = llamaStash(a.to);
    let downloaded = [];
    if (!hasLlama(fresh)) {
      // New engine first, next to the old one: a failed download leaves the working engine in place.
      fresh = llamaDir + '.new';
      fs.rmSync(fresh, { recursive: true, force: true });
      fs.mkdirSync(fresh, { recursive: true });
      const files = LLAMA[a.to];
      st.total = files.reduce((s, f) => s + f.size, 0); st.done = 0;
      let base = 0;
      for (const f of files) {
        const zip = await fetchFile(f, base, T(`Скачиваю движок ${labels[a.to]}`, `Downloading the ${labels[a.to]} engine`));
        if (zip.startsWith(dlDir)) downloaded.push(zip);
        base += f.size; st.done = base;
        st.step = T(`Распаковываю ${f.file}`, `Unpacking ${f.file}`);
        const r = await run(tar, ['-xf', zip, '-C', fresh], { timeout: 10 * 60000 });
        if (r.err) throw new Error(T('Не удалось распаковать ', 'Could not unpack ') + f.file + ': ' + (r.stderr || r.err.message).trim().slice(0, 200));
      }
      // Some archives put everything into one folder: lift it up.
      if (!hasLlama(fresh)) {
        const sub = fs.readdirSync(fresh).map((n) => path.join(fresh, n)).find((p) => hasLlama(p));
        if (!sub) throw new Error(T('В архиве движка нет llama-server.exe', 'The engine archive has no llama-server.exe'));
        for (const n of fs.readdirSync(sub)) fs.renameSync(path.join(sub, n), path.join(fresh, n));
      }
    }
    st.step = T('Меняю движок…', 'Swapping the engine…');
    if (fs.existsSync(llamaDir)) {
      if (removeOld) fs.rmSync(llamaDir, { recursive: true, force: true });
      else { fs.rmSync(llamaStash(a.from), { recursive: true, force: true }); fs.renameSync(llamaDir, llamaStash(a.from)); }
    }
    fs.renameSync(fresh, llamaDir);
    for (const z of downloaded) fs.rmSync(z, { force: true });
    journal(T(`Движок локальных моделей: ${labels[a.from]} → ${labels[a.to]}`, `Local model engine: ${labels[a.from]} → ${labels[a.to]}`) +
      (removeOld ? '' : T(' (старый сохранён)', ' (the old one is kept)')), 'ok');
  }

  // ---------------------------------------------------------------- ComfyUI
  async function switchComfy(a, removeOld) {
    if (comfy.running()) await comfy.stop();
    if (a.kind === 'mode') {
      comfy.setMode(a.to === 'cpu');
      journal(a.to === 'cpu' ? T('ComfyUI переключён на процессор', 'ComfyUI switched to the CPU') : T('ComfyUI переключён на видеокарту', 'ComfyUI switched to the GPU'), 'ok');
      return;
    }
    const stash = comfyStash(a.to);
    if (hasComfy(stash)) {
      st.step = T('Возвращаю сохранённую сборку ComfyUI…', 'Restoring the kept ComfyUI build…');
      await new Promise((r) => setTimeout(r, 800));
      if (removeOld) fs.rmSync(comfy.dir, { recursive: true, force: true });
      else { fs.rmSync(comfyStash(a.from), { recursive: true, force: true }); fs.renameSync(comfy.dir, comfyStash(a.from)); }
      fs.renameSync(stash, comfy.dir);
      comfy.setMode(a.cpu);
    } else {
      st.step = T('Устанавливаю ComfyUI для новой видеокарты (прогресс — в панели ComfyUI)…', 'Installing ComfyUI for the new GPU (progress is in the ComfyUI panel)…');
      await comfy.install({ replace: true, keepOld: !removeOld });
      if (comfy.lastError()) throw new Error('ComfyUI: ' + comfy.lastError());
    }
    journal(T(`ComfyUI: сборка ${a.from} → ${a.to}`, `ComfyUI: build ${a.from} → ${a.to}`) + (removeOld ? '' : T(' (старая сохранена)', ' (the old one is kept)')), 'ok');
  }

  async function apply({ removeOld = false } = {}) {
    if (st.busy) return;
    Object.assign(st, { busy: true, error: null, step: null, done: 0, total: 0 });
    // Each part on its own: a failed download must not hold back the others.
    const errors = [];
    try {
      for (const a of actions) {
        try {
          if (a.id === 'llama') await switchLlama(a, removeOld);
          if (a.id === 'comfy') await switchComfy(a, removeOld);
        } catch (e) {
          errors.push(String(e.message || e));
          journal(T('Обновление движков: ', 'Engine update: ') + errors[errors.length - 1], 'error');
        } finally { dl = null; st.done = 0; st.total = 0; }
      }
      await refreshHw().catch(() => {});
      await plan().catch(() => {});
      if (errors.length) st.error = errors.join('\n');
      else {
        change = null;
        writeSaved({ ack: actionsKey() });
        st.hidden = false;
        journal(T('Обновление под новую конфигурацию завершено', 'Update for the new configuration complete'), 'ok');
      }
    } finally { st.busy = false; st.step = null; dl = null; }
  }

  // "Don't remind me": the current configuration and plan become the accepted ones.
  function dismiss() { change = null; st.error = null; writeSaved({ ack: actionsKey() }); }
  function later() { st.hidden = true; st.error = null; }
  function show() { st.hidden = false; if (saved && saved.ack === actionsKey()) saved.ack = null; }

  async function removeStash(id) {
    const s = stashes.find((x) => x.id === id);
    if (!s || st.busy) return;
    fs.rmSync(s.dir, { recursive: true, force: true });
    journal(T(`Удалён сохранённый движок: ${s.name}`, `Deleted the kept engine: ${s.name}`), 'ok');
    await plan();
  }

  function tick() {
    if (!dl) return;
    try { st.done = dl.base + fs.statSync(dl.file).size; } catch {}
  }

  function state() {
    return { ...st, visible: visible(), change, actions, stashes: stashes.map(({ dir, ...s }) => s) };
  }

  return { check, plan, apply, dismiss, later, show, removeStash, tick, state, busy: () => st.busy };
}

module.exports = { createEngines };
