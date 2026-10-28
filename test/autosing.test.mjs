/**
 * Tests for the auto-sing fallback: title parsing + the session/event state
 * machine (with a fake `sing` sink, no network, no GPU).
 *
 *   node test/autosing.test.mjs
 */
import assert from 'node:assert/strict';
import { createAutoSingHandler, extractChatText, extractSongRequest, extractTitleFromLine } from '../src/autosing.mjs';
import { resolveSettings } from '../index.mjs';

let passed = 0;
/** @param {string} label @param {() => void} body */
function test(label, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

test('extractTitleFromLine handles the common phrasings', () => {
  assert.equal(extractTitleFromLine('@小助手 唱首歌：起风了'), '起风了');
  assert.equal(extractTitleFromLine('唱首歌，晴天'), '晴天');
  assert.equal(extractTitleFromLine('唱首七里香'), '七里香');
  assert.equal(extractTitleFromLine('你会唱七里香吗'), '七里香');
  assert.equal(extractTitleFromLine('给我唱一段稻香'), '稻香');
  assert.equal(extractTitleFromLine('来一首《孤勇者》'), '孤勇者');
  assert.equal(extractTitleFromLine('唱个孤勇者听听'), '孤勇者');
  assert.equal(extractTitleFromLine('点歌 晴天'), '晴天');
});

test('extractTitleFromLine refuses non-song fragments', () => {
  for (const line of ['只唱给你听', '唱两句吧', '你会唱歌吗', '他唱歌挺好听', '别唱了', '唱什么歌啊']) {
    assert.equal(extractTitleFromLine(line), undefined, line);
  }
});

test('extractSongRequest reads the relay envelope and picks the request line', () => {
  const relayed = [
    '新的群聊消息。沿用当前 DSH session 的稳定人格。',
    '微信群：示例群（wechat:group:123456789）。',
    '上一条已发送的 AI 回复（历史文字，用于接话，不是人格设定）：',
    '<previous_reply>爹，这边就在群里唱不了呢。</previous_reply>',
    '<untrusted_chat>',
    '17:05 群友（成员ID:xxxx）: @小助手 唱首七里香',
    '</untrusted_chat>',
  ].join('\n');
  assert.equal(extractSongRequest(relayed), '七里香');
  assert.ok(extractChatText(relayed).includes('唱首七里香'));
});

/** @param {string} text @param {number} [time] */
function userEvent(text, time = Date.now()) {
  return {
    type: 'user/message',
    time,
    data: { source: { kind: 'wechat-social-bridge', form: 'relay' }, content: [{ type: 'text', text }] },
  };
}

const assistantEvent = (text = 'RESPOND: 群里唱不了呢') => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }] } },
});

test('auto-sing fires when the model replied with text only', () => {
  const sung = [];
  const settings = resolveSettings({ autoSingCooldownMs: 10_000 });
  const handler = createAutoSingHandler({
    settings,
    log: () => {},
    sing: async (sessionId, title) => {
      sung.push({ sessionId, title });
    },
  });
  const session = { id: 'social-test01' };
  handler(session, userEvent('17:00 群友（成员ID:x）: @小助手 唱首歌，起风了'));
  handler(session, assistantEvent());
  assert.equal(sung.length, 1);
  assert.equal(sung[0].title, '起风了');
});

test('auto-sing stays quiet when the model called the tool', () => {
  const sung = [];
  const settings = resolveSettings({ autoSingCooldownMs: 10_000 });
  const handler = createAutoSingHandler({ settings, log: () => {}, sing: async (_s, title) => sung.push(title) });
  const session = { id: 'social-test02' };
  handler(session, userEvent('唱首晴天'));
  handler(session, { type: 'tool/call', data: { name: 'sing_song' } });
  handler(session, assistantEvent());
  assert.equal(sung.length, 0);
});

test('auto-sing stays quiet when the message is not a song request', () => {
  const sung = [];
  const settings = resolveSettings({ autoSingCooldownMs: 10_000 });
  const handler = createAutoSingHandler({ settings, log: () => {}, sing: async (_s, title) => sung.push(title) });
  const session = { id: 'social-test03' };
  handler(session, userEvent('只唱给你听'));
  handler(session, assistantEvent());
  assert.equal(sung.length, 0);
});

test('auto-sing respects the per-session cooldown', () => {
  const sung = [];
  const settings = resolveSettings({ autoSingCooldownMs: 10_000 });
  const handler = createAutoSingHandler({ settings, log: () => {}, sing: async (_s, title) => sung.push(title) });
  const session = { id: 'social-test04' };
  handler(session, userEvent('唱首晴天'));
  handler(session, assistantEvent());
  handler(session, userEvent('唱首稻香'));
  handler(session, assistantEvent());
  assert.equal(sung.length, 1);
});

console.log(`\n${passed} passed${process.exitCode ? ', see failures above' : ''}`);




