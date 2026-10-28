/**
 * The singing pipeline: QQ Music -> excerpt -> (Demucs -> RVC) -> mix -> SILK.
 *
 * Three modes:
 *   cover     her voice over the original accompaniment (AI cover, the default)
 *   original  the song's own excerpt, untouched (fast, no GPU)
 *   acapella  her voice only, no accompaniment
 *
 * Every stage is cached on disk under `<workDir>/<songmid>/`, so asking for the
 * same song twice only pays for the stages whose inputs changed.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadSong, matchScore, rankCandidates, searchSongs } from './qqmusic.mjs';
import { describeAuthSource, readAuth } from './qqauth.mjs';
import { ToolError, cutSegment, mixCover, pcmToMp3, run, toVoicePcm } from './media.mjs';
import { encodeSilkFromPcm } from './voice.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PYTHON_DIR = join(PLUGIN_ROOT, 'python');
const MODES = new Set(['cover', 'original', 'acapella']);

/**
 * Sing one excerpt of one song.
 *
 * @param {{keyword: string, mode?: string, seconds?: number, start?: number, artist?: string}} request
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 * @returns {Promise<{song: {title: string, artist: string, mid: string}, mode: string, seconds: number, start: number, pitch: number|null, model: string|null, silk: Buffer, durationMs: number, sampleRate: number, notes: string[]}>}
 */
export async function renderSinging(request, settings, log) {
  const keyword = String(request?.keyword ?? '').trim();
  const mode = MODES.has(String(request?.mode ?? '')) ? String(request.mode) : 'cover';
  const seconds = clamp(request?.seconds ?? settings.defaultSeconds, 8, settings.maxSeconds);
  const requestedStart = Number.isFinite(Number(request?.start)) ? Number(request.start) : '';
  // Two chats can ask for the same song at the same instant (WeChat groups and
  // QQ both fan out to this pipeline). Serialise the same render so nobody reads
  // a half-written cache file and ships a truncated voice (the "why is the song
  // only 6 seconds" bug).
  const lockKey = `${keyword.toLowerCase()}|${mode}|${seconds}|${requestedStart}`;
  return await withRenderLock(lockKey, async () => {
    const first = await renderSingingOnce(request, settings, log);
    if (first.durationMs >= seconds * 1000 * 0.75) return first;
    // Safety net for a cache that somehow got truncated: clear this segment's
    // intermediate files and render once more instead of shipping a short clip.
    log(
      `sing: rendered ${Math.round(first.durationMs / 1000)}s for a ${seconds}s request, clearing cache and retrying`,
    );
    invalidateSegment(settings, first, seconds);
    const second = await renderSingingOnce(request, settings, log);
    if (second.durationMs < seconds * 1000 * 0.75) {
      throw new ToolError(
        `翻唱只渲染出 ${Math.round(second.durationMs / 1000)} 秒（预期 ${seconds} 秒），请重试或换一首`,
      );
    }
    return second;
  });
}

/**
 * Delete the intermediate files of one rendered excerpt so the next render
 * rebuilds them from scratch.
 *
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {{song: {mid: string}, start: number}} rendered
 * @param {number} seconds
 */
function invalidateSegment(settings, rendered, seconds) {
  const workDir = join(settings.workDir, safeSegment(rendered.song?.mid || 'song'));
  let entries = [];
  try {
    entries = readdirSync(workDir);
  } catch {
    return;
  }
  const suffix = `-${rendered.start}-${seconds}`;
  for (const name of entries) {
    if (!name.includes(suffix)) continue;
    try {
      unlinkSync(join(workDir, name));
    } catch {
      /* best effort */
    }
  }
}

/**
 * Serialise renders that share a lock key, then run the real pipeline.
 *
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
async function withRenderLock(key, task) {
  const previous = renderLocks.get(key) ?? Promise.resolve();
  const current = previous.then(task, task);
  const guard = current.catch(() => {});
  renderLocks.set(key, guard);
  try {
    return await current;
  } finally {
    if (renderLocks.get(key) === guard) renderLocks.delete(key);
  }
}

/** In-flight render chains, keyed by what is being rendered. */
const renderLocks = new Map();

/**
 * Is a cached file complete enough to reuse?
 *
 * A size floor is not enough: a 30 s render that is still being written can
 * already exceed 10 KB and would be accepted, which is exactly how a 6 s voice
 * used to leak out. Require ~the audio bytes the requested duration implies; a
 * short/truncated leftover is deleted so the stage regenerates it.
 *
 * @param {string} path
 * @param {'pcm'|'mp3'|'cover'|'mix'|'stem'} kind
 * @param {number} seconds
 * @returns {boolean}
 */
function cacheReady(path, kind, seconds) {
  /** bytes per second each stage produces */
  const perSecond = CACHE_BYTES_PER_SECOND[kind] ?? 48_000;
  const expected = Math.max(10_000, Math.floor(perSecond * Math.max(1, seconds) * 0.85));
  try {
    if (statSync(path).size >= expected) return true;
    unlinkSync(path);
    return false;
  } catch {
    return false;
  }
}

const CACHE_BYTES_PER_SECOND = {
  stem: 176_400, // 44.1 kHz stereo s16
  cover: 79_922, // RVC output: 40 kHz mono s16
  mix: 176_400,
  pcm: 48_000, // 24 kHz mono s16
  mp3: 12_000, // 96 kbps
};

async function renderSingingOnce(request, settings, log) {
  const keyword = String(request?.keyword ?? '').trim();
  if (keyword === '') throw new ToolError('要点歌就得给歌名（也可以是“歌手 歌名”）。');
  const mode = MODES.has(String(request?.mode ?? '')) ? String(request.mode) : 'cover';
  const seconds = clamp(request?.seconds ?? settings.defaultSeconds, 8, settings.maxSeconds);

  // Optional QQ Music account cookie: with a subscription this unlocks VIP
  // tracks and 320k assets; without it the plugin silently stays free-tier.
  const auth = settings.authEnabled === false ? undefined : readAuth(settings.cookieFile);
  if (auth) log(`sing: account uin=${auth.uin} cookie=${describeAuthSource(settings.cookieFile)}`);

  const songs = await searchSongs(keyword, settings.searchLimit);
  if (songs.length === 0) throw notFound(`QQ 音乐没搜到《${keyword}》，换个歌名试试。`);
  log(`sing: keyword=${keyword} mode=${mode} seconds=${seconds} found=${songs.length} auth=${Boolean(auth)}`);

  const ranked = rankCandidates(songs, keyword, request?.artist ?? '', { preferVip: Boolean(auth) }).slice(
    0,
    settings.maxCandidates,
  );
  const score = matchScore(keyword, ranked[0]);
  log(`sing: best match «${ranked[0]?.title ?? '-'}» score=${score} (min ${settings.minMatchScore})`);
  if (score < settings.minMatchScore) {
    // QQ Music's search is fuzzy: a nonsense query still returns eight rows, and
    // singing the wrong song is worse than admitting we don't know it.
    throw notFound(`QQ 音乐里没找到《${keyword}》，搜出来的都不像是这首歌。`);
  }
  const picked = await pickDownloadable(ranked, settings, log, auth);
  const song = picked.song;
  const workDir = join(settings.workDir, safeSegment(song.mid || 'song'));
  mkdirSync(workDir, { recursive: true });

  const start = pickStartSeconds(song, seconds, request?.start);
  const notes = [];
  if (auth && picked.quality !== undefined) notes.push(`音源 ${picked.quality}（会员账号）`);
  else if (!song.free) notes.push('这首歌在 QQ 音乐原本要会员，用的是能免费播放的版本');

  const segmentWav = join(workDir, `seg-${start}-${seconds}.wav`);
  await cutSegment({
    ffmpeg: settings.ffmpeg,
    input: picked.path,
    output: segmentWav,
    startSeconds: start,
    seconds,
  });
  log(`sing: segment ${start}s+${seconds}s -> ${segmentWav}`);

  /** @type {{silk: Buffer, durationMs: number, sampleRate: number}} */
  let encoded;
  let pitch = null;
  let modelName = null;

  const fellBack = async (reason) => {
    log(`sing: cover path failed (${reason}), falling back to original excerpt`);
    notes.push(`AI 翻唱这次没成功（${reason}），先放了原声片段`);
    return await renderOriginal(segmentWav, workDir, start, seconds, settings, log);
  };

  if (mode === 'original') {
    encoded = await renderOriginal(segmentWav, workDir, start, seconds, settings, log);
  } else {
    try {
      const stems = await separateStems(segmentWav, seconds, settings, log);
      const model = resolveModel(settings);
      modelName = model.name;
      pitch = await decidePitch(stems.vocals, model, settings, log);
      log(`sing: model=${model.name} pitch=${pitch}`);
      const coverVocal = await convertVocal(stems.vocals, workDir, start, seconds, model, pitch, settings, log);
      const audioInput =
        mode === 'acapella'
          ? coverVocal
          : await mix(
              coverVocal,
              stems.accompaniment,
              workDir,
              start,
              seconds,
              model.name,
              pitch,
              settings,
            );
      encoded = await finalizePcm(audioInput, workDir, start, seconds, mode, settings, log);
      notes.push(
        mode === 'acapella'
          ? `清唱，用的是她的 AI 音色（${model.name}，${pitch > 0 ? '+' : ''}${pitch} 半音）`
          : `AI 翻唱：她的音色（${model.name}，${pitch > 0 ? '+' : ''}${pitch} 半音）+ 原曲伴奏`,
      );
    } catch (error) {
      if (settings.fallbackToOriginal === false) throw error;
      encoded = await fellBack(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    song: { title: song.title, artist: song.artist, mid: song.mid },
    mode,
    seconds,
    start,
    pitch,
    model: modelName,
    silk: encoded.silk,
    /** Same audio as MP3 — used by the QQ (OneBot/NapCat) sender. */
    mp3Path: encoded.mp3Path,
    durationMs: encoded.durationMs,
    sampleRate: encoded.sampleRate,
    notes,
  };
}

/**
 * The "we could not find that song" failure marker: the caller turns it into a
 * spoken apology instead of a plain error.
 *
 * @param {string} message
 * @param {string} [detail]
 * @returns {ToolError & {code: 'NOT_FOUND'}}
 */
function notFound(message, detail) {
  const error = new ToolError(message, detail);
  error.code = 'NOT_FOUND';
  return error;
}

/**
 * Walk the ranked candidates until one has a downloadable (free) source.
 *
 * @param {Awaited<ReturnType<typeof rankCandidates>>} ranked
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {import('./qqauth.mjs').QqAuth} [auth]
 */
async function pickDownloadable(ranked, settings, log, auth) {
  let lastError;
  for (const song of ranked) {
    const workDir = join(settings.workDir, safeSegment(song.mid || 'song'));
    try {
      const downloaded = await downloadSong(song, workDir, log, auth);
      return { song, path: downloaded.path, quality: downloaded.quality };
    } catch (error) {
      lastError = error;
      log(`sing: candidate «${song.title}» (${song.artist}) skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw notFound(
    `《${ranked[0]?.title ?? '这首歌'}》在 QQ 音乐没有能播放的版本（会员也没拿到），换一首试试。`,
    lastError instanceof Error ? lastError.message : String(lastError ?? ''),
  );
}

/**
 * Environment for the RVC/Demucs Python children.
 *
 * `NUMBA_CACHE_DIR` is the important one: numba's JIT cache defaults to
 * `__pycache__` next to librosa inside the venv, and when that directory is not
 * writable (sandboxed caller, read-only install) numba's cache loader retries in
 * a busy loop forever — which looks exactly like "RVC hangs". Pointing it at a
 * writable directory makes the inference stack start in seconds.
 *
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @returns {Record<string, string>}
 */
function pythonEnv(settings) {
  const cacheRoot = join(settings.workDir, '.cache');
  const numba = join(cacheRoot, 'numba');
  const matplotlib = join(cacheRoot, 'matplotlib');
  for (const dir of [numba, matplotlib]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* a non-writable cache dir only costs speed, not correctness */
    }
  }
  return {
    HF_ENDPOINT: 'https://hf-mirror.com',
    NUMBA_CACHE_DIR: numba,
    MPLCONFIGDIR: matplotlib,
    // Keep HF/torch from trying to phone home when the cache is already warm.
    HF_HUB_OFFLINE: '0',
  };
}

/**
 * Run Demucs over the excerpt and return the two stems.
 *
 * @param {string} segmentWav
 * @param {number} seconds
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 */
async function separateStems(segmentWav, seconds, settings, log) {
  const base = segmentWav.replace(/\.wav$/i, '');
  const vocals = `${base}.vocals.wav`;
  const accompaniment = `${base}.accompaniment.wav`;
  if (cacheReady(vocals, 'stem', seconds) && cacheReady(accompaniment, 'stem', seconds)) {
    log('sing: stems cached');
    return { vocals, accompaniment };
  }
  const started = Date.now();
  await run(settings.python, [join(PYTHON_DIR, 'separate.py'), segmentWav, settings.demucsModel], {
    timeoutMs: settings.demucsTimeoutMs,
    what: 'Demucs 人声分离',
    env: pythonEnv(settings),
  });
  if (!cacheReady(vocals, 'stem', seconds) || !cacheReady(accompaniment, 'stem', seconds)) {
    throw new ToolError('人声分离没有产出有效音轨。');
  }
  log(`sing: stems ready in ${Math.round((Date.now() - started) / 1000)}s`);
  return { vocals, accompaniment };
}

/**
 * Pick the RVC model from settings (falls back to the first configured model).
 *
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @returns {{name: string, pth: string, index: string, targetF0: number}}
 */
export function resolveModel(settings) {
  const models = settings.models ?? {};
  const preferred = models[settings.modelName];
  if (preferred) return { name: settings.modelName, ...preferred };
  const first = Object.entries(models)[0];
  if (!first) throw new ToolError('插件没有配置 RVC 音色模型（models 为空）。');
  return { name: first[0], ...first[1] };
}

/**
 * Choose the RVC transpose: shift the source vocal's median F0 onto the target
 * voice's comfortable median. `autoPitch=false` pins the configured value.
 *
 * @param {string} vocalsPath
 * @param {{name: string, targetF0: number}} model
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 * @returns {Promise<number>}
 */
async function decidePitch(vocalsPath, model, settings, log) {
  if (settings.autoPitch === false) return settings.pitch;
  const resultFile = `${vocalsPath}.f0.txt`;
  try {
    const { stdout } = await run(settings.python, [join(PYTHON_DIR, 'f0.py'), vocalsPath, resultFile], {
      timeoutMs: 90_000,
      what: 'F0 检测',
      env: pythonEnv(settings),
    });
    const fromFile = readTextIfExists(resultFile);
    const raw = (fromFile ?? String(stdout).trim().split(/\s+/).pop() ?? '').trim();
    const f0 = Number.parseFloat(raw);
    if (!Number.isFinite(f0) || f0 < 60 || f0 > 800) {
      log(`sing: f0 unusable (${raw.slice(0, 40)}), keep pitch=${settings.pitch}`);
      return settings.pitch;
    }
    const semitones = Math.round(12 * Math.log2((model.targetF0 || 300) / f0));
    const chosen = clamp(semitones, -12, 12);
    log(`sing: f0=${f0.toFixed(1)}Hz target=${model.targetF0 || 300}Hz -> pitch=${chosen}`);
    return chosen;
  } catch (error) {
    log(`sing: f0 detection failed (${error instanceof Error ? error.message : String(error)}), keep pitch=${settings.pitch}`);
    return settings.pitch;
  }
}

/**
 * Convert the separated vocal into the target voice.
 *
 * @param {string} vocals
 * @param {string} workDir
 * @param {number} start
 * @param {number} seconds
 * @param {{name: string, pth: string, index: string}} model
 * @param {number} pitch
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 */
async function convertVocal(vocals, workDir, start, seconds, model, pitch, settings, log) {
  const target = join(workDir, `cover-${safeSegment(model.name)}-p${pitch}-${start}-${seconds}.wav`);
  if (cacheReady(target, 'cover', seconds)) {
    log('sing: converted vocal cached');
    return target;
  }
  const started = Date.now();
  await run(
    settings.python,
    [
      join(PYTHON_DIR, 'convert.py'),
      vocals,
      target,
      String(pitch),
      String(settings.indexRate),
      String(settings.timbre),
      String(settings.qfrency),
      String(settings.volumeEnvelope),
      String(settings.protect),
    ],
    {
      timeoutMs: settings.rvcTimeoutMs,
      what: 'RVC 音色转换',
      env: {
        ...pythonEnv(settings),
        RVC_ROOT: settings.rvcRoot,
        RVC_MODEL: model.pth,
        RVC_INDEX: model.index,
        APPLIO_DIR: settings.applioDir,
      },
    },
  );
  if (!cacheReady(target, 'cover', seconds)) throw new ToolError('音色转换没有产出有效音频。');
  log(`sing: converted in ${Math.round((Date.now() - started) / 1000)}s`);
  return target;
}

/**
 * @param {string} coverVocal
 * @param {string} accompaniment
 * @param {string} workDir
 * @param {number} start
 * @param {number} seconds
 * @param {string} modelName
 * @param {number} pitch
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 */
async function mix(coverVocal, accompaniment, workDir, start, seconds, modelName, pitch, settings) {
  const target = join(workDir, `mix-${safeSegment(modelName)}-p${pitch}-${start}-${seconds}.wav`);
  if (cacheReady(target, 'mix', seconds)) return target;
  await mixCover({
    ffmpeg: settings.ffmpeg,
    vocal: coverVocal,
    accompaniment,
    output: target,
    accompanimentGain: settings.accompanimentGain,
  });
  if (!cacheReady(target, 'mix', seconds)) throw new ToolError('混音没有产出有效音频。');
  return target;
}

/**
 * Render the untouched excerpt straight into SILK.
 *
 * @param {string} segmentWav
 * @param {string} workDir
 * @param {number} start
 * @param {number} seconds
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 */
async function renderOriginal(segmentWav, workDir, start, seconds, settings, log) {
  return await finalizePcm(segmentWav, workDir, start, seconds, 'original', settings, log);
}

/**
 * Downmix to 24 kHz mono and encode SILK.
 *
 * @param {string} audioInput
 * @param {string} workDir
 * @param {number} start
 * @param {number} seconds
 * @param {string} tag
 * @param {ReturnType<import('../index.mjs').resolveSettings>} settings
 * @param {(line: string) => void} log
 */
async function finalizePcm(audioInput, workDir, start, seconds, tag, settings, log) {
  const pcmPath = join(workDir, `voice-${safeSegment(tag)}-${start}-${seconds}.pcm`);
  if (!cacheReady(pcmPath, 'pcm', seconds)) {
    await toVoicePcm({ ffmpeg: settings.ffmpeg, input: audioInput, output: pcmPath });
  }
  const encoded = await encodeSilkFromPcm(pcmPath);
  // Also wrap the same PCM into an MP3: NapCat's QQ `record` message wants a
  // normal audio file and transcodes it itself, unlike the WeChat SILK path.
  const mp3Path = `${pcmPath}.mp3`;
  if (!cacheReady(mp3Path, 'mp3', seconds)) {
    await pcmToMp3({ ffmpeg: settings.ffmpeg, pcmPath, outPath: mp3Path });
  }
  log(`sing: silk ${encoded.silk.length} bytes, ${Math.round(encoded.durationMs / 100) / 10}s`);
  return { ...encoded, mp3Path };
}

/**
 * Pick the excerpt start: an explicit request wins, then QQ Music's own 30s
 * preview window (it is the hook the streaming service picked), then 40% into
 * the song (past the intro, usually the chorus).
 *
 * @param {{interval: number, tryBeginMs: number, tryEndMs: number}} song
 * @param {number} seconds
 * @param {number|undefined} requested
 * @returns {number}
 */
export function pickStartSeconds(song, seconds, requested) {
  const interval = Number(song?.interval) || 0;
  const clampToSong = (value) => {
    const max = interval > seconds ? interval - seconds : Math.max(0, interval - 1);
    return Math.max(0, Math.min(Math.round(value), max));
  };
  if (Number.isFinite(requested) && Number(requested) >= 0) return clampToSong(Number(requested));
  const tryBegin = (Number(song?.tryBeginMs) || 0) / 1000;
  const tryEnd = (Number(song?.tryEndMs) || 0) / 1000;
  if (tryBegin > 3 && tryEnd > tryBegin + 10) {
    const window = tryEnd - tryBegin;
    const start = tryBegin + Math.max(0, (window - seconds) / 2);
    return clampToSong(start);
  }
  if (interval > seconds + 20) return clampToSong(interval * 0.4);
  return 0;
}

/** @param {number} value @param {number} min @param {number} max */
function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** @param {string} text */
function safeSegment(text) {
  return String(text ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || 'x';
}

/** @param {string} path @returns {string|undefined} */
function readTextIfExists(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

export { existsSync };
