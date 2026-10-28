#!/usr/bin/env node
/**
 * 发送协议解析回归测试（设计文档 S7）。
 *
 * 目标：真实会话里出现的「没有 RESPOND: 前缀的纯文本回复」必须一次通过，
 * 不再触发第二次模型请求（格式校正）；同时推理片段、表情控制符、超长内容
 * 仍然必须被判为 INVALID。
 *
 * 用例取自 2026-10-25 群聊会话的 13 条真实输出。
 *
 * 用法：node packages/dsh-social-bridge-plugin/tests/decision-format.mjs
 */
import assert from 'node:assert';
import { parseSocialDecision } from '../../../components/qq-bridge/src/core/decision-format.js';

const stickerRefs = {
  S1: 'a'.repeat(64),
  S2: 'b'.repeat(64),
  S3: 'c'.repeat(64),
};

// 真实会话里的模型输出（turn 14–46）。
const realReplies = [
  '？谁是大肥鱼，是小鲸鱼',
  'RESPOND: ？谁是大肥鱼，是小鲸鱼',
  'SILENT',
  '哼，那当然',
  '？没有主人，再说大肥鱼就不理你了',
  '？鱼什么灾，说人话',
  '小鲸鱼，DeepSeek，蓝白配色带条尾巴，不是大肥鱼',
  '哼，才、才不是特意跟你聊的呢',
  '笑什么笑，不许笑',
  '那你笑吧，一会儿收费',
  '？1亿token，行，钱你出',
  '断吧，断了我你找谁聊',
];

for (const raw of realReplies) {
  const result = parseSocialDecision(raw, stickerRefs);
  const expected = /^\[?SILENT\]?$/i.test(raw.trim()) ? 'SILENT' : 'RESPOND';
  assert.equal(result.decision, expected, `真实回复被判为 ${result.decision}：${raw}`);
  if (expected === 'RESPOND') assert.ok(result.text.length > 0, `回复正文为空：${raw}`);
}

// 两段式消息：空行分条仍然生效
const parts = parseSocialDecision('哼，你又说这个\n\n我忙着呢', stickerRefs);
assert.equal(parts.decision, 'RESPOND');
assert.deepEqual(parts.textParts, ['哼，你又说这个', '我忙着呢']);

// 仍然必须拒绝的情况
const mustReject = [
  '思考：先判断对方是不是在叫我',
  'Reasoning: the user is asking about the weather',
  '分析过程\n他其实不想理我',
  '<analysis>hidden</analysis>',
  '[STICKER:abc]',
  '好好好 [STICKER:S1]',
  '   ',
];
for (const raw of mustReject) {
  const result = parseSocialDecision(raw, stickerRefs);
  assert.equal(result.decision, 'INVALID', `应当拒绝却被接受（${result.decision}）：${raw}`);
}

// 无标记的贴图/表情控制仍然不允许裸奔
const stickerControl = parseSocialDecision('发个表情 [S2]', stickerRefs);
assert.equal(stickerControl.decision, 'INVALID', '[S2] 混在正文里应被拒绝');

// 带候选时，纯标记仍然可用
const taggedSticker = parseSocialDecision('[STICKER:S1]', stickerRefs);
assert.equal(taggedSticker.decision, 'STICKER');

const caption = parseSocialDecision('看这个\n[STICKER:S1]', stickerRefs, { allowStickerCaption: true });
assert.equal(caption.decision, 'RESPOND');
assert.ok(caption.stickerId);

console.log('decision-format: OK');
console.log(`  ${realReplies.length} 条真实输出全部一次通过（其中 ${realReplies.filter((r) => !/^RESPOND:/i.test(r) && !/SILENT/i.test(r)).length} 条原本会触发格式校正）`);
console.log(`  ${mustReject.length + 1} 条应拒绝样本仍然拒绝`);
