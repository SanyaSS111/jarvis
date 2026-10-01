// Hardware probe: GPUs (name, vendor, dedicated memory), RAM, CPU threads, and which
// llama.cpp engine is installed. Used to judge how well a model will run on this PC.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DISPLAY_CLASS = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
const SMI = ['C:\\Windows\\System32\\nvidia-smi.exe', 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe']
  .find((p) => fs.existsSync(p));

function vendorOf(name) {
  if (/nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (/amd|radeon|ati /i.test(name)) return 'amd';
  if (/intel|arc/i.test(name)) return 'intel';
  return 'other';
}

// Parses `reg query <display class> /s`: DriverDesc + HardwareInformation.qwMemorySize per adapter.
function parseRegistry(text) {
  const adapters = new Map();
  let key = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^HKEY_/i.test(line)) { key = /\\\d{4}$/.test(line) ? line : null; continue; }
    if (!key) continue;
    const m = line.match(/^\s+(\S[^\t]*?)\s{2,}(REG_\w+)\s{2,}(.*)$/);
    if (!m) continue;
    const [, name, type, value] = m;
    const a = adapters.get(key) || {};
    if (name === 'DriverDesc') a.name = value.trim();
    if (name === 'HardwareInformation.qwMemorySize' && type === 'REG_QWORD') a.mem = Number(BigInt(value.trim()));
    if (name === 'HardwareInformation.MemorySize' && a.mem == null) {
      if (type === 'REG_DWORD') a.mem = parseInt(value, 16);
      if (type === 'REG_BINARY') { const hex = value.trim(); a.mem = Number(BigInt('0x' + (hex.match(/../g) || []).reverse().join('') || '0')); }
    }
    adapters.set(key, a);
  }
  return [...adapters.values()].filter((a) => a.name && !/basic display|remote|virtual|meta|parsec|idd/i.test(a.name));
}

// Adapters that are actually plugged in (WMI). The display class key above also keeps the entries of
// removed cards (an old GTX after a swap to a Radeon), so it only supplies the memory sizes.
async function presentAdapters(run) {
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const { stdout } = await run(ps, ['-NoProfile', '-NonInteractive', '-Command',
    "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name + '|' + $_.ConfigManagerErrorCode }"],
  { timeout: 15000 });
  return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    .map((l) => { const i = l.lastIndexOf('|'); return { name: l.slice(0, i).trim(), error: Number(l.slice(i + 1)) || 0 }; })
    .filter((a) => a.name && a.error === 0);
}

function engineKind(llamaDir) {
  if (!fs.existsSync(path.join(llamaDir, 'llama-server.exe'))) return 'none';
  if (fs.existsSync(path.join(llamaDir, 'ggml-cuda.dll'))) return 'cuda';
  if (fs.existsSync(path.join(llamaDir, 'ggml-vulkan.dll'))) return 'vulkan';
  if (fs.existsSync(path.join(llamaDir, 'ggml-sycl.dll'))) return 'sycl';
  return 'cpu';
}

async function detectHardware(run, llamaDir) {
  const gpus = [];
  let present = [];
  try { present = await presentAdapters(run); } catch {}
  // Without WMI (rare) everything the registry knows is taken, as before.
  const isPresent = (name) => !present.length || present.some((a) => a.name === name);
  if (SMI) {
    // nvidia-smi stays behind after a switch to another vendor and then prints only an error.
    const { stdout } = await run(SMI, ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
    for (const line of stdout.split(/\r?\n/)) {
      const [name, mem] = line.split(',').map((s) => s && s.trim());
      if (name && Number(mem) > 0 && isPresent(name)) gpus.push({ name, vendor: 'nvidia', vramMB: Number(mem) });
    }
  }
  // Targeted value queries: a full `/s` scan of this key takes ~20 s, these take ~20 ms each.
  const values = ['DriverDesc', 'HardwareInformation.qwMemorySize', 'HardwareInformation.MemorySize'];
  const outs = await Promise.all(values.map((v) => run('reg.exe', ['query', DISPLAY_CLASS, '/s', '/v', v], { encoding: 'latin1', timeout: 8000 })));
  for (const a of parseRegistry(outs.map((o) => o.stdout).join('\n'))) {
    if (gpus.some((g) => g.name === a.name) || !isPresent(a.name)) continue;
    gpus.push({ name: a.name, vendor: vendorOf(a.name), vramMB: Math.round((a.mem || 0) / 1048576) });
  }
  // Integrated graphics share system memory: treat them as "no dedicated GPU".
  for (const g of gpus) g.integrated = g.vramMB < 2048 || (g.vendor === 'intel' && !/arc/i.test(g.name)) || /radeon\(tm\) graphics|vega \d+ graphics|uhd|iris/i.test(g.name);
  const best = gpus.filter((g) => !g.integrated).sort((a, b) => b.vramMB - a.vramMB)[0] || null;
  const engine = engineKind(llamaDir);
  const recommended = best ? (best.vendor === 'nvidia' ? 'cuda' : 'vulkan') : 'cpu';
  // The engine decides whether the GPU is usable at all.
  const gpuUsable = !!best && ((engine === 'cuda' && best.vendor === 'nvidia') || engine === 'vulkan' || engine === 'sycl');
  return {
    gpus,
    gpu: best,
    vramMB: gpuUsable ? best.vramMB : 0,
    ramMB: Math.round(os.totalmem() / 1048576),
    threads: os.cpus().length,
    cpu: (os.cpus()[0] || {}).model || '',
    engine,
    recommendedEngine: recommended,
    engineMismatch: engine !== 'none' && engine !== recommended && !(engine === 'vulkan' && recommended === 'cuda'),
  };
}

// What counts as "the configuration" for the update prompt: the discrete GPUs and the amount of RAM.
function fingerprint(hw) {
  const gpus = (hw.gpus || []).filter((g) => !g.integrated).map((g) => g.name).sort();
  return { gpus, ramGB: Math.round((hw.ramMB || 0) / 1024) };
}

module.exports = { detectHardware, fingerprint };
