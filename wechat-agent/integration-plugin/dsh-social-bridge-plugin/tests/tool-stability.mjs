#!/usr/bin/env node
/**
 * 工具集稳定性测试（设计文档 S9）。
 *
 * 提供方的提示词前缀包含工具声明，所以同一会话里「工具出现/消失」等于从第 0 个
 * token 起重算。这里验证：带链接的轮次与不带链接的轮次，声明的工具名完全一致，
 * 而可用性（check）仍然按轮次收紧。
 *
 * 用法：node packages/dsh-social-bridge-plugin/tests/tool-stability.mjs
 */
import assert from 'node:assert';
import path from 'node:path';
import { bindWebReader } from '../web-reader.mjs';
import { WEB_READER_POLICY, WEB_READER_TOOL } from '../web-reader-policy.mjs';

const root = path.resolve(import.meta.dirname, '../../..');   // D:\dsagent\data\workspace
const key = 'wechat:group:1412964411';

function fakeAgentCtx() {
  return { tools: { register: () => () => {} } };
}

let urls = new Set();
const turnFor = () => ({ urls });

const ctx = fakeAgentCtx();
bindWebReader(ctx, root, key, turnFor);
const policy = ctx[WEB_READER_POLICY];
assert.ok(policy, '网页阅读策略没有挂载');

// 无链接的一轮
urls = new Set();
const withoutLinks = [...policy.names()];
const checkWithout = policy.check(WEB_READER_TOOL);
const definitionsWithout = policy.definitions().map((tool) => tool.name);

// 有链接的一轮
urls = new Set(['https://example.com/a']);
const withLinks = [...policy.names()];
const checkWith = policy.check(WEB_READER_TOOL);
const definitionsWith = policy.definitions().map((tool) => tool.name);

assert.deepEqual(withLinks, withoutLinks, `工具声明随轮次变化：${withoutLinks} -> ${withLinks}`);
assert.deepEqual(definitionsWith, definitionsWithout, '工具 schema 随轮次变化');
assert.equal(checkWithout, false, '无链接时仍允许调用网页阅读');
assert.equal(checkWith, true, '有链接时反而不允许调用网页阅读');
assert.ok(withLinks.includes(WEB_READER_TOOL), '网页阅读工具没有被声明');

// 同一会话里两次取 names() 必须稳定
urls = new Set();
assert.deepEqual([...policy.names()], withoutLinks, 'names() 不稳定');

console.log('tool-stability: OK');
console.log(`  声明工具：${withLinks.join(', ') || '(空)'}（有/无链接相同）`);
console.log(`  可用性：无链接 ${checkWithout} / 有链接 ${checkWith}`);
