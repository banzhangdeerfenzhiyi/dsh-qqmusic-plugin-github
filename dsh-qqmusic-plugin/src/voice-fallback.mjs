/**
 * TTS voice fallback for "I can't sing that one".
 *
 * The plugin does not vendor a TTS stack: the sibling `dsh-wechatagent-voice`
 * plugin already ships Edge TTS + SILK and is loaded in every WeChat persona
 * chat, so we borrow its `synthesizeSpeech` when it is installed. A missing
 * plugin only costs the apology voice, never the main feature.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { messageOf } from './log.mjs';
import { readHookToken, storeSilk, submitVoice } from './wechat.mjs';

/**
 * Load `synthesizeSpeech` from the sibling voice plugin.
 *
 * @param {string} pluginDir
 * @returns {Promise<((text: string, options?: Record<string, unknown>) => Promise<{silk: Buffer, durationMs: number}>) | undefined>}
 */
async function loadSynthesize(pluginDir) {
  if (typeof pluginDir !== 'string' || pluginDir === '') return undefined;
  const modulePath = join(pluginDir, 'src', 'voice.mjs');
  if (!existsSync(modulePath)) return undefined;
  try {
    const module = await import(pathToFileURL(modulePath).href);
    return typeof module.synthesizeSpeech === 'function' ? module.synthesizeSpeech : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Speak one line as a native WeChat voice message in the chat bound to the
 * session. Best effort: returns a status for the tool result.
 *
 * @param {{sessionId: string, toUser: string, text: string, settings: ReturnType<import('../index.mjs').resolveSettings>, log: (line: string) => void, signal?: AbortSignal}} params
 * @returns {Promise<{sent: boolean, reason?: string}>}
 */
export async function sendFallbackVoice(params) {
  const { settings, log } = params;
  if (settings.voiceFallbackEnabled === false) return { sent: false, reason: 'disabled' };
  const synthesize = await loadSynthesize(settings.voicePluginDir);
  if (!synthesize) {
    log('voice-fallback: sibling voice plugin not found, skipping apology voice');
    return { sent: false, reason: 'voice plugin missing' };
  }
  const text = String(params.text ?? '').trim();
  if (text === '') return { sent: false, reason: 'empty text' };
  try {
    const audio = await synthesize(text, {
      voice: settings.voiceName,
      rate: settings.voiceRate,
      pitch: settings.voicePitch,
    });
    const workspace = settings.workspace;
    const stored = storeSilk(workspace, audio.silk);
    await submitVoice({
      hookUrl: settings.hookUrl,
      token: readHookToken(workspace),
      toUser: params.toUser,
      silkPath: stored.path,
      md5: stored.md5,
      durationMs: audio.durationMs,
      ...(params.signal === undefined ? {} : { signal: params.signal }),
    });
    log(`voice-fallback: spoke ${text.length} chars to ${params.toUser}`);
    return { sent: true };
  } catch (error) {
    log(`voice-fallback: failed: ${messageOf(error)}`);
    return { sent: false, reason: messageOf(error) };
  }
}
