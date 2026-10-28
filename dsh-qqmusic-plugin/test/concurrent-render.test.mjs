/**
 * Regression test for the "voice is only 6 seconds" bug.
 *
 * Three chats asked for the same song at the same moment; two renders raced on
 * the same cache files and one of them read a half-written PCM. After the fix
 * the same render key is serialised and cache files must be duration-sized.
 *
 *   QQMUSIC_SPAWN_INHERIT=1 node test/concurrent-render.test.mjs
 */
import { rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSettings } from '../index.mjs';
import { renderSinging } from '../src/singing.mjs';

const settings = resolveSettings({
  workDir: 'C:/Users/Administrator/.dsh/dsh_wechat/qqmusic-plugin/.work',
});
const log = (line) => {
  if (/sing:|retry/.test(line)) console.log('[log]', line);
};
const seconds = 20;

// Start from a clean slate for this excerpt so both renders must actually run.
const workDir = join(settings.workDir, '0039MnYb0qxYhV'); // 晴天 / 周杰伦
try {
  for (const name of readdirSync(workDir)) {
    if (name.includes(`-${99}-${seconds}`)) rmSync(join(workDir, name), { force: true });
  }
} catch {
  /* workdir may not exist yet */
}

console.log('launching two concurrent renders of 晴天', seconds, 's …');
const started = Date.now();
const [a, b] = await Promise.all([
  renderSinging({ keyword: '晴天', mode: 'cover', seconds, start: 99 }, settings, log),
  renderSinging({ keyword: '晴天', mode: 'cover', seconds, start: 99 }, settings, log),
]);
const elapsed = Math.round((Date.now() - started) / 1000);

for (const [label, rendered] of [
  ['A', a],
  ['B', b],
]) {
  const mp3Bytes = statSync(rendered.mp3Path).size;
  console.log(
    `${label}: duration=${(rendered.durationMs / 1000).toFixed(1)}s silk=${rendered.silk.length}B mp3=${mp3Bytes}B`,
  );
  if (rendered.durationMs < seconds * 1000 * 0.9) {
    console.error(`FAIL: ${label} render is truncated`);
    process.exit(1);
  }
  if (mp3Bytes < seconds * 10_000) {
    console.error(`FAIL: ${label} mp3 is truncated`);
    process.exit(1);
  }
}
if (Math.abs(a.durationMs - b.durationMs) > 500) {
  console.error('FAIL: the two renders disagree on duration');
  process.exit(1);
}
console.log(`ok: both renders are ${(a.durationMs / 1000).toFixed(1)}s (wall ${elapsed}s)`);
