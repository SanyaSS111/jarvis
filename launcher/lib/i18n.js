// Interface language of the whole setup (launcher, agent, Telegram bot, HUD): 'en' (default) or 'ru'.
// Stored in data\launcher\settings.json; the installer writes the first value, the launcher's
// language switch changes it. T(ru, en) picks the string for the current language.
'use strict';
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'ru'];
let cur = 'en';
let file = null;

function readSettings() {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}

function init(root) {
  file = path.join(root, 'data', 'launcher', 'settings.json');
  const s = readSettings();
  cur = LANGS.includes(s.lang) ? s.lang : 'en';
  return cur;
}

function lang() { return cur; }

function T(ru, en) { return cur === 'en' ? en : ru; }

function set(l) {
  if (!LANGS.includes(l)) throw new Error('unknown language: ' + l);
  const s = readSettings();
  s.lang = l;
  // The agent window applies a language once per switch (dsh-jarvis client): it watches this stamp.
  s.langChangedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  cur = l;
}

module.exports = { init, lang, T, set, LANGS };
