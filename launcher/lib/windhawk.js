// Jarvis look for Windows shell: a portable copy of Windhawk (open source, GPL-3.0,
// github.com/ramensoftware/windhawk) inside C:\LLM\tools\windhawk plus the "Windows 11 … Styler"
// mods, each with its theme from C:\LLM\docs\*-jarvis.yaml.
// Does what the Windhawk UI does when installing a mod (see vscode-windhawk/src/utils/compilerUtils.ts
// and modConfigUtils.ts in v1.7.3): compile the mod with the bundled clang, copy the runtime libs,
// write AppData\Engine\Mods\<id>.ini (UTF-16LE). The running Windhawk picks changes up by itself.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const WH_VERSION = '1.7.3';
const SETUP_URL = `https://github.com/ramensoftware/windhawk/releases/download/v${WH_VERSION}/windhawk_setup_offline.exe`;
const MODS_URL = 'https://raw.githubusercontent.com/ramensoftware/windhawk-mods/main/mods/';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'Windhawk (J.A.R.V.I.S.)';
const TARGET = 'x86_64-w64-mingw32';

// Parts of Windows the launcher can restyle: mod id + theme file in docs\.
const MODS = {
  taskbar: { id: 'windows-11-taskbar-styler', theme: 'taskbar-jarvis.yaml', label: 'Панель задач' },
  start: { id: 'windows-11-start-menu-styler', theme: 'start-jarvis.yaml', label: 'Меню «Пуск»' },
  notifications: { id: 'windows-11-notification-center-styler', theme: 'notifications-jarvis.yaml', label: 'Центр уведомлений' },
  explorer: { id: 'windows-11-file-explorer-styler', theme: 'explorer-jarvis.yaml', label: 'Проводник' },
  // Our own mod (launcher\mods): navy title bars, cyan border, light caption text for every window.
  windows: { id: 'jarvis-window-colors', local: true, label: 'Окна (заголовки и рамки)',
    settings: { darkMode: 1, activeCaption: '#0A1B25', inactiveCaption: '#06111A', activeBorder: '#5CE1FF',
      inactiveBorder: '#1E4A58', activeText: '#CFF6FF', inactiveText: '#7C9DB0' } },
  settings: { id: 'windows-11-settings-styler', theme: 'settings-jarvis.yaml', label: 'Параметры Windows' },
  alttab: { id: 'simple-window-switcher', label: 'Alt+Tab',
    settings: {
      'Style.theme': 'backdrop', 'Style.colorScheme': 'dark', 'Style.highlightStyle': 'fillAndBorder', 'Style.opacity': 92,
      'Style.DarkMode.borderColorMode': 'custom', 'Style.DarkMode.customBorderColor': '#5CE1FF',
      'Style.DarkMode.highlightFillColorMode': 'custom', 'Style.DarkMode.customHighlightFillColor': '#1A4A5C',
      'Style.DarkMode.bgColorMode': 'custom', 'Style.DarkMode.customBgColor': '#061118',
      'Style.DarkMode.iconBgColorMode': 'custom', 'Style.DarkMode.customIconBgColor': '#0A1B25',
      'Style.DarkMode.indicatorBgColorMode': 'custom', 'Style.DarkMode.customIndicatorBgColor': '#0A1B25',
      'Style.DarkMode.indicatorTextColorMode': 'custom', 'Style.DarkMode.customIndicatorTextColor': '#5CE1FF',
      'Appearance.Font.fontFamily': 'Bahnschrift', 'Appearance.Font.fontSize': 10,
    } },
};
// Mod defaults (from its source) + our theme or values on top.
const modSettings = (mod, src, themeText) => ({ ...modDefaults(src), ...(mod.theme ? themeSettings(themeText) : mod.settings) });

// ---------------------------------------------------------------- tiny INI helpers (UTF-16LE + BOM, like Windhawk)
function readIni(file) {
  const buf = fs.readFileSync(file);
  const text = buf[0] === 0xFF && buf[1] === 0xFE ? buf.slice(2).toString('utf16le') : buf.toString('utf8').replace(/^\uFEFF/, '');
  const out = {};
  let sec = null;
  for (const line of text.split(/\r?\n/)) {
    const s = line.match(/^\s*\[(.+)\]\s*$/);
    if (s) { sec = out[s[1]] = out[s[1]] || {}; continue; }
    const kv = line.match(/^([^=;]+?)=(.*)$/);
    if (kv && sec) sec[kv[1].trim()] = kv[2];
  }
  return out;
}
function writeIni(file, data) {
  const text = Object.entries(data).map(([sec, kv]) =>
    `[${sec}]\r\n` + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\r\n')).join('\r\n\r\n') + '\r\n';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(text, 'utf16le')]));
}

// A theme YAML (controlStyles: - target / styles) -> flat mod settings.
function themeSettings(yamlText) {
  const settings = { theme: '' };
  let i = -1, j = 0;
  for (const raw of yamlText.split(/\r?\n/)) {
    const t = raw.match(/^\s*-\s*target:\s*(.+?)\s*$/);
    if (t) { i += 1; j = 0; settings[`controlStyles[${i}].target`] = t[1]; continue; }
    const st = raw.match(/^\s{6,}-\s*(.+?)\s*$/);
    if (st && i >= 0) settings[`controlStyles[${i}].styles[${j++}]`] = st[1];
  }
  return settings;
}

// Default settings from the mod's ==WindhawkModSettings== YAML block, flattened the way the
// engine reads them ("Style.DarkMode.customBgColor"). The Windhawk UI writes these on install;
// without them Wh_Get*Setting would return 0/"" for every key we don't override.
function modDefaults(src) {
  const block = (src.match(/==WindhawkModSettings==\s*\/\*([\s\S]*?)\*\/\s*\/\/ ==\/WindhawkModSettings==/) || [])[1] || '';
  const out = {};
  const stack = []; // {indent, prefix}
  let skipIndent = -1;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const indent = line.match(/^\s*/)[0].length;
    // $options items sit at the same indent as "$options:", so skip until the indent drops below it.
    if (skipIndent >= 0) { if (indent >= skipIndent) continue; skipIndent = -1; }
    const meta = line.match(/^\s*(?:- )?\$\w+:/);
    if (meta) { if (/\$options:\s*$/.test(line)) skipIndent = indent; continue; }
    if (/^\s*- - /.test(line)) { skipIndent = indent; continue; }        // arrays of objects: left empty
    const m = line.match(/^(\s*)- ([\w.]+):\s*(.*?)\s*$/);
    if (!m) continue;
    const keyIndent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= keyIndent) stack.pop();
    const prefix = stack.length ? stack[stack.length - 1].prefix + '.' : '';
    let v = m[3];
    if (v === '') { stack.push({ indent: keyIndent, prefix: prefix + m[2] }); continue; }
    if (v.startsWith('[')) continue;                                      // inline arrays: left empty
    if (/^(true|TRUE)$/.test(v)) v = 1;
    else if (/^(false|FALSE)$/.test(v)) v = 0;
    else v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    out[prefix + m[2]] = v;
  }
  return out;
}

function modHeader(src) {
  const block = (src.match(/\/\/ ==WindhawkMod==([\s\S]*?)\/\/ ==\/WindhawkMod==/) || [])[1] || '';
  const h = { include: [], exclude: [], architecture: [] };
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^\/\/\s*@(\S+)\s+(.*?)\s*$/);
    if (!m) continue;
    if (['include', 'exclude', 'architecture'].includes(m[1])) h[m[1]].push(m[2]);
    else h[m[1]] = m[2];
  }
  return h;
}

const now32 = () => (Date.now() / 1000) & 0x7fffffff;

function createWindhawk({ root, run, journal }) {
  const dir = path.join(root, 'tools', 'windhawk');
  const exe = path.join(dir, 'windhawk.exe');
  const state = { step: null, error: null };

  function storage() {
    const cfg = readIni(path.join(dir, 'windhawk.ini')).Storage || {};
    const abs = (p) => path.resolve(dir, (p || '').replace(/%([^%]+)%/g, (_, v) => process.env[v] || _));
    return { appData: abs(cfg.AppDataPath), engine: abs(cfg.EnginePath), compiler: abs(cfg.CompilerPath) };
  }
  const modIni = (mod) => path.join(storage().appData, 'Engine', 'Mods', `${mod.id}.ini`);
  const themeFile = (mod) => path.join(root, 'docs', mod.theme);
  const engineInstalled = () => fs.existsSync(exe) && fs.existsSync(path.join(dir, 'windhawk.ini'));

  async function running() {
    const { stdout } = await run('tasklist.exe', ['/FI', 'IMAGENAME eq windhawk.exe', '/FO', 'CSV', '/NH'], { encoding: 'latin1' });
    return /windhawk\.exe/i.test(stdout);
  }

  function modStatus(mod) {
    try {
      const m = readIni(modIni(mod)).Mod || {};
      const dll = m.LibraryFileName && path.join(storage().appData, 'Engine', 'Mods', '64', m.LibraryFileName);
      const installed = !!(dll && fs.existsSync(dll));
      return { label: mod.label, installed, enabled: installed && m.Disabled !== '1', version: m.Version || null };
    } catch { return { label: mod.label, installed: false, enabled: false, version: null }; }
  }

  async function status() {
    const installed = engineInstalled();
    const mods = {};
    for (const [key, mod] of Object.entries(MODS)) mods[key] = installed ? modStatus(mod) : { label: mod.label, installed: false, enabled: false };
    let autorun = false;
    if (installed) autorun = (await run('reg.exe', ['query', RUN_KEY, '/v', RUN_VALUE])).stdout.includes('windhawk.exe');
    return { installed, running: installed && (await running()), autorun, mods, step: state.step, error: state.error };
  }

  async function download(url, file) {
    const curl = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'curl.exe');
    const r = await run(curl, ['-L', '--fail', '-s', '-S', '--retry', '3', '-o', file, url], { timeout: 900000 });
    if (r.err || !fs.existsSync(file)) throw new Error(`Не удалось скачать ${url}: ${(r.stderr || (r.err && r.err.message) || '').trim()}`);
  }

  async function installEngine() {
    state.step = `Скачиваю Windhawk ${WH_VERSION} (≈140 МБ)…`;
    const setup = path.join(root, 'data', 'launcher', 'windhawk_setup_offline.exe');
    fs.mkdirSync(path.dirname(setup), { recursive: true });
    await download(SETUP_URL, setup);
    state.step = 'Устанавливаю Windhawk в C:\\LLM\\tools\\windhawk (портативно)…';
    // NSIS: /S silent, /PORTABLE, /D must be the last argument and unquoted.
    await new Promise((resolve) => {
      const p = cp.spawn(setup, ['/S', '/PORTABLE', `/D=${dir}`], { windowsHide: true, stdio: 'ignore' });
      p.on('exit', resolve); p.on('error', resolve);
    });
    try { fs.unlinkSync(setup); } catch {}
    if (!fs.existsSync(exe)) throw new Error('Установщик Windhawk не создал windhawk.exe');
  }

  async function installMod(mod) {
    const st = storage();
    const srcFile = path.join(st.appData, 'ModsSource', `${mod.id}.wh.cpp`);
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    if (mod.local) fs.copyFileSync(path.join(__dirname, '..', 'mods', `${mod.id}.wh.cpp`), srcFile);
    else { state.step = `${mod.label}: скачиваю мод…`; await download(MODS_URL + mod.id + '.wh.cpp', srcFile); }
    const src = fs.readFileSync(srcFile, 'utf8');
    const h = modHeader(src);
    if (h.id !== mod.id || !h.version) throw new Error(`${mod.label}: не удалось прочитать заголовок мода`);

    state.step = `${mod.label}: компилирую мод ${h.version} (1–3 минуты)…`;
    const modsDir = path.join(st.appData, 'Engine', 'Mods', '64');
    fs.mkdirSync(modsDir, { recursive: true });
    const dllName = `${mod.id}_${h.version}_${100000 + Math.floor(Math.random() * 900000)}.dll`;
    const args = ['-std=c++23', '-O2', '-shared', '-DUNICODE', '-D_UNICODE',
      '-DWINVER=0x0A00', '-D_WIN32_WINNT=0x0A00', '-D_WIN32_IE=0x0A00', '-DNTDDI_VERSION=0x0A000008',
      '-D__USE_MINGW_ANSI_STDIO=0', '-DWH_MOD', `-DWH_MOD_ID=L"${mod.id}"`, `-DWH_MOD_VERSION=L"${h.version}"`,
      path.join(st.engine, '64', 'windhawk.lib'), '-x', 'c++', '-', '-include', 'windhawk_api.h',
      '-target', TARGET, '-Wl,--export-all-symbols', '-o', path.join(modsDir, dllName),
      ...(h.compilerOptions ? h.compilerOptions.split(/\s+/).filter(Boolean) : [])];
    const result = await new Promise((resolve) => {
      const p = cp.spawn(path.join(st.compiler, 'bin', 'clang++.exe'), args, { cwd: st.compiler, windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('exit', (code) => resolve({ code, err }));
      p.on('error', (e) => resolve({ code: -1, err: e.message }));
      p.stdin.end(src);
    });
    if (result.code !== 0) throw new Error(`${mod.label}: мод не скомпилировался:\n` + result.err.split(/\r?\n/).slice(-8).join('\n'));

    // Runtime libraries the compiled mods link against.
    const libs = path.join(st.compiler, TARGET, 'bin');
    for (const [from, to] of [['libc++.dll', 'libc++.whl'], ['libunwind.dll', 'libunwind.whl'], ['windhawk-mod-shim.dll', 'windhawk-mod-shim.dll']]) {
      const s = path.join(libs, from), d = path.join(modsDir, to);
      if (fs.existsSync(s) && !fs.existsSync(d)) { try { fs.copyFileSync(s, d); } catch {} }
    }

    state.step = `${mod.label}: применяю тему Джарвиса…`;
    let old = {};
    try { old = readIni(modIni(mod)); } catch {}
    const previousDll = old.Mod && old.Mod.LibraryFileName;
    writeIni(modIni(mod), {
      Mod: {
        LibraryFileName: dllName, Disabled: 0, LoggingEnabled: 0, DebugLoggingEnabled: 0,
        Include: h.include.join('|'), Exclude: h.exclude.join('|'), IncludeCustom: '', ExcludeCustom: '',
        IncludeExcludeCustomOnly: 0, Architecture: h.architecture.join('|'), Version: h.version, SettingsChangeTime: now32(),
      },
      Settings: modSettings(mod, src, mod.theme ? fs.readFileSync(themeFile(mod), 'utf8') : ''),
    });
    if (previousDll && previousDll !== dllName) { try { fs.unlinkSync(path.join(modsDir, previousDll)); } catch {} }
  }

  function start() { cp.spawn(exe, ['-tray-only'], { cwd: dir, detached: true, stdio: 'ignore' }).unref(); }

  // Install (engine if needed) + the given parts; keys = ['taskbar', ...] or all.
  async function install(keys) {
    if (state.step) return;
    state.error = null;
    try {
      if (!fs.existsSync(exe)) await installEngine();
      // No keys = first setup: mods that came ready (compiled, themed) with the installer are kept as is.
      const list = keys && keys.length ? keys.filter((k) => MODS[k]) : Object.keys(MODS).filter((k) => !modStatus(MODS[k]).installed);
      for (const key of list) {
        await installMod(MODS[key]);
        journal(`${MODS[key].label}: тема Джарвиса установлена`, 'ok');
      }
      if (!(await running())) { state.step = 'Запускаю Windhawk…'; start(); }
    } catch (e) {
      state.error = String(e.message || e);
      journal('Оформление Windows: ' + state.error, 'error');
    } finally { state.step = null; }
  }

  // On/off: the running engine sees the Disabled flag and restores the stock look.
  async function setEnabled(key, on) {
    const mod = MODS[key];
    if (!mod) throw new Error('Неизвестная часть Windows');
    const data = readIni(modIni(mod));
    if (!data.Mod) throw new Error(`${mod.label}: мод не установлен`);
    data.Mod.Disabled = on ? 0 : 1;
    data.Mod.SettingsChangeTime = now32();
    writeIni(modIni(mod), data);
    if (on && !(await running())) start();
    journal(`${mod.label}: ${on ? 'тема Джарвиса включена' : 'стандартный вид'}`);
  }

  // Re-read docs\*-jarvis.yaml into the mod settings (after editing a theme).
  function reloadTheme(key) {
    for (const k of key ? [key] : Object.keys(MODS)) {
      const mod = MODS[k];
      let data;
      try { data = readIni(modIni(mod)); } catch { continue; }
      if (!data.Mod) continue;
      let src = '';
      try { src = fs.readFileSync(path.join(storage().appData, 'ModsSource', `${mod.id}.wh.cpp`), 'utf8'); } catch {}
      data.Settings = modSettings(mod, src, mod.theme ? fs.readFileSync(themeFile(mod), 'utf8') : '');
      data.Mod.SettingsChangeTime = now32();
      writeIni(modIni(mod), data);
    }
    journal('Оформление Windows: темы перечитаны');
  }

  // Called when the launcher opens: bring the themes back if Windhawk isn't running.
  async function ensureRunning() {
    const s = await status();
    if (s.installed && !s.running && Object.values(s.mods).some((m) => m.enabled)) { start(); journal('Windhawk запущен — оформление Windows активно'); }
  }

  async function setAutostart(on) {
    if (on) await run('reg.exe', ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', `"${exe}" -tray-only`, '/f']);
    else await run('reg.exe', ['delete', RUN_KEY, '/v', RUN_VALUE, '/f']);
    journal(on ? 'Windhawk будет запускаться вместе с Windows' : 'Автозапуск Windhawk выключен');
  }

  return { status, install, setEnabled, setAutostart, ensureRunning, reloadTheme,
    openUi: () => cp.spawn(exe, [], { cwd: dir, detached: true, stdio: 'ignore' }).unref() };
}

module.exports = { createWindhawk, themeSettings, modHeader, modDefaults, readIni, MODS };
