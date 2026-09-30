// Keeps DeepSeek Harness in sync with the installed local models: rewrites the
// generated block of the home patch layer (one provider per model, all on the local
// llama-server port) and repairs the default model if it pointed at a removed one.
'use strict';
const fs = require('fs');

const BEGIN = '# >>> J.A.R.V.I.S. launcher: local models (generated from models\\registry.json, do not edit by hand)';
const END = '# <<< J.A.R.V.I.S. launcher';
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Qwen models understand the "enable_thinking" switch of their chat template.
const isQwen = (m) => /qwen/i.test(m.arch || '') || /qwen/i.test(m.repo);

function providerId(m) { return 'local-' + m.id; }

function block(models, port) {
  if (!models.length) return `${BEGIN}\n# (no local models installed)\n${END}`;
  const lines = [BEGIN, '- id: llm-pi-ai', "  name: '@deepseek-ai/dsh-llm-pi-ai'", '  config:', '    providers:'];
  for (const m of models) {
    const ctx = m.ctx || 16384;
    lines.push(
      `      ${providerId(m)}:`,
      `        displayName: ${q('Локально · ' + m.title)}`,
      '        apiKeyEnv: LOCAL_LLAMA_API_KEY',
      '        api: openai-completions',
      `        baseURL: http://127.0.0.1:${port}/v1`,
      '        compat:',
      '          supportsStore: false',
      '          supportsDeveloperRole: false',
      '          supportsReasoningEffort: false',
      ...(isQwen(m) ? ['          thinkingFormat: qwen-chat-template'] : []),
      '          maxTokensField: max_tokens',
      '        timeoutMs: 600000',
      '        models:',
      `          - id: ${m.id}`,
      `            name: ${q(`${m.title} · ${m.quant} · ${Math.round(ctx / 1024)}K`)}`,
      `            contextWindow: ${ctx}`,
      `            maxTokens: ${Math.min(8192, Math.floor(ctx / 4))}`,
      '            input:',
      '              - text',
      ...(m.vision ? ['              - image'] : []),
    );
  }
  lines.push(END);
  return lines.join('\n');
}

function syncPatch(patchFile, models, port) {
  let text = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  const next = block(models, port);
  const start = text.indexOf('# >>> J.A.R.V.I.S. launcher');
  const end = text.indexOf(END);
  if (start >= 0 && end > start) text = text.slice(0, start) + next + text.slice(end + END.length);
  else text = text.replace(/\s*$/, '\n\n') + next + '\n';
  const old = fs.existsSync(patchFile) ? fs.readFileSync(patchFile, 'utf8') : '';
  if (old !== text) { fs.writeFileSync(patchFile, text); return true; }
  return false;
}

// settings.yaml: if the default model is a local one that no longer exists, fall back to DeepSeek Flash.
function repairDefault(settingsFile, models) {
  if (!fs.existsSync(settingsFile)) return false;
  const text = fs.readFileSync(settingsFile, 'utf8');
  const m = text.match(/agent-default-model:\r?\n\s+provider:\s*(\S+)\r?\n\s+model:\s*(\S+)[^\n]*(\r?\n\s+reasoningEffort:[^\n]*)?/);
  if (!m || !m[1].startsWith('local-')) return false;
  if (models.some((x) => providerId(x) === m[1] && x.id === m[2])) return false;
  const fixed = text.replace(m[0], 'agent-default-model:\n  provider: deepseek-official\n  model: deepseek-v4-flash\n  reasoningEffort: high');
  fs.writeFileSync(settingsFile, fixed);
  return true;
}

module.exports = { syncPatch, repairDefault, providerId };
