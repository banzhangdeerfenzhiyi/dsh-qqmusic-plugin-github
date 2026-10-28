/**
 * Offline unit tests for the pure helpers (no network, no GPU).
 *
 *   node test/unit.test.mjs
 */
import assert from 'node:assert/strict';
import { matchScore, rankCandidates, searchSongs } from '../src/qqmusic.mjs';
import { pickStartSeconds } from '../src/singing.mjs';
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

test('rankCandidates prefers exact title and free source', () => {
  const songs = [
    { title: '起风了 (旧版)', artist: '买辣椒也用券', mid: 'a', mediaMid: 'a', interval: 312, free: false, tryBeginMs: 0, tryEndMs: 0 },
    { title: '起风了', artist: '吴青峰', mid: 'b', mediaMid: 'b', interval: 313, free: true, tryBeginMs: 0, tryEndMs: 0 },
    { title: '起风了', artist: '买辣椒也用券', mid: 'c', mediaMid: 'c', interval: 325, free: true, tryBeginMs: 0, tryEndMs: 0 },
  ];
  const ranked = rankCandidates(songs, '起风了', '买辣椒也用券');
  assert.equal(ranked[0].mid, 'c');
  assert.ok(ranked.findIndex((song) => song.mid === 'a') > 0);
});

test('rankCandidates survives decorations and empty artist', () => {
  const songs = [
    { title: '晴天', artist: '维也纳碎片', mid: 'x', mediaMid: 'x', interval: 119, free: true, tryBeginMs: 0, tryEndMs: 0 },
    { title: '晴天（Live）', artist: '周杰伦', mid: 'y', mediaMid: 'y', interval: 270, free: false, tryBeginMs: 0, tryEndMs: 0 },
  ];
  const ranked = rankCandidates(songs, '晴天');
  assert.equal(ranked[0].mid, 'x');
});

test('rankCandidates prefers the master recording when a member account is available', () => {
  const master = {
    title: '晴天',
    artist: '周杰伦',
    mid: 'master',
    mediaMid: 'master',
    interval: 269,
    free: false,
    tryBeginMs: 0,
    tryEndMs: 0,
  };
  const cover = {
    title: '晴天',
    artist: '维也纳碎片',
    mid: 'cover',
    mediaMid: 'cover',
    interval: 119,
    free: true,
    tryBeginMs: 0,
    tryEndMs: 0,
  };
  assert.equal(rankCandidates([cover, master], '晴天')[0].mid, 'cover');
  assert.equal(rankCandidates([cover, master], '晴天', '', { preferVip: true })[0].mid, 'master');
});

test('pickStartSeconds uses the QQ Music preview window', () => {
  const song = { interval: 325, tryBeginMs: 76_105, tryEndMs: 109_432 };
  // 33.3s window centred for a 30s excerpt -> 78s
  assert.equal(pickStartSeconds(song, 30, undefined), 78);
});

test('pickStartSeconds honours an explicit start and clamps it', () => {
  const song = { interval: 200, tryBeginMs: 50_000, tryEndMs: 80_000 };
  assert.equal(pickStartSeconds(song, 30, 90), 90);
  assert.equal(pickStartSeconds(song, 30, 500), 170);
  assert.equal(pickStartSeconds(song, 30, 0), 0);
});

test('pickStartSeconds falls back to 40% for short/no-preview songs', () => {
  assert.equal(pickStartSeconds({ interval: 240, tryBeginMs: 0, tryEndMs: 0 }, 30, undefined), 96);
  assert.equal(pickStartSeconds({ interval: 20, tryBeginMs: 0, tryEndMs: 0 }, 30, undefined), 0);
});

test('resolveSettings derives paths and clamps numbers', () => {
  const settings = resolveSettings({ rvcRoot: 'D:/rvc/', pitch: 99, defaultSeconds: 2, maxSeconds: 999 });
  assert.equal(settings.rvcRoot, 'D:/rvc');
  assert.equal(settings.python, 'D:/rvc/venv312/Scripts/python.exe');
  assert.equal(settings.ffmpeg, 'D:/rvc/applio/ffmpeg.exe');
  assert.equal(settings.pitch, 12);
  assert.equal(settings.maxSeconds, 60);
  assert.equal(settings.defaultSeconds, 8);
  assert.ok(settings.models.Paimon.pth.endsWith('/models/Paimon/paimon_cn.pth'));
});

test('resolveSettings merges per-model overrides', () => {
  const settings = resolveSettings({
    models: { Paimon: { targetF0: 400, pth: 'D:/x/p.pth' }, Custom: { pth: 'D:/x/c.pth', index: 'D:/x/c.index' } },
  });
  assert.equal(settings.models.Paimon.targetF0, 400);
  assert.equal(settings.models.Paimon.pth, 'D:/x/p.pth');
  assert.equal(settings.models.Custom.targetF0, 300);
});

test('matchScore accepts exact, artist+title and prefix phrasings', () => {
  const song = (title, artist) => ({
    title,
    artist,
    mid: 'x',
    mediaMid: 'x',
    interval: 200,
    free: true,
    tryBeginMs: 0,
    tryEndMs: 0,
  });
  assert.equal(matchScore('晴天', song('晴天', '周杰伦')), 100);
  assert.ok(matchScore('周杰伦 稻香', song('稻香', '周杰伦')) >= 50);
  assert.ok(matchScore('来一首起风了', song('起风了', '买辣椒也用券')) >= 35);
  assert.ok(matchScore('稻香', song('稻香 (Live)', '周杰伦')) >= 95);
  assert.ok(matchScore('这个歌名肯定不存在xyzabc', song('猫和老鼠', 'CV苏茗')) < 30);
});

test('matchScore rejects unrelated fuzzy search rows', () => {
  const rows = [
    { title: '0007集 猫和老鼠', artist: 'CV苏茗', mid: 'a', mediaMid: 'a', interval: 400, free: true, tryBeginMs: 0, tryEndMs: 0 },
    { title: '牛奶神探12·时间循环逃杀13 1', artist: '小番茄', mid: 'b', mediaMid: 'b', interval: 60, free: true, tryBeginMs: 0, tryEndMs: 0 },
  ];
  for (const row of rows) assert.ok(matchScore('这个歌名肯定不存在xyzabc', row) < 30);
});

test('resolveSettings exposes VIP + spoken-fallback config', () => {
  const settings = resolveSettings({});
  assert.equal(settings.authEnabled, true);
  assert.ok(settings.cookieFile.endsWith('/.dsh/qqmusic/cookie.json'));
  assert.equal(settings.notFoundVoiceText, '我不知道你说的歌怎么唱哦');
  assert.equal(settings.voiceFallbackEnabled, true);
  assert.equal(settings.minMatchScore, 30);
});

const network = process.env.QQMUSIC_NETWORK_TEST === '1';
if (network) {
  const songs = await searchSongs('起风了', 3);
  test('searchSongs returns normalized rows', () => {
    assert.ok(songs.length > 0);
    for (const song of songs) {
      assert.ok(song.mid !== '');
      assert.ok(song.title !== '');
      assert.ok(typeof song.free === 'boolean');
    }
  });
} else {
  console.log('skip network test (set QQMUSIC_NETWORK_TEST=1 to include)');
}

console.log(`\n${passed} passed${process.exitCode ? ', see failures above' : ''}`);
