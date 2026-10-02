// Leftovers of the Windows look that 2.0 no longer has (Windhawk with its styler mods). The installer
// removes them when updating, but Windhawk's engine DLL stays loaded in the apps it hooked (browsers,
// Settings) until they close, so a locked folder is retried here on every start — only when nothing
// holds the DLL any more, and into the Recycle Bin.
'use strict';
const fs = require('fs');
const path = require('path');

function cleanLegacy(root, run, journal, T) {
  const dir = path.join(root, 'tools', 'windhawk');
  if (!fs.existsSync(dir)) return;
  const ps = [
    `$d = '${dir.replace(/'/g, "''")}'`,
    "$e = Join-Path $d 'windhawk.exe'",
    "if (Get-Process windhawk -ErrorAction SilentlyContinue | Where-Object { $_.Path -like \"$d\\*\" }) { if (Test-Path $e) { Start-Process $e -ArgumentList '-exit', '-wait' -Wait -WindowStyle Hidden } }",
    "$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
    "$v = (Get-ItemProperty $k -ErrorAction SilentlyContinue).'Windhawk (J.A.R.V.I.S.)'",
    "if ($v -and $v -like \"*$d\\*\") { Remove-ItemProperty $k -Name 'Windhawk (J.A.R.V.I.S.)' }",
    "if (tasklist /m windhawk.dll /fo csv /nh | Select-String '\\.exe') { 'busy'; exit }",
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    "try { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($d, 'OnlyErrorDialogs', 'SendToRecycleBin') } catch {}",
    "if (Test-Path $d) { 'busy' } else { 'removed' }",
  ].join('\n');
  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { timeout: 60000 })
    .then(({ stdout }) => {
      if (/removed/.test(stdout)) journal(T('Удалены остатки Windhawk из прошлой версии (в корзину)', 'Removed the Windhawk leftovers of the previous version (to the Recycle Bin)'), 'ok');
    })
    .catch(() => {});
}

module.exports = { cleanLegacy };
