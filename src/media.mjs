/**
 * Subprocess helpers: ffmpeg/ffprobe and the RVC Python venv.
 *
 * Both are external tools the plugin only *drives*. Every call gets a timeout
 * and a hard failure with the tail of stderr, because "it produced no output"
 * is otherwise indistinguishable from "it crashed".
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { messageOf } from './log.mjs';

/** A failed external command whose message is meant for the agent. */
export class ToolError extends Error {
  /** @param {string} message @param {string} [detail] */
  constructor(message, detail) {
    super(message);
    this.name = 'ToolError';
    this.detail = detail;
  }
}

/**
 * Run one external command, resolving on exit code 0.
 *
 * `capture:false` (or QQMUSIC_SPAWN_INHERIT=1) inherits stdio instead of piping
 * it. The plugin itself always captions the output, but a *sandboxed* caller
 * (the dev shell) cannot create the pipes child_process needs, so the live-test
 * CLI flips this switch to stay runnable there.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string, env?: Record<string, string>, what?: string, capture?: boolean}} [options]
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
export function run(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const what = options.what ?? `${command} ${args[0] ?? ''}`.trim();
  const capture = options.capture ?? process.env.QQMUSIC_SPAWN_INHERIT !== '1';
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'inherit', 'inherit'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new ToolError(`${what} 超时（${Math.round(timeoutMs / 1000)} 秒）`, stdout + stderr));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new ToolError(`${what} 启动失败：${messageOf(error)}`, String(error)));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ToolError(`${what} 失败（退出码 ${code}）`, (stderr || stdout).slice(-1200)));
    });
  });
}

/**
 * Make sure a configured tool path exists.
 *
 * @param {string} what
 * @param {string} path
 * @returns {string}
 */
export function requirePath(what, path) {
  if (!existsSync(path)) throw new ToolError(`找不到${what}：${path}（检查插件配置）`);
  return path;
}

/**
 * Cut `[startSeconds, startSeconds+seconds)` out of an audio file as 44.1 kHz
 * stereo PCM WAV — the input format Demucs/RVC expect.
 *
 * `-ss` after `-i` is sample-accurate; the seek is cheap enough for a 5 min mp3.
 *
 * @param {{ffmpeg: string, input: string, output: string, startSeconds: number, seconds: number, timeoutMs?: number}} params
 * @returns {Promise<void>}
 */
export async function cutSegment(params) {
  await run(
    params.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      params.input,
      '-ss',
      String(Math.max(0, params.startSeconds)),
      '-t',
      String(Math.max(1, params.seconds)),
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      params.output,
    ],
    { timeoutMs: params.timeoutMs ?? 90_000, what: 'ffmpeg 截取片段' },
  );
}

/**
 * Mix the converted vocal back with the accompaniment and master it gently.
 * The EQ/compressor chain is the one the earlier RVC tuning settled on: it takes
 * the harsh edge off the converted voice without killing the vocal.
 *
 * @param {{ffmpeg: string, vocal: string, accompaniment: string, output: string, accompanimentGain?: number, timeoutMs?: number}} params
 * @returns {Promise<void>}
 */
export async function mixCover(params) {
  const gain = Number.isFinite(params.accompanimentGain) ? params.accompanimentGain : 0.45;
  // aresample/aformat first: the RVC vocal is mono 40 kHz while the Demucs
  // accompaniment is stereo 44.1 kHz, and amix refuses mismatched inputs.
  // The centering/normalize option of amix is not available in every ffmpeg
  // build shipped with Applio, so rely on amix's own equal-gain normalisation and
  // let loudnorm restore the level.
  const filter =
    `[0:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=1.0[voc];` +
    `[1:a]aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${gain}[acc];` +
    '[voc][acc]amix=inputs=2:duration=longest[mix];' +
    '[mix]highpass=f=40,equalizer=f=3000:t=q:w=1.2:g=-2,' +
    'acompressor=threshold=-20dB:ratio=2:attack=20:release=200,' +
    'loudnorm=I=-15:TP=-1.5:LRA=11[out]';
  await run(
    params.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      params.vocal,
      '-i',
      params.accompaniment,
      '-filter_complex',
      filter,
      '-map',
      '[out]',
      '-ar',
      '44100',
      '-ac',
      '2',
      '-c:a',
      'pcm_s16le',
      params.output,
    ],
    { timeoutMs: params.timeoutMs ?? 120_000, what: 'ffmpeg 混音' },
  );
}

/**
 * Render any audio file down to the mono 24 kHz s16le PCM WeChat SILK wants.
 *
 * `-f s16le` writes header-less PCM, so the caller can hand the bytes straight
 * to the SILK encoder without parsing a WAV container.
 *
 * @param {{ffmpeg: string, input: string, output: string, gainDb?: number, timeoutMs?: number}} params
 * @returns {Promise<void>}
 */
export async function toVoicePcm(params) {
  const filters = [];
  if (Number.isFinite(params.gainDb) && params.gainDb !== 0) {
    filters.push(`volume=${params.gainDb}dB`);
  }
  filters.push('highpass=f=50');
  await run(
    params.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      params.input,
      '-af',
      filters.join(','),
      '-ac',
      '1',
      '-ar',
      '24000',
      '-f',
      's16le',
      '-acodec',
      'pcm_s16le',
      params.output,
    ],
    { timeoutMs: params.timeoutMs ?? 120_000, what: 'ffmpeg 转语音 PCM' },
  );
}

/**
 * Slim cover art / duration probe used for the tool summary only.
 *
 * @param {{ffprobe: string, input: string}} params
 * @returns {Promise<number>} duration in seconds (0 if unknown)
 */
export async function probeDurationSeconds(params) {
  try {
    const { stdout } = await run(
      params.ffprobe,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nokey=1:noprint_wrappers=1', params.input],
      { timeoutMs: 20_000, what: 'ffprobe 读取时长' },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? seconds : 0;
  } catch {
    return 0;
  }
}

/**
 * Wrap header-less s16le PCM into an MP3 file.
 *
 * QQ voice bubbles are next to impossible to hand to third-party bots directly:
 * the WeChat side wants SILK, while NapCat's `record` message wants a normal
 * audio file it can transcode itself. One render therefore produces both — the
 * PCM step is the same, only the container differs.
 *
 * @param {{ffmpeg: string, pcmPath: string, outPath: string, sampleRate?: number, channels?: number, bitrate?: string, timeoutMs?: number}} params
 * @returns {Promise<void>}
 */
export async function pcmToMp3(params) {
  const sampleRate = Number(params.sampleRate) || 24_000;
  const channels = Number(params.channels) || 1;
  await run(
    params.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      String(sampleRate),
      '-ac',
      String(channels),
      '-i',
      params.pcmPath,
      '-c:a',
      'libmp3lame',
      '-b:a',
      params.bitrate ?? '96k',
      params.outPath,
    ],
    { timeoutMs: params.timeoutMs ?? 60_000, what: 'ffmpeg PCM转MP3' },
  );
}
