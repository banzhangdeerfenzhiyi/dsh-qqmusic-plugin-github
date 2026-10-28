/**
 * Load the plugin the way Cordis would, with a fake host context, and assert the
 * tools/hooks/policy wiring. Catches registration-time errors without a restart.
 *
 *   node test/apply.test.mjs
 */
import assert from 'node:assert/strict';
import { apply, name } from '../index.mjs';

const registered = [];
const hooks = new Map();

const tools = {
  register: (definition) => {
    registered.push(definition);
    return () => {
      const index = registered.findIndex((item) => item.name === definition.name);
      if (index >= 0) registered.splice(index, 1);
    };
  },
};

const ctx = {
  get: (service) => (service === 'tools' ? tools : undefined),
  on: (event, handler) => {
    hooks.set(event, [...(hooks.get(event) ?? []), handler]);
  },
  effect: (fn) => {
    fn();
  },
};

assert.equal(name, 'dsh-voicepack');
apply(ctx, {
  workspace: process.env.WECHATAGENT_WORKSPACE ?? '',
  rvcRoot: process.env.RVC_ROOT ?? '',
});

assert.ok(registered.some((tool) => tool.name === 'voice_pack_list'), 'voice_pack_list registered');
assert.ok(registered.some((tool) => tool.name === 'send_voice_pack'), 'send_voice_pack registered');
assert.ok(hooks.has('agent/pre-step'), 'pre-step hook attached');
assert.ok(hooks.has('system-prompt/assemble'), 'assemble hook attached');

const send = registered.find((tool) => tool.name === 'send_voice_pack');
assert.equal(send.parameters.required[0], 'text');
assert.equal(typeof send.execute, 'function');
assert.equal(typeof send.output.render, 'function');

// Policy attachment + prompt section for a social session.
const scope = {};
const assembly = { sections: [], tools: registered.map((tool) => ({ name: tool.name })) };
const assemble = hooks.get('system-prompt/assemble')[0];
const assembled = await assemble({}, { agent: { session: { id: 'social-abc' }, ctx: scope } }, async () => assembly);
assert.ok(
  assembled.sections.some((section) => section.name === 'dsh-voicepack:rules'),
  'voice pack rules appended for social session',
);
const policy = scope[Symbol.for('wechatagent.extension-tools.v1')];
assert.ok(policy, 'extension policy attached to scope');
assert.ok(policy.names().includes('send_voice_pack'), 'policy exposes send_voice_pack');
assert.ok(policy.check('voice_pack_list'), 'policy allows voice_pack_list');

// A foreign session gets neither the prompt nor the policy.
const otherScope = {};
const otherAssembly = { sections: [], tools: [] };
const other = await assemble(
  {},
  { agent: { session: { id: 'session-not-wechat' }, ctx: otherScope } },
  async () => otherAssembly,
);
assert.equal(other.sections.length, 0, 'no rules for non-wechat session');
assert.equal(otherScope[Symbol.for('wechatagent.extension-tools.v1')], undefined, 'no policy for foreign session');

console.log('ok   apply() registers tools, hooks and policy');

