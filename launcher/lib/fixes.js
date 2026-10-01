// Small idempotent fixes for third-party agent plugins, applied by the launcher at every start (a plugin
// update brings the original file back; the fix is then applied again). Each fix names what it changes.
'use strict';
const fs = require('fs');
const path = require('path');

const FIXES = [
  {
    // @goodandready/dsh-russian-lang: the typographer (quotes, dashes, non-breaking spaces) rewrites text
    // nodes of the whole page but only skips textarea/input — the agent's message box is a contenteditable
    // [data-composer-input], so after a space the caret jumped to the start and typing went backwards.
    name: 'dsh-russian-lang: типограф не трогает поле ввода',
    file: ['agent', 'home', 'profiles', 'web', 'node_modules', '@goodandready', 'dsh-russian-lang', 'lib', 'client.js'],
    from: "closest('code, pre, a, script, style, textarea, input, select, button, kbd, samp')",
    to: "closest('code, pre, a, script, style, textarea, input, select, button, kbd, samp, [contenteditable], [role=\"textbox\"], [data-composer-input]')",
  },
  {
    // Same plugin, "live typography in the input" (#158): on every keystroke it rewrites the WHOLE box via
    // selectAll + insertText, and again 15 ms later. For textarea/input it restores the caret; for the agent's
    // contenteditable box it can't — spaces after "у", "в"… vanished and the rest was typed backwards.
    // Kept for plain fields, skipped for the contenteditable message box.
    name: 'dsh-russian-lang: живая типографика не переписывает поле агента',
    file: ['agent', 'home', 'profiles', 'web', 'node_modules', '@goodandready', 'dsh-russian-lang', 'lib', 'client.js'],
    from: "if (typoLive && value && typeof formatInputLive === 'function') {",
    to: "if (typoLive && value && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') && typeof formatInputLive === 'function') {",
  },
];

// Returns the names of fixes applied now (already-fixed files are left alone).
function applyFixes(root) {
  const applied = [];
  for (const f of FIXES) {
    const file = path.join(root, ...f.file);
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (!text.includes(f.from)) continue;
    fs.writeFileSync(file, text.split(f.from).join(f.to));
    applied.push(f.name);
  }
  return applied;
}

module.exports = { applyFixes };
