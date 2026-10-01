// Puts the agent (agent\home) into the launcher's language: dsh UI locale and the Russian UI plugin,
// the reply-language rule in the system prompt and AGENTS.md, and the preset names. Idempotent:
// runs at every launcher start and on every language switch; returns the files it changed.
'use strict';
const fs = require('fs');
const path = require('path');

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

function edit(file, fn, changed) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  const bom = text.charCodeAt(0) === 0xfeff;
  const body = bom ? text.slice(1) : text;
  const next = fn(body);
  if (next != null && next !== body) { fs.writeFileSync(file, (bom ? '﻿' : '') + next); changed.push(path.basename(file)); }
}

// Sets `key:\n  field: value` in a flat two-level YAML file, adding the block when it is missing.
function yamlSet(text, key, field, value) {
  const re = new RegExp(`^${key}:\\r?\\n((?:[ \\t]+.*\\r?\\n?)*)`, 'm');
  const m = text.match(re);
  if (!m) return text.replace(/\s*$/, '\n') + `${key}:\n  ${field}: ${value}\n`;
  const block = m[1];
  const line = new RegExp(`^([ \\t]+${field}:).*$`, 'm');
  const nb = line.test(block) ? block.replace(line, `$1 ${value}`) : `  ${field}: ${value}\n` + block;
  return text.replace(m[0], `${key}:\n` + nb);
}

function applyAgentLang(root, lang) {
  const home = path.join(root, 'agent', 'home');
  const changed = [];
  edit(path.join(home, 'settings.yaml'), (t) => {
    t = yamlSet(t, 'locale', 'preference', lang);
    return yamlSet(t, 'russian-lang', 'enabled', lang === 'ru' ? 'true' : 'false');
  }, changed);
  edit(path.join(home, 'cordis.patch.yml'), (t) => t
    .replace(/LANGUAGE RULE:[\s\S]*?(?=\n\s*Code, commands)/, PROMPT_RULE[lang])
    .replace(/^# Agent replies in \w+\./m, `# Agent replies in ${lang === 'ru' ? 'Russian' : 'English'}.`), changed);
  edit(path.join(home, 'AGENTS.md'), (t) => t.replace(/^## (?:Язык|Language)\r?\n[\s\S]*?(?=^## )/m, AGENTS_LANG[lang] + '\n'), changed);
  for (const [id, names] of Object.entries(PRESETS)) {
    const [name, desc] = names[lang];
    edit(path.join(home, '.agent-presets', id, 'preset.yml'), (t) => t
      .replace(/^name: .*$/m, `name: ${name}`)
      .replace(/^description: .*$/m, `description: ${desc}`), changed);
  }
  return changed;
}

module.exports = { applyAgentLang };
