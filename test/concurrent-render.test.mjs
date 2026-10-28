/**
 * Regression test for the "voice is only 6 seconds" bug.
 *
 * Three chats asked for the same song at the same moment; two renders raced on
 * the same cache files and one of them read a half-written PCM. After the fix
 * the same render key is serialised and cache files must be duration-sized.
 *
 * Needs the full RVC environment + a downloaded 晴天. Set the cache dir if you
 * do not want the default `<repo>/.work`:
 *
 *   QQMUSIC_SPAWN_INHERIT=1 QQMUSIC_TEST_WORKDIR=/path/to/.work node test/concurrent-render.test.mjs
 *
 * Exits 0 with a skip message when the RVC root is missing (fresh clone).
 */
import { rmSync, statSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSettings } from '../index.mjs';
import { renderSinging } from '../src/singing.mjs';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const settings = resolveSettings({
  workDir: process.env.QQMUSIC_TEST_WORKDIR || join(REPO_ROOT, '.work'),
});

if (settings.rvcRoot === '') {
  console.log('skip: RVC root not found (set RVC_ROOT or config.rvcRoot to run this GPU test)');
  process.exit(0);
}

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
