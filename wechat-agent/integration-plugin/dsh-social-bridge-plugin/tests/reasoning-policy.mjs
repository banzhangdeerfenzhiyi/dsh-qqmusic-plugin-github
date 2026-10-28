#!/usr/bin/env node
/**
 * 推理档位策略测试（设计文档 S8）。
 *
 * 用法：node packages/dsh-social-bridge-plugin/tests/reasoning-policy.mjs
 */
import assert from 'node:assert';
import { pickLowestEffort, SOCIAL_MAX_OUTPUT_TOKENS } from '../reasoning-policy.mjs';

// 1) 有 off/low 档时优先选它们，而不是 high
assert.equal(pickLowestEffort([{ id: 'high' }, { id: 'medium' }, { id: 'low' }, { id: 'off' }]), 'off');
assert.equal(pickLowestEffort([{ id: 'high' }, { id: 'low' }]), 'low');
assert.equal(pickLowestEffort([{ id: 'high' }, { id: 'minimal' }]), 'minimal');

// 2) 只有高阶档时退化为目录里的第一个（而不是死等一个不存在的 id）
assert.equal(pickLowestEffort([{ id: 'high' }, { id: 'max' }]), 'high');

// 3) 目录缺失或格式异常时返回 null，调用方保持原档位（安全降级）
assert.equal(pickLowestEffort([]), null);
assert.equal(pickLowestEffort(undefined), null);
assert.equal(pickLowestEffort([{ name: '没有 id' }, null, 'high']), null);

// 4) 输出上限是一个合理的正整数
assert.ok(Number.isSafeInteger(SOCIAL_MAX_OUTPUT_TOKENS) && SOCIAL_MAX_OUTPUT_TOKENS > 0 && SOCIAL_MAX_OUTPUT_TOKENS <= 8192);

console.log('reasoning-policy: OK');
console.log(`  最低档选择、退化、降级均正确；社交输出上限 ${SOCIAL_MAX_OUTPUT_TOKENS}`);
