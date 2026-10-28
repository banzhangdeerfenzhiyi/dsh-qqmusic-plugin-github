/**
 * PCM -> Tencent SILK encoding for WeChat voice bubbles.
 *
 * WeChat voice messages carry SILK at 24 kHz mono; `silk-wasm` is the Tencent
 * encoder compiled to WASM, so this runs in-process with no ffmpeg involved.
 */
import { readFileSync } from 'node:fs';
import * as silk from 'silk-wasm';
import { ToolError } from './media.mjs';

/** WeChat's own voice sample rate. */
export const SILK_SAMPLE_RATE = 24_000;

/**
 * Encode a header-less s16le 24 kHz mono PCM file as SILK.
 *
 * @param {string} pcmPath
 * @returns {Promise<{silk: Buffer, durationMs: number, sampleRate: number}>}
 */
export async function encodeSilkFromPcm(pcmPath) {
  const pcm = readFileSync(pcmPath);
  if (pcm.length < 2) throw new ToolError('语音 PCM 是空的，合成没产出声音。');
  let encoded;
  try {
    encoded = await silk.encode(pcm, SILK_SAMPLE_RATE);
  } catch (error) {
    throw new ToolError(`SILK 编码失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!encoded || !encoded.data || encoded.data.length === 0) {
    throw new ToolError('SILK 编码返回空数据。');
  }
  return {
    silk: Buffer.from(encoded.data),
    durationMs: Number(encoded.duration) || 0,
    sampleRate: SILK_SAMPLE_RATE,
  };
}
