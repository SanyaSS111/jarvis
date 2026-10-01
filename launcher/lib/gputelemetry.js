// GPU load and used video memory for any vendor (nvidia-smi covers only NVIDIA): Windows' own
// "GPU Engine" / "GPU Adapter Memory" performance counters, read by one background PowerShell loop that
// prints a JSON line every ~2 s and ends together with the launcher. No temperature (no vendor-neutral source).
'use strict';
const cp = require('child_process');
const path = require('path');

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$parent = [int]$args[0]
while ($true) {
  if (-not (Get-Process -Id $parent)) { exit }
  $s = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage', '\\GPU Adapter Memory(*)\\Dedicated Usage').CounterSamples
  $mem = $s | Where-Object { $_.Path -like '*adapter memory*' } | Sort-Object CookedValue -Descending | Select-Object -First 1
  if ($mem) {
    $luid = $mem.InstanceName -replace '_phys.*$', ''
    $util = ($s | Where-Object { $_.Path -like '*gpu engine*' -and $_.InstanceName -like "*$luid*" } | Measure-Object CookedValue -Sum).Sum
    '{"load":' + [math]::Min(100, [math]::Round([double]$util)) + ',"usedMB":' + [math]::Round($mem.CookedValue / 1MB) + '}'
  }
  Start-Sleep -Seconds 2
}`;

function createGpuTelemetry() {
  let proc = null;
  let last = null;
  let buf = '';
  function start() {
    if (proc) return;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const encoded = Buffer.from(`$args = @(${process.pid})\n` + SCRIPT, 'utf16le').toString('base64');
    proc = cp.spawn(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        try { last = { ...JSON.parse(line), at: Date.now() }; } catch {}
      }
    });
    proc.on('exit', () => { proc = null; });
  }
  function stop() { if (proc) { try { proc.kill(); } catch {} proc = null; } }
  // The latest reading, or null when it is older than 10 s.
  function sample() { return last && Date.now() - last.at < 10000 ? last : null; }
  return { start, stop, sample, running: () => !!proc };
}

module.exports = { createGpuTelemetry };
