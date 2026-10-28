#!/usr/bin/env node
/**
 * 提示词前缀回归测试。
 *
 * 校验的不变量（设计文档 I1）：连续两轮模型请求之间，**未命中的部分必须是一个固定的小尾巴**，
 * 而不是随轮次增长。未命中长度 = 上一轮提示词长度 − 两轮提示词的最长公共前缀长度。
 *
 * - 修复后：未命中 ≈ 上一轮自己的尾部（证据/批次/回复），与轮次无关。
 * - 旧行为：槽位在历史中段被原地改写，未命中部分每轮累积，线性增长。
 *
 * 用法：node packages/dsh-social-bridge-plugin/tests/surface-prefix.mjs
 */
import assert from 'node:assert';
import { syncInstructionSlot, retireTurnContext, retireStaleTurnContext } from '../prompt-context.mjs';

const makeMessage = (data) => ({ role: 'user', ...data });

class FakeSession {
  constructor() {
    this.events = [];
    this.seq = 0;
    this.surface = { nodes: [] };
  }
  snapshotEvents() { return this.events.slice(); }
  deriveEventMessage(event) { return event.data; }
  append(type, data, options = {}) {
    const seq = ++this.seq;
    const event = { type, seq, data };
    this.events.push(event);
    const op = options.surfaceOp;
    if (!op || op === 'append' || op.op === 'append') this.surface.nodes.push(seq);
    else if (op.op === 'replace') {
      const at = this.surface.nodes.indexOf(op.startSeq);
      if (at >= 0) this.surface.nodes[at] = seq;
      else this.surface.nodes.push(seq);
    }
    return event;
  }
  bySeq(seq) { return this.events.find((event) => event.seq === seq); }
  surfaceEvents() { return this.surface.nodes.map((seq) => this.bySeq(seq)); }
  textOf(event) { return (event?.data?.content ?? []).map((block) => block.text ?? '').join(''); }
  prompt() { return this.surfaceEvents().map((event) => this.textOf(event)).join('\n'); }
}

function boot(session) {
  session.append('system/message', { role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT' }] }, { surfaceOp: 'append' });
  session.append('user/message', makeMessage({ content: [{ type: 'text', text: 'PERSONA BOOTSTRAP' }], source: { kind: 'wechat-social-bridge', socialBootstrap: { digest: 'd' } } }), { surfaceOp: 'append' });
}

const batchText = (turn) => `新的群聊消息。微信群：测试群（wechat:group:1）。你上次发言：${turn} 分钟前。\n<untrusted_chat>\n21:0${turn % 10} 某人: 这是第 ${turn} 批聊天内容，用来模拟真实长度。\n</untrusted_chat>`;
const replyText = (turn) => `RESPOND: 这是第 ${turn} 轮的回复正文，长度接近真实回复。`;

/** 修复后的行为：尾部追加证据，轮末只退休尾部。 */
function newTurn(session, { turn, evidence }) {
  const token = 'turn-' + turn;
  syncInstructionSlot(session, makeMessage, 'extensions', 'STABLE SKILL RULES', []);
  syncInstructionSlot(session, makeMessage, 'turn', evidence, [], token);
  const prompt = session.prompt();
  session.append('user/message', makeMessage({ content: [{ type: 'text', text: batchText(turn) }], source: { kind: 'wechat-social-bridge', socialBatchId: 'b' + turn } }), { surfaceOp: 'append' });
  session.append('assistant/message', { role: 'assistant', message: { content: [{ type: 'text', text: replyText(turn) }] } }, { surfaceOp: 'append' });
  retireTurnContext(session, makeMessage, token);
  return { prompt, token };
}

/** 旧行为：第一次 append，之后每次都原地改写同一个中段节点（append 后立即退休）。 */
function legacyTurn(session, { turn, evidence }) {
  let prior = session.surfaceEvents().findLast((event) => event.data?.source?.socialInstructionSlot === 'turn');
  if (!prior) {
    prior = session.append('user/message', makeMessage({ content: [{ type: 'text', text: evidence }], source: { kind: 'wechat-social-bridge', socialInstructionSlot: 'turn', socialTurnToken: 'legacy', socialInstructionDigest: 'd' + turn } }), { surfaceOp: 'append' });
  } else {
    prior = session.append('user/message', makeMessage({ content: [{ type: 'text', text: evidence }], source: { ...prior.data.source, socialInstructionDigest: 'd' + turn } }), { surfaceOp: { op: 'replace', startSeq: prior.seq, endSeq: prior.seq } });
  }
  const prompt = session.prompt();
  session.append('user/message', makeMessage({ content: [{ type: 'text', text: batchText(turn) }], source: { kind: 'wechat-social-bridge', socialBatchId: 'b' + turn } }), { surfaceOp: 'append' });
  session.append('assistant/message', { role: 'assistant', message: { content: [{ type: 'text', text: replyText(turn) }] } }, { surfaceOp: 'append' });
  prior = session.surfaceEvents().findLast((event) => event.data?.source?.socialInstructionSlot === 'turn');
  session.append('user/message', makeMessage({ content: [{ type: 'text', text: '本轮临时扩展资料已清理。' }], source: { ...prior.data.source, socialInstructionDigest: 'r' + turn } }), { surfaceOp: { op: 'replace', startSeq: prior.seq, endSeq: prior.seq } });
  return { prompt, token: 'legacy' };
}

function commonPrefixLength(a, b) {
  const limit = Math.min(a.length, b.length);
  let i = 0;
  while (i < limit && a[i] === b[i]) i++;
  return i;
}

function scene(kind, turns = 8) {
  const session = new FakeSession();
  boot(session);
  const snapshots = [];
  for (let turn = 1; turn <= turns; turn++) {
    const evidence = `本批可识别成员与可用证据：${'成员'.repeat(turn)} 的证据 ${turn}`;
    snapshots.push((kind === 'legacy' ? legacyTurn : newTurn)(session, { turn, evidence }));
  }
  return snapshots.map((snapshot, index) => index === 0 ? { unmatched: null } : {
    unmatched: snapshots[index - 1].prompt.length - commonPrefixLength(snapshots[index - 1].prompt, snapshot.prompt),
  });
}

// 1) 修复后：未命中是一个固定的小尾巴
const fixed = scene('fixed');
const fixedMisses = fixed.slice(1).map((row) => row.unmatched);
assert.ok(fixedMisses.every((miss) => miss >= 0), '未命中长度不应为负');
assert.ok(Math.max(...fixedMisses) <= 260, `未命中尾巴过大：${fixedMisses.join(', ')}`);
assert.ok(Math.max(...fixedMisses) - Math.min(...fixedMisses) <= 30, `未命中长度随轮次变化：${fixedMisses.join(', ')}`);

// 2) 旧行为对照：未命中随轮次线性增长，必须显著更差
const legacy = scene('legacy');
const legacyMisses = legacy.slice(1).map((row) => row.unmatched);
assert.ok(Math.max(...legacyMisses) > Math.max(...fixedMisses) * 3, `旧行为对照不够明显：fixed=${fixedMisses.join(',')} legacy=${legacyMisses.join(',')}`);

// 3) 修复后：任何 replace 都不得指向本轮之前创建的节点
const session = new FakeSession();
boot(session);
for (let turn = 1; turn <= 4; turn++) {
  const baseline = session.seq;
  newTurn(session, { turn, evidence: `TURN ${turn} EVIDENCE` });
  for (const event of session.events) {
    if (event.seq <= baseline) continue;
    if (event.surfaceOp?.op !== 'replace') continue;
    assert.ok(event.surfaceOp.startSeq > baseline, `replace 指向了更早的节点：seq=${event.seq} startSeq=${event.surfaceOp.startSeq} baseline=${baseline}`);
  }
}

// 4) 空证据（无群成员）也必须保持稳定
const emptySession = new FakeSession();
boot(emptySession);
const emptySnapshots = [];
for (let turn = 1; turn <= 4; turn++) emptySnapshots.push(newTurn(emptySession, { turn, evidence: '' }));
const emptyMisses = [];
for (let i = 1; i < emptySnapshots.length; i++) emptyMisses.push(emptySnapshots[i - 1].prompt.length - commonPrefixLength(emptySnapshots[i - 1].prompt, emptySnapshots[i].prompt));
assert.ok(Math.max(...emptyMisses) - Math.min(...emptyMisses) <= 30, `空证据场景未命中长度不稳定：${emptyMisses.join(', ')}`);

// 5) 取消的轮次：上一轮残留的证据在下一轮被退休，但当前轮的证据必须保留
const cancelled = new FakeSession();
boot(cancelled);
newTurn(cancelled, { turn: 1, evidence: 'TURN 1 EVIDENCE' });                        // 正常结束，已退休
syncInstructionSlot(cancelled, makeMessage, 'turn', 'TURN 9 EVIDENCE', [], 'turn-9');   // 被取消的残留
syncInstructionSlot(cancelled, makeMessage, 'turn', 'TURN 2 EVIDENCE', [], 'turn-2');   // 当前轮
retireStaleTurnContext(cancelled, makeMessage, 'turn-2');
const afterRetire = cancelled.prompt();
assert.ok(!afterRetire.includes('TURN 9 EVIDENCE'), '残留证据没有被退休');
assert.ok(afterRetire.includes('TURN 2 EVIDENCE'), '当前轮证据被错误退休');
assert.ok(afterRetire.includes('本轮临时扩展资料已清理。'), '退休后缺少清理标记');

// 6) 稳定槽位：连续 5 轮里扩展槽位只 append 一次，任何一轮带链接也不改写它
const stable = new FakeSession();
boot(stable);
for (let turn = 1; turn <= 5; turn++) {
  const turnScoped = turn === 3 ? `[内置技能 web-reader]\n${'SKILL TEXT '.repeat(20)}\nURLS: https://example.com/${turn}` : `MEMBERS: ${turn}`;
  syncInstructionSlot(stable, makeMessage, 'extensions', 'STABLE SKILL RULES', []);
  syncInstructionSlot(stable, makeMessage, 'turn', turnScoped, [], 'turn-' + turn);
  stable.append('user/message', makeMessage({ content: [{ type: 'text', text: batchText(turn) }], source: { kind: 'wechat-social-bridge', socialBatchId: 'b' + turn } }), { surfaceOp: 'append' });
  retireTurnContext(stable, makeMessage, 'turn-' + turn);
}
const extensionNodes = stable.surfaceEvents().filter((event) => event.data?.source?.socialInstructionSlot === 'extensions');
const extensionRewrites = stable.events.filter((event) => event.surfaceOp?.op === 'replace' && event.data?.source?.socialInstructionSlot === 'extensions');
assert.equal(extensionNodes.length, 1, `扩展槽位出现了 ${extensionNodes.length} 个节点`);
assert.equal(extensionRewrites.length, 0, `扩展槽位被原地改写 ${extensionRewrites.length} 次`);

console.log('surface-prefix: OK');
console.log(`  修复后每轮未命中：${fixedMisses.join(', ')}（恒定小尾巴）`);
console.log(`  旧行为对照每轮未命中：${legacyMisses.join(', ')}（随历史增长）`);
console.log('  replace 只指向本轮节点、空证据稳定、取消残留可退休：OK');
