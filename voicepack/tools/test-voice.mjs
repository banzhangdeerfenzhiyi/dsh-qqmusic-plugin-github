#!/usr/bin/env node
/**
 * Synthesize one line with a chosen voice, without DSH.
 *
 *   node tools/test-voice.mjs --text "你好呀" --voice 云希
 *   node tools/test-voice.mjs --text "本小姐来啦" --voice 晓伊 --rvc paimon
 *   node tools/test-voice.mjs --text "测试" --voice 云希 --out .work
 *
 * Add `--send --session social-...` to push the voice bubble to the matching
 * WeChat chat (the session id is the social-bridge one, see the DSH session list).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRvcStage, resolveSettings } from '../index.mjs';
import { synthesizeSpeech } from '../src/speech.mjs';
import { resolveSelection } from '../src/voices.mjs';
import {
  readHookToken,
  resolveChatKey,
  resolveUsername,
  resolveWorkspace,
  storeSilk,
  submitVoice,
} from '../src/wechat.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined;
};
const flag = (name) => argv.includes(name);

const text = value('--text') ?? '你好呀，我是你的语音包小助手。';
const sessionId = value('--session') ?? '';
const outDir = value('--out') ?? join(PLUGIN_ROOT, '.work');
const settings = resolveSettings({
  workspace: value('--workspace') ?? '',
  rvcRoot: value('--rvc-root') ?? '',
});
const selection = resolveSelection({ voice: value('--voice'), rvc: value('--rvc') });
const stage = buildRvcStage(settings, value('--rvc'));
const rvcName = stage.preset ? ` + rvc:${stage.preset}` : '';
console.log(`voice: ${selection.voice.name} (${selection.voice.id})${rvcName}`);
console.log(`text: ${text}`);

const started = Date.now();
const audio = await synthesizeSpeech(text, {
  voice: selection.voice.id,
  rate: value('--rate') ?? settings.rate,
  pitch: value('--pitch') ?? settings.pitch,
  rvc: stage.rvc,
});
mkdirSync(outDir, { recursive: true });
const stamp = Date.now();
const mp3Path = join(outDir, `voicepack-${stamp}.mp3`);
const silkPath = join(outDir, `voicepack-${stamp}.silk`);
writeFileSync(mp3Path, audio.mp3);
writeFileSync(silkPath, audio.silk);
console.log(
  `ok: ${Math.round(audio.durationMs / 100) / 10}s silk=${audio.silk.length}B mp3=${audio.mp3.length}B ` +
    `elapsed=${Math.round((Date.now() - started) / 1000)}s`,
);
console.log(`files: ${mp3Path}  ${silkPath}`);

if (flag('--send')) {
  if (sessionId === '') {
    console.error('--send needs --session <social-session-id>');
    process.exit(2);
  }
  const workspace = resolveWorkspace(settings.workspace);
  const chat = resolveChatKey(sessionId, workspace);
  if (!chat) {
    console.error(`session ${sessionId} has no WeChat chat mapping`);
    process.exit(1);
  }
  const target = await resolveUsername(workspace, chat.chatKey);
  const token = readHookToken(workspace);
  const stored = storeSilk(workspace, audio.silk);
  const result = await submitVoice(workspace, {
    hookUrl: settings.hookUrl,
    token,
    toUser: target.username,
    silkPath: stored.path,
    md5: stored.md5,
    durationMs: audio.durationMs,
  });
  console.log('sent:', JSON.stringify({ chatKey: chat.chatKey, toUser: target.username, md5: stored.md5, result }));
} else {
  console.log('(dry run; add --send --session <id> to push it to WeChat)');
}
