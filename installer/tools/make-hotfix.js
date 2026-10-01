// Builds a one-file hotfix (dist\JARVIS-hotfix-<version>.cmd) for installs that should not be reinstalled:
// a batch header finds the install and runs its portable Node on the JavaScript tail of the same file,
// which carries the fixed files (base64) and repairs what the bug already damaged.
//   node make-hotfix.js <version> <relative file>...   (paths relative to the install root, e.g. launcher\lib\agentlang.js)
'use strict';
const fs = require('fs');
const path = require('path');

const src = path.resolve(__dirname, '..', '..'); // C:\LLM
const [version, ...files] = process.argv.slice(2);
if (!version || !files.length) { console.error('usage: node make-hotfix.js <version> <file>...'); process.exit(1); }

const payload = files.map((rel) => {
  const text = fs.readFileSync(path.join(src, rel), 'utf8');
  if (/C:\\\\LLM|C:\\LLM|C:\/LLM/.test(text)) throw new Error(`${rel} contains C:\\LLM paths — needs templating, not supported here`);
  return { rel, b64: Buffer.from(text, 'utf8').toString('base64') };
});

// Batch part: plain ASCII, no "%" or "&" inside the node -e code.
const head = `@echo off
chcp 65001 >nul
setlocal
title J.A.R.V.I.S. hotfix ${version}
set "ROOT="
for /f "tokens=2,*" %%a in ('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\JARVIS" /v InstallLocation 2^>nul') do if "%%a"=="REG_SZ" set "ROOT=%%b"
if not defined ROOT if exist "C:\\JARVIS\\launcher\\server.js" set "ROOT=C:\\JARVIS"
if not defined ROOT goto notfound
if not exist "%ROOT%\\runtime\\node\\node.exe" goto notfound
"%ROOT%\\runtime\\node\\node.exe" -e "const s=require('fs').readFileSync(process.argv[1],'utf8');eval(s.split(/\\r?\\n\\/\\*JS\\*\\/\\r?\\n/)[1])" "%~f0" "%ROOT%"
echo.
pause
exit /b
:notfound
echo J.A.R.V.I.S. not found (no "Apps and features" entry, no C:\\JARVIS). / J.A.R.V.I.S. не найден.
pause
exit /b 1
/*JS*/
`;

const js = `// J.A.R.V.I.S. hotfix ${version}: replaces the fixed files and repairs agent settings damaged by the bug.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const root = process.argv[2];
const FILES = ${JSON.stringify(payload)};
const say = (ru, en) => console.log(ru + '\\n  ' + en);
say('J.A.R.V.I.S. найден: ' + root, 'J.A.R.V.I.S. found: ' + root);

// A running launcher would keep the old code in memory: stop the one started from this folder.
try {
  const ps = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // -EncodedCommand: no quoting games between Node and PowerShell.
  const script = "$ProgressPreference = 'SilentlyContinue'; Get-CimInstance Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { $_.CommandLine -like '*" +
    root.replace(/'/g, "''") + "\\\\launcher\\\\server.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }";
  const out = cp.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (out) say('Лаунчер остановлен на время исправления.', 'The launcher was stopped for the fix.');
} catch (e) {}

for (const f of FILES) {
  const target = path.join(root, f.rel);
  if (!fs.existsSync(path.dirname(target))) { say('Пропущено (нет папки): ' + f.rel, 'Skipped (no folder): ' + f.rel); continue; }
  if (fs.existsSync(target) && !fs.existsSync(target + '.bak')) fs.copyFileSync(target, target + '.bak');
  fs.writeFileSync(target, Buffer.from(f.b64, 'base64'));
  say('Обновлён: ' + f.rel, 'Updated: ' + f.rel);
}

// Repair now: the fixed language module merges duplicate sections and rewrites broken mode files.
let lang = 'en';
try { lang = JSON.parse(fs.readFileSync(path.join(root, 'data', 'launcher', 'settings.json'), 'utf8')).lang === 'ru' ? 'ru' : 'en'; } catch (e) {}
try {
  const { applyAgentLang } = require(path.join(root, 'launcher', 'lib', 'agentlang.js'));
  require(path.join(root, 'launcher', 'lib', 'i18n.js')).init(root);
  const notes = [];
  applyAgentLang(root, lang, notes);
  for (const n of notes) console.log('  • ' + n);
} catch (e) { say('Не удалось проверить настройки агента: ' + e.message, 'Could not check the agent settings: ' + e.message); }

try {
  const ij = path.join(root, 'install.json');
  fs.writeFileSync(ij, fs.readFileSync(ij, 'utf8').replace(/"version":\\s*"[^"]*"/, '"version": "${version}"'));
} catch (e) {}
say('Готово. Откройте J.A.R.V.I.S. ярлыком на рабочем столе.', 'Done. Open J.A.R.V.I.S. from the desktop shortcut.');
`;

const out = path.join(src, 'installer', 'dist', `JARVIS-hotfix-${version}.cmd`);
fs.writeFileSync(out, (head + js).replace(/\r?\n/g, '\r\n'));
console.log(out, fs.statSync(out).size, 'bytes');
