// Puts the agent (agent\home) into the launcher's language: dsh UI locale and the Russian UI plugin,
// the reply-language rule in the system prompt and AGENTS.md, and the preset names. Idempotent:
// runs at every launcher start and on every language switch; returns the files it changed.
//
// YAML files are edited through the same parser dsh uses (its own copy of the `yaml` package), so a
// section dsh wrote as a one-liner (`locale: {}`) is understood instead of being added a second time,
// and nothing is written that dsh could not read back. A settings.yaml already broken by duplicate
// sections (launcher 1.1–1.2 did that) is merged back into one document; the broken copy is kept.
'use strict';
const fs = require('fs');
const path = require('path');
const { T } = require('./i18n');

const PROMPT_RULE = {
  ru: 'LANGUAGE RULE: write every reply to the user in Russian, even when the\n      user writes in English, Chinese or any other language. Switch to another\n      language only if the user explicitly asks you to reply in that language.',
  en: 'LANGUAGE RULE: write every reply to the user in English unless the user\n      writes in another language or explicitly asks you to reply in another\n      language.',
};

const AGENTS_LANG = {
  ru: `## Язык
- Всегда отвечай пользователю на русском языке, даже если вопрос задан на другом языке. Переходи на другой язык только по явной просьбе.
- Код, команды, пути, имена файлов и идентификаторы оставляй как есть.
`,
  en: `## Language
- Reply to the user in English unless they write in another language or explicitly ask for one. These instructions are partly written in Russian: follow them, but answer in English.
- Voice messages are marked \`[Voice]\` (the same as \`[Голос]\` below); in voice mode address the user as "sir".
- Keep code, commands, paths, file names and identifiers as they are.
`,
};

const PRESETS = {
  full: {
    ru: ['Полный режим', 'Всё из обычного режима плюс MCP-серверы — Windows (управление ПК), Playwright (браузер), Context7 (документация), Wolfram (вычисления), draw.io (схемы), Blender. Для DeepSeek-V4-Pro/Flash; для локальной Qwen выбирайте «Лёгкий режим».'],
    en: ['Full mode', 'Everything from the standard mode plus MCP servers: Windows (PC control), Playwright (browser), Context7 (docs), Wolfram (math), draw.io (diagrams), Blender. For DeepSeek-V4-Pro/Flash; pick "Lite mode" for local models.'],
  },
  lite: {
    ru: ['Лёгкий режим', 'Облегчённый агент для локальной модели (Qwen через llama.cpp) — файлы, PowerShell, поиск, веб и todo, без субагентов, воркфлоу и режима плана. Короткий системный промпт — быстрый первый ответ.'],
    en: ['Lite mode', 'A lighter agent for local models (llama.cpp): files, PowerShell, search, web and todo, without subagents, workflows or plan mode. A short system prompt for a fast first reply.'],
  },
};

// dsh's own YAML package (shipped with the agent runtime); null when the agent is not installed.
function loadYaml(root) {
  try { return require(path.join(root, 'runtime', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', 'yaml')); } catch { return null; }
}

function readText(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const bom = text.charCodeAt(0) === 0xfeff;
  return { text: bom ? text.slice(1) : text, bom };
}

function edit(file, fn, changed) {
  const r = readText(file);
  if (!r) return;
  const next = fn(r.text);
  if (next != null && next !== r.text) { fs.writeFileSync(file, (r.bom ? '\ufeff' : '') + next); changed.push(path.basename(file)); }
}

const isPlainMap = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Opens a YAML document; one with duplicate top-level keys is merged (later fields win) into a fresh one.
function openYaml(Y, text) {
  const doc = Y.parseDocument(text);
  if (!doc.errors.length) return { doc, repaired: false };
  const loose = Y.parseDocument(text, { uniqueKeys: false });
  if (loose.errors.length || !Y.isMap(loose.contents)) return null; // a real syntax error: leave it to the person
  const merged = {};
  for (const pair of loose.contents.items) {
    const key = Y.isScalar(pair.key) ? String(pair.key.value) : String(pair.key);
    const value = pair.value == null ? null : (typeof pair.value.toJSON === 'function' ? pair.value.toJSON() : pair.value);
    merged[key] = isPlainMap(merged[key]) && isPlainMap(value) ? { ...merged[key], ...value } : value;
  }
  return { doc: new Y.Document(merged), repaired: true };
}

// sets: [[namespace, field, value]]. Writes only when something changes and the result parses cleanly.
function setYaml(Y, file, sets, changed, notes) {
  const r = readText(file);
  if (!r) return;
  const opened = openYaml(Y, r.text);
  if (!opened) { notes.push(T(`${path.basename(file)}: ошибка YAML, файл не изменён`, `${path.basename(file)}: YAML error, file not changed`)); return; }
  const { doc, repaired } = opened;
  let dirty = repaired;
  for (const [ns, field, value] of sets) {
    const node = doc.get(ns, true);
    if (Y.isMap(node)) {
      if (node.get(field) !== value) { node.set(field, value); dirty = true; }
    } else { doc.set(ns, doc.createNode({ [field]: value })); dirty = true; }
  }
  if (!dirty) return;
  const out = doc.toString();
  if (Y.parseDocument(out).errors.length) { notes.push(T(`${path.basename(file)}: изменение дало бы неверный YAML — не записано`, `${path.basename(file)}: the change would produce invalid YAML — not written`)); return; }
  if (repaired) {
    const backup = `${file}.broken-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
    notes.push(T(`Настройки агента были повреждены (повторы разделов) — исправлены, старая копия: ${path.basename(backup)}`, `Agent settings were damaged (repeated sections) — repaired, old copy: ${path.basename(backup)}`));
  }
  fs.writeFileSync(file, (r.bom ? '\ufeff' : '') + out);
  changed.push(path.basename(file));
}

// notes (optional array) collects repairs and refusals for the launcher log.
function applyAgentLang(root, lang, notes = []) {
  const home = path.join(root, 'agent', 'home');
  const changed = [];
  const Y = loadYaml(root);
  if (Y) {
    setYaml(Y, path.join(home, 'settings.yaml'), [['locale', 'preference', lang], ['russian-lang', 'enabled', lang === 'ru']], changed, notes);
    for (const [id, names] of Object.entries(PRESETS)) {
      const [name, description] = names[lang];
      const file = path.join(home, '.agent-presets', id, 'preset.yml');
      const r = readText(file);
      if (!r) continue;
      let opened = openYaml(Y, r.text);
      let rebuilt = false;
      if (!opened) {
        // Launcher 1.1–1.2 wrote the English description unquoted ("…servers: Windows…" is not valid YAML).
        // The file is flat (name, description, order…): keep the other keys, the two texts are ours anyway.
        const rest = {};
        for (const line of r.text.split(/\r?\n/)) {
          const m = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
          if (!m || m[1] === 'name' || m[1] === 'description') continue;
          try { rest[m[1]] = Y.parse(m[2]); } catch { rest[m[1]] = m[2]; }
        }
        opened = { doc: new Y.Document({ name, description, ...rest }) };
        rebuilt = true;
        notes.push(T(`Файл режима ${id}/preset.yml был повреждён — исправлен`, `Mode file ${id}/preset.yml was damaged — repaired`));
      }
      const { doc } = opened;
      if (!rebuilt && doc.get('name') === name && doc.get('description') === description) continue;
      doc.set('name', name); doc.set('description', description); // quoted by the serializer when needed
      const out = doc.toString();
      if (Y.parseDocument(out).errors.length) continue;
      fs.writeFileSync(file, (r.bom ? '\ufeff' : '') + out);
      changed.push(path.basename(file));
    }
  }
  edit(path.join(home, 'cordis.patch.yml'), (t) => t
    .replace(/LANGUAGE RULE:[\s\S]*?(?=\n\s*Code, commands)/, PROMPT_RULE[lang])
    .replace(/^# Agent replies in \w+\./m, `# Agent replies in ${lang === 'ru' ? 'Russian' : 'English'}.`), changed);
  edit(path.join(home, 'AGENTS.md'), (t) => t.replace(/^## (?:Язык|Language)\r?\n[\s\S]*?(?=^## )/m, AGENTS_LANG[lang] + '\n'), changed);
  return changed;
}

module.exports = { applyAgentLang };
