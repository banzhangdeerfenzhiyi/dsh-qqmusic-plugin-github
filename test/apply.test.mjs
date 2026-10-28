/**
 * Load the plugin the way Cordis would, with a fake host context, and assert the
 * tool registry / hooks are wired. This catches registration-time errors without
 * restarting DSH.
 *
 *   node test/apply.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, name } from '../index.mjs';

const registered = [];
const hooks = new Map();
const effects = [];
const systems = [];

const ctx = {
  get: (service) => (service === 'tools' ? tools : undefined),
  on: (event, handler) => {
    hooks.set(event, [...(hooks.get(event) ?? []), handler]);
  },
  effect: (fn) => {
    effects.push(fn());
  },
};

const tools = {
  register: (definition) => {
    registered.push(definition);
    return () => {
      const index = registered.findIndex((item) => item.name === definition.name);
      if (index >= 0) registered.splice(index, 1);
    };
  },
};

assert.equal(name, 'dsh-qqmusic');
// No personal paths in the test: point the cache at a temp dir and let the
// plugin fall back to "not configured" for RVC / WeChat workspace (it must still
// register its tools and hooks — that is what this test is about).
apply(ctx, { workDir: mkdtempSync(join(tmpdir(), 'qqmusic-apply-')) });

assert.equal(effects.length, 1, 'one effect registered');
assert.ok(registered.some((tool) => tool.name === 'sing_song'), 'sing_song registered');
assert.ok(registered.some((tool) => tool.name === 'qq_music_search'), 'qq_music_search registered');
assert.ok(hooks.has('agent/pre-step'), 'pre-step hook attached');
assert.ok(hooks.has('system-prompt/assemble'), 'assemble hook attached');

const sing = registered.find((tool) => tool.name === 'sing_song');
assert.equal(sing.parameters.required[0], 'keyword');
assert.equal(typeof sing.execute, 'function');
assert.equal(typeof sing.output.render, 'function');

// The assemble hook must attach the policy for a WeChatAgent persona session and
// append the singing rules section; other sessions must stay untouched.
const scope = {};
const assembly = { sections: [], tools: registered.map((tool) => ({ name: tool.name })) };
const assemble = hooks.get('system-prompt/assemble')[0];
const assembled = await assemble({}, { agent: { session: { id: 'social-abc' }, ctx: scope } }, async () => assembly);
assert.ok(
  assembled.sections.some((section) => section.name === 'dsh-qqmusic:rules'),
  'singing rules appended for social session',
);
const policy = scope[Symbol.for('wechatagent.extension-tools.v1')];
assert.ok(policy, 'extension policy attached to scope');
assert.ok(policy.names().includes('sing_song'), 'policy exposes sing_song');
assert.ok(policy.check('qq_music_search'), 'policy allows qq_music_search');
assert.equal(policy.definitions().length, 2);

// A foreign session must not get the prompt section.
const otherAssembly = { sections: [], tools: [] };
const other = await assemble({}, { agent: { session: { id: 'session-not-wechat' } } }, async () => otherAssembly);
assert.equal(other.sections.length, 0, 'no rules for non-wechat session');

console.log('ok   apply() registers tools, hooks and policy');
