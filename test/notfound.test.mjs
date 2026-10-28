/**
 * Verify the "song not found -> spoken apology" path end to end.
 *
 *   node test/notfound.test.mjs                    # dry: detect + resolve target only
 *   node test/notfound.test.mjs --send \
 *        --session <dsh-session-id>                # also push the voice to the real chat
 *
 * `--session` (or QQMUSIC_TEST_SESSION) is the DSH social session id whose WeChat
 * bindings are read from your WeChatAgent workspace; without it the test stops
 * after the NOT_FOUND check. Skips cleanly when the network, the workspace or the
 * sibling voice plugin is not available.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSettings } from '../index.mjs';
import { createLogger } from '../src/log.mjs';
import { renderSinging } from '../src/singing.mjs';
import { resolveSessionTarget } from '../src/wechat.mjs';
import { sendFallbackVoice } from '../src/voice-fallback.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const send = process.argv.includes('--send');
const sessionArg = process.argv.indexOf('--session');
const sessionId =
  (sessionArg >= 0 && process.argv[sessionArg + 1]) || process.env.QQMUSIC_TEST_SESSION || '';
const settings = resolveSettings({ workDir: join(PLUGIN_ROOT, '.work') });
const log = createLogger('qqmusic-cli');

let code;
try {
  await renderSinging({ keyword: '这个歌名肯定不存在xyzabc' }, settings, log);
  console.log('FAIL: expected a NOT_FOUND error');
  process.exit(1);
} catch (error) {
  code = error?.code;
  if (code !== 'NOT_FOUND') {
    console.log(`skip: render failed before the match check (${error?.message ?? error})`);
    process.exit(0);
  }
  console.log(`render: code=${code} message=${error.message}`);
}

if (sessionId === '') {
  console.log('skip: no --session given, so the WeChat target cannot be resolved here');
  process.exit(0);
}

let target;
try {
  target = await resolveSessionTarget({ sessionId, settings });
} catch (error) {
  console.log(`skip: cannot resolve the session target (${error?.message ?? error})`);
  process.exit(0);
}
console.log(`target: ${target.chatKey} -> ${target.toUser}`);

if (!send) {
  console.log('dry run: skipping the actual voice send (pass --send)');
  process.exit(0);
}

const result = await sendFallbackVoice({
  sessionId,
  toUser: target.toUser,
  text: settings.notFoundVoiceText,
  settings,
  log,
});
console.log('fallback voice:', JSON.stringify(result));
if (!result.sent) {
  console.log('skip: the sibling voice plugin / hook is not available');
  process.exit(0);
}
console.log('ok');
