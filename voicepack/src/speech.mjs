/**
 * Speech synthesis for the voice pack.
 *
 * Chain: Edge neural TTS (MP3) -> optional RVC timbre conversion (MP3) -> PCM
 * s16le 24 kHz -> SILK, which is the only container WeChat's native voice
 * bubble accepts.
 *
 * All RVC paths come from the caller (settings), never from module-level
 * personal defaults, so the same module runs on another machine.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MsEdgeTTS } from 'msedge-tts';
import { MPEGDecoder } from 'mpg123-decoder';
import * as silk from 'silk-wasm';

import { DEFAULT_VOICE } from './voices.mjs';

/** WeChat's voice sample rate; the client draws the duration from `playtime`. */
export const SILK_SAMPLE_RATE = 24_000;
/** Edge read-aloud formats this client supports; only 24 kHz mono MP3 is useful. */
const EDGE_OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

/** A synthesis failure with a message meant for the agent. */
export class VoiceSynthError extends Error {
  /** @param {string} message @param {string} [detail] */
  constructor(message, detail) {
    super(message);
    this.name = 'VoiceSynthError';
    this.detail = detail;
  }
}

/**
 * @typedef {object} RvcConfig
 * @property {string} python         RVC virtualenv python.
 * @property {string} convertScript  rvc_convert.py path.
 * @property {string} ffmpeg         ffmpeg binary.
 * @property {string} model          .pth path.
 * @property {string} index          .index path.
 * @property {number} [pitch]        Semitones.
 * @property {string[]} [args]       Extra RVC args (indexRate, timbre, qfrency, volume, protect).
 * @property {string} [filter]       Optional ffmpeg EQ/master chain.
 * @property {string} [rvcRoot]      RVC root (passed as RVC_ROOT env).
 */

/**
 * Convert an Edge TTS MP3 buffer into a different RVC timbre.
 * Returns a new MP3 buffer, or null when the profile is unavailable.
 *
 * @param {Buffer} mp3
 * @param {RvcConfig} rvc
 * @returns {Buffer|null}
 */
function convertWithRvc(mp3, rvc) {
  if (!rvc) return null;
  const required = [rvc.python, rvc.convertScript, rvc.ffmpeg, rvc.model, rvc.index];
  if (!required.every((path) => typeof path === 'string' && path !== '' && existsSync(path))) return null;
  const dir = join(tmpdir(), 'dsh-voicepack-rvc');
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const inputMp3 = join(dir, `in-${stamp}.mp3`);
  const inputWav = join(dir, `in-${stamp}.wav`);
  const convertedWav = join(dir, `out-${stamp}.wav`);
  const outputMp3 = join(dir, `out-${stamp}.mp3`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(inputMp3, mp3);
    const toWav = spawnSync(rvc.ffmpeg, ['-y', '-i', inputMp3, '-ar', '16000', '-ac', '1', inputWav], {
      timeout: 30_000,
      windowsHide: true,
    });
    if (toWav.status !== 0 || !existsSync(inputWav)) return null;
    const args = [
      rvc.convertScript,
      inputWav,
      convertedWav,
      String(Number.isFinite(Number(rvc.pitch)) ? Math.round(Number(rvc.pitch)) : 0),
      ...(Array.isArray(rvc.args) ? rvc.args.map(String) : []),
    ];
    const convert = spawnSync(rvc.python, args, {
      timeout: 180_000,
      windowsHide: true,
      env: {
        ...process.env,
        RVC_ROOT: rvc.rvcRoot || '',
        APPLIO_DIR: rvc.rvcRoot ? `${rvc.rvcRoot.replace(/\\/g, '/')}/applio` : '',
        RVC_MODEL: rvc.model,
        RVC_INDEX: rvc.index,
      },
    });
    if (convert.status !== 0 || !existsSync(convertedWav)) return null;
    const eqArgs = ['-y', '-i', convertedWav];
    if (typeof rvc.filter === 'string' && rvc.filter !== '') eqArgs.push('-af', rvc.filter);
    eqArgs.push('-ar', '44100', '-b:a', '128k', outputMp3);
    const eq = spawnSync(rvc.ffmpeg, eqArgs, { timeout: 60_000, windowsHide: true });
    if (eq.status !== 0 || !existsSync(outputMp3)) return null;
    const buffer = readFileSync(outputMp3);
    return buffer.length > 1000 ? buffer : null;
  } catch {
    return null;
  } finally {
    for (const path of [inputMp3, inputWav, convertedWav, outputMp3]) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Synthesize one spoken chunk and encode it as SILK.
 *
 * @param {string} text
 * @param {{voice?: string, rate?: string, pitch?: string, rvc?: RvcConfig|null}} [options]
 * @returns {Promise<{silk: Buffer, durationMs: number, sampleRate: number, mp3: Buffer}>}
 */
export async function synthesizeSpeech(text, options = {}) {
  const spoken = String(text ?? '').trim();
  if (spoken === '') throw new VoiceSynthError('要合成的文字是空的。');
  const voice = typeof options.voice === 'string' && options.voice !== '' ? options.voice : DEFAULT_VOICE;

  // The Edge read-aloud endpoint occasionally closes a stream mid-synthesis
  // (especially when several voices are exercised in a row). Retry transient
  // failures once before surfacing the error; a genuine "voice does not exist"
  // error fails the same way twice and is reported as such.
  let buffered;
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 12_000, synthesisTimeoutMs: 60_000 });
    try {
      await tts.setMetadata(voice, EDGE_OUTPUT_FORMAT);
      const { audioStream } = tts.toStream(spoken, {
        ...(typeof options.rate === 'string' && options.rate !== '' ? { rate: options.rate } : {}),
        ...(typeof options.pitch === 'string' && options.pitch !== '' ? { pitch: options.pitch } : {}),
      });
      const chunks = [];
      for await (const chunk of audioStream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      buffered = Buffer.concat(chunks);
      if (buffered.length > 0) break;
      lastError = new Error('empty audio stream');
    } catch (error) {
      lastError = error;
      if (attempt < 2 && !isTransientTtsError(error)) break;
    } finally {
      try {
        tts.close();
      } catch {
        /* closing a half-open socket must not mask the real failure */
      }
    }
    if (attempt < 2) await delay(700);
  }
  if (!buffered || buffered.length === 0) {
    throw new VoiceSynthError(
      `语音合成失败（Edge TTS，音色 ${voice}）：${messageOf(lastError)}`,
      messageOf(lastError),
    );
  }

  // Optional RVC timbre layer. Falling back to the raw TTS voice is better than
  // failing the whole utterance, so a missing/broken RVC profile is non-fatal.
  const profiled = convertWithRvc(buffered, options.rvc) ?? buffered;
  const pcm = await decodeMp3ToPcm(profiled, SILK_SAMPLE_RATE);
  let encoded;
  try {
    encoded = await silk.encode(pcm, SILK_SAMPLE_RATE);
  } catch (error) {
    throw new VoiceSynthError(`语音编码失败（SILK）：${messageOf(error)}`, messageOf(error));
  }
  if (!encoded || !encoded.data || encoded.data.length === 0) {
    throw new VoiceSynthError('语音编码返回空数据，稍后再试。');
  }
  return {
    mp3: profiled,
    silk: Buffer.from(encoded.data),
    durationMs: Number(encoded.duration) || 0,
    sampleRate: SILK_SAMPLE_RATE,
  };
}

/**
 * Whether an Edge TTS error is worth retrying (network/stream, not bad voice id).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientTtsError(error) {
  const message = messageOf(error).toLowerCase();
  return (
    message.includes('stream closed') ||
    message.includes('turn.end') ||
    message.includes('socket') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('network')
  );
}

/** @param {number} ms */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Decode an MP3 buffer to mono s16le PCM at the requested sample rate.
 *
 * @param {Buffer} mp3
 * @param {number} targetRate
 * @returns {Promise<Buffer>}
 */
async function decodeMp3ToPcm(mp3, targetRate) {
  const decoder = new MPEGDecoder();
  let decoded;
  try {
    await decoder.ready;
    decoded = decoder.decode(new Uint8Array(mp3));
  } catch (error) {
    throw new VoiceSynthError(`语音 MP3 解码失败：${messageOf(error)}`, messageOf(error));
  } finally {
    try {
      decoder.free();
    } catch {
      /* ignore */
    }
  }
  const frames = decoded && Array.isArray(decoded.channelData) ? decoded.channelData : [];
  if (frames.length === 0) throw new VoiceSynthError('语音解码没有产生音频数据。');
  const sampleRate = Number(decoded.sampleRate) || SILK_SAMPLE_RATE;

  let mono = frames[0];
  if (frames.length > 1) {
    const mixed = new Float32Array(mono.length);
    for (let channel = 0; channel < frames.length; channel += 1) {
      const data = frames[channel];
      for (let i = 0; i < mono.length; i += 1) mixed[i] += data[i] / frames.length;
    }
    mono = mixed;
  }

  let pcm = new Int16Array(mono.length);
  for (let i = 0; i < mono.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, mono[i]));
    pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  if (sampleRate !== targetRate) {
    const ratio = targetRate / sampleRate;
    const outLength = Math.max(1, Math.floor(pcm.length * ratio));
    const resampled = new Int16Array(outLength);
    for (let i = 0; i < outLength; i += 1) {
      const position = i / ratio;
      const left = Math.floor(position);
      const right = Math.min(left + 1, pcm.length - 1);
      const fraction = position - left;
      resampled[i] = Math.round(pcm[left] * (1 - fraction) + pcm[right] * fraction);
    }
    pcm = resampled;
  }
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
