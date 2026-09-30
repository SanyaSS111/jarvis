// J.A.R.V.I.S.: agent presets for ACP sessions (the Telegram bot's agent profile).
// The web app joins every session to a preset ("full" / "lite") in its agent-factory setup; the ACP
// bridge doesn't, so its agents would get only the bare base tool set. This plugin wraps
// ctx.agents.create/resume for root sessions and mounts the preset there, exactly like dsh-webhook does.
// The preset for the next new session is read from `presetFile` (written by tools\telegram\bot.js).
import fs from 'node:fs';

export const name = 'jarvis-acp-presets';
export const inject = ['agents', 'agentPresets'];

function readPreset(file, fallback) {
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    return /^[\w.-]{1,64}$/.test(id) ? id : fallback;
  } catch { return fallback; }
}

// ACP's own calls carry meta = { cwd } only; subagent/child creations carry more and join their parent.
const isAcpRoot = (opts) => !!opts && !!opts.meta && Object.keys(opts.meta).length === 1 && typeof opts.meta.cwd === 'string';

export function apply(ctx, config = {}) {
  const agents = ctx.agents;
  const presets = ctx.agentPresets;
  const fallback = config.default || 'full';
  const origCreate = agents.create;
  const origResume = agents.resume;

  agents.create = function (opts) {
    if (!isAcpRoot(opts)) return origCreate.call(this, opts);
    const id = readPreset(config.presetFile, fallback);
    const setup = opts.setup;
    return origCreate.call(this, {
      ...opts,
      meta: { ...opts.meta, agentPreset: id },
      setup: async (agentCtx, ...rest) => {
        await presets.mount(agentCtx, id);
        if (setup) await setup(agentCtx, ...rest);
      },
    });
  };

  agents.resume = function (opts) {
    if (!opts || !opts.resumeSessionId || !opts.setup) return origResume.call(this, opts);
    const setup = opts.setup;
    return origResume.call(this, {
      ...opts,
      setup: async (agentCtx, agent, ...rest) => {
        const header = (agent && agent.session && agent.session.header) || {};
        if (header.origin !== 'subagent' && header.parentSession === undefined) {
          let id;
          try { id = ctx.sessionProjections.stateOf(agent.session, 'agentPreset'); } catch {}
          await presets.mount(agentCtx, id || header.agentPreset || fallback);
        }
        if (setup) await setup(agentCtx, agent, ...rest);
      },
    });
  };

  ctx.on('dispose', () => {
    agents.create = origCreate;
    agents.resume = origResume;
  });
}
