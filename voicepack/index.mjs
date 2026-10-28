/**
 * dsh-voicepack-plugin — a voice pack for the WeChat persona.
 *
 * The existing `send_voice` plugin speaks in one fixed voice. This plugin adds a
 * catalogue of Edge neural voices (including several new/common female voices
 * and a set of male voices) plus optional RVC timbre presets, and exposes:
 *
 *   voice_pack_list()                       -> the catalogue, grouped by gender
 *   send_voice_pack(text, voice?, rvc?, ...) -> a real WeChat voice bubble in
 *                                              that voice
 *
 * It reuses the same native hand-off as the voice plugin: Edge TTS -> SILK ->
 * the WeChatAgent hook's /SendVoiceMsg. RVC conversion is optional: when the
 * RVC tree/model is missing the raw Edge voice is used instead of failing.
 *
 * Host scope, no client half. Configuration lives in the profile patch insert.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { prepareVoiceChunks } from './src/text.mjs';
import { VoiceSynthError, synthesizeSpeech } from './src/speech.mjs';
import {
  DEFAULT_VOICE,
  formatVoiceList,
  resolveRvcPreset,
  resolveSelection,
  resolveVoice,
} from './src/voices.mjs';
import {
  readHookToken,
  resolveChatKey,
  resolveUsername,
  resolveWorkspace,
  storeSilk,
  submitVoice,
} from './src/wechat.mjs';

/** Cordis plugin name. */
export const name = 'dsh-voicepack';

/** Keep the plugin pending until the tool registry is mounted. */
export const inject = ['tools'];

const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const TOOL_LIST = 'voice_pack_list';
const TOOL_SEND = 'send_voice_pack';
const TOOL_NAMES = [TOOL_LIST, TOOL_SEND];

const DEFAULTS = {
  enabled: true,
  promptEnabled: true,
  /** WeChatAgent workspace (state/accounts + config/wechatagent.json). Empty = auto-detect. */
  workspace: '',
  /** WeChatAgent voice hook. */
  hookUrl: 'http://127.0.0.1:30001',
  /** Default Edge voice when the agent does not name one. */
  defaultVoice: DEFAULT_VOICE,
  /** Default Edge prosody overrides ("" = Edge default). */
  rate: '',
  pitch: '',
  maxCharsPerVoice: 120,
  maxVoicesPerCall: 3,
  /** Optional RVC timbre layer; safely skipped when the RVC tree is missing. */
  rvcEnabled: true,
  /** RVC install root (contains applio/core.py and venv312). Empty = auto-detect. */
  rvcRoot: '',
  python: '',
  rvcConverter: '',
  ffmpeg: '',
  /** Per-preset overrides: { paimon: { model, index, pitch, args, filter } }. */
  rvcPresets: {},
  promptText: '',
};

const PROMPT = [
  '语音包规则（微信聊天，仅在本轮工具列表里出现 send_voice_pack 时适用）：',
  '- 用户明确要换音色/指定音色说话时（例如“用男声说”“换个声音”“用云希的声音念”“用大肥鱼的声音说”），优先调用 send_voice_pack：voice 填音色名（如 云希/晓晓/东北话），rvc 填 RVC 音色（如 大肥鱼）。',
  '- 用户没有指定音色时，普通语音继续用 send_voice 即可，不要为了换音色而换音色。',
  '- 发语音要口语化、一句话：不要念代码、路径、链接、markdown。',
  '- 需要展示有哪些音色时，调用 voice_pack_list（可按 gender=male/female 过滤），再用一句话概括。',
].join('\n');

const SEND_DESCRIPTION =
  '用语音包里的指定音色说一段话：合成真实微信语音条发到当前微信聊天。' +
  'text 是要说出来的口语内容（建议 ≤120 字）；voice 可选 Edge 音色（如 云希/晓晓/晓伊/东北话，也可直接填 id）；' +
  'rvc 可选 RVC 音色层（如 大肥鱼=男声、派蒙=女声）。没指定 voice 时用默认音色。' +
  '只在用户明确要求换音色/指定音色说话时使用；普通发语音用 send_voice。';

const LIST_DESCRIPTION =
  '列出语音包里的全部音色：Edge 女声/男声/方言/粤语/台湾腔 + RVC 音色预设。可按 gender（female|male）、locale、tag 过滤。';

const SEND_PARAMETERS = {
  type: 'object',
  properties: {
    text: { type: 'string', description: '要念出来的口语内容，建议不超过 120 字。' },
    voice: { type: 'string', description: 'Edge 音色名或 id，例如 云希、晓晓、晓伊、东北话。可选。' },
    rvc: { type: 'string', description: 'RVC 音色预设，例如 大肥鱼（男声）、派蒙（女声）。可选。' },
    rate: { type: 'string', description: '语速，例如 +10% / -10%。可选。' },
    pitch: { type: 'string', description: '音高，例如 +40Hz / -20Hz。可选。' },
    maxChars: { type: 'integer', description: '每条语音最多字数，默认 120。可选。' },
  },
  required: ['text'],
  additionalProperties: false,
};

const LIST_PARAMETERS = {
  type: 'object',
  properties: {
    gender: { type: 'string', enum: ['female', 'male', 'all'], description: '只列某个性别的音色。' },
    locale: { type: 'string', description: '语言/地区过滤，例如 zh-CN、zh-HK。可选。' },
    tag: { type: 'string', description: '标签过滤，例如 方言、男声、常用男声。可选。' },
  },
  additionalProperties: false,
};

/** The generic host extension slot the social bridge reads. */
const EXTENSION_POLICY = Symbol.for('wechatagent.extension-tools.v1');
/** Marks the scoped registration so one agent scope registers only once. */
const SCOPED_TOOLS = Symbol.for('dsh.voicepack.scoped-tools.v1');
/** Guards the policy merge so the slot is only wrapped once. */
const POLICY_MERGED = Symbol.for('dsh.voicepack.policy-merged.v1');

/**
 * Root of the DeepSeek Harness home (`~/.dsh` unless DSH_HOME says otherwise).
 * @returns {string}
 */
function dshHome() {
  return String(process.env.DSH_HOME || join(homedir(), '.dsh'))
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
}

/** @param {unknown} value @returns {string} */
function slash(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
}

/**
 * Locate the RVC install (folder containing `applio/core.py`).
 * @param {string} configured
 * @returns {string}
 */
export function detectRvcRoot(configured) {
  const candidates = [
    slash(configured),
    slash(process.env.RVC_ROOT ?? ''),
    `${slash(homedir())}/rvc`,
    `${slash(homedir())}/Documents/rvc`,
    `${dshHome()}/rvc`,
  ].filter((item) => item !== '');
  for (const root of candidates) {
    if (existsSync(`${root}/applio/core.py`) || existsSync(`${root}/core.py`)) return root;
  }
  return slash(configured);
}

/** @param {string} rvcRoot @returns {string} */
export function detectPython(rvcRoot) {
  if (rvcRoot === '') return '';
  for (const rel of [
    'venv312/Scripts/python.exe',
    'venv/Scripts/python.exe',
    '.venv/Scripts/python.exe',
    'venv312/bin/python',
    'venv/bin/python',
    '.venv/bin/python',
  ]) {
    if (existsSync(`${rvcRoot}/${rel}`)) return `${rvcRoot}/${rel}`;
  }
  return `${rvcRoot}/venv312/Scripts/python.exe`;
}

/** @param {string} applioDir @returns {string} */
export function detectFfmpeg(applioDir) {
  if (applioDir === '') return '';
  for (const rel of ['ffmpeg.exe', 'bin/ffmpeg.exe', 'ffmpeg', 'bin/ffmpeg']) {
    if (existsSync(`${applioDir}/${rel}`)) return `${applioDir}/${rel}`;
  }
  return `${applioDir}/ffmpeg.exe`;
}

/**
 * Build the RVC stage config for one preset.
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {string|undefined} requested
 * @returns {{rvc: import('./src/speech.mjs').RvcConfig|null, preset: string|undefined, gender: string|undefined}}
 */
export function buildRvcStage(settings, requested) {
  if (!settings.rvcEnabled) return { rvc: null, preset: undefined, gender: undefined };
  const selection = resolveSelection({ rvc: requested });
  if (!selection.rvc) return { rvc: null, preset: undefined, gender: undefined };
  const preset = selection.rvc;
  const override = settings.rvcPresets?.[preset.name] ?? {};
  if (override.enabled === false) return { rvc: null, preset: preset.name, gender: undefined };
  if (settings.rvcRoot === '') return { rvc: null, preset: preset.name, gender: preset.gender };
  const model = slash(override.model ?? `${settings.rvcRoot}/${preset.modelPath}`);
  const index = slash(override.index ?? `${settings.rvcRoot}/${preset.indexPath}`);
  if (!existsSync(model) || !existsSync(index)) {
    return { rvc: null, preset: preset.name, gender: preset.gender };
  }
  return {
    rvc: {
      python: slash(override.python ?? settings.python),
      convertScript: slash(override.convertScript ?? settings.rvcConverter),
      ffmpeg: slash(override.ffmpeg ?? settings.ffmpeg),
      model,
      index,
      pitch: Number.isFinite(Number(override.pitch)) ? Number(override.pitch) : preset.pitch,
      args: Array.isArray(override.args) ? override.args.map(String) : preset.args,
      filter: typeof override.filter === 'string' ? override.filter : preset.filter,
      rvcRoot: settings.rvcRoot,
    },
    preset: preset.name,
    gender: preset.gender,
  };
}

/**
 * Merge the patch config over defaults.
 *
 * @param {Record<string, unknown>} config
 */
export function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const number = (value, fallback, min, max) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const rvcRoot = detectRvcRoot(text(raw.rvcRoot, DEFAULTS.rvcRoot));
  const applioDir = slash(text(raw.applioDir, rvcRoot === '' ? '' : `${rvcRoot}/applio`));
  const presets = raw.rvcPresets && typeof raw.rvcPresets === 'object' ? raw.rvcPresets : {};
  const voice = text(raw.defaultVoice, DEFAULT_VOICE);
  return {
    enabled: raw.enabled !== false,
    promptEnabled: raw.promptEnabled !== false,
    workspace: slash(text(raw.workspace, process.env.WECHATAGENT_WORKSPACE || DEFAULTS.workspace)),
    hookUrl: text(raw.hookUrl, DEFAULTS.hookUrl),
    defaultVoice: resolveVoice(voice)?.id ?? DEFAULT_VOICE,
    rate: text(raw.rate, DEFAULTS.rate),
    pitch: text(raw.pitch, DEFAULTS.pitch),
    maxCharsPerVoice: Math.round(number(raw.maxCharsPerVoice, DEFAULTS.maxCharsPerVoice, 12, 1000)),
    maxVoicesPerCall: Math.round(number(raw.maxVoicesPerCall, DEFAULTS.maxVoicesPerCall, 1, 5)),
    rvcEnabled: raw.rvcEnabled !== false,
    rvcRoot,
    python: slash(text(raw.python, detectPython(rvcRoot))),
    rvcConverter: slash(
      text(raw.rvcConverter, `${PLUGIN_ROOT}/python/rvc_convert.py`),
    ),
    ffmpeg: slash(text(raw.ffmpeg, detectFfmpeg(applioDir))),
    rvcPresets: presets,
    promptText: text(raw.promptText, PROMPT),
    defaultVoiceRequested: voice,
  };
}

/** @param {string} sessionId @param {ReturnType<typeof resolveSettings>} settings */
function inWechatChatSession(sessionId, settings) {
  if (typeof sessionId !== 'string' || sessionId === '') return false;
  if (sessionId.startsWith('social-')) return true;
  try {
    return resolveChatKey(sessionId, resolveWorkspace(settings.workspace)) !== undefined;
  } catch {
    return false;
  }
}

/** @param {unknown} agent @returns {string|undefined} */
function sessionIdOf(agent) {
  if (typeof agent !== 'object' || agent === null) return undefined;
  const candidate = agent.session?.id;
  return typeof candidate === 'string' ? candidate : undefined;
}

/** @param {unknown} scope @returns {string|undefined} */
function sessionIdFromScope(scope) {
  if (typeof scope !== 'object' || scope === null) return undefined;
  const candidate = scope.session?.id ?? scope.id;
  return typeof candidate === 'string' ? candidate : undefined;
}

/**
 * @param {object} context
 * @param {object} ctx
 * @returns {unknown[]}
 */
function promptTargets(context, ctx) {
  const targets = [];
  const push = (value) => {
    if (value && typeof value === 'object' && !targets.includes(value)) targets.push(value);
  };
  push(context?.scope?.ctx);
  push(context?.scope);
  push(context?.agent?.ctx);
  push(context?.agent);
  push(ctx);
  push(ctx?.root);
  push(ctx?.scope);
  return targets;
}

/**
 * Allow our tools inside one WeChatAgent chat's tool surface, merging into
 * whatever the voice plugin already put in the same slot.
 *
 * @param {unknown} scopeCtx
 * @param {string|undefined} sessionId
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {string} where
 * @returns {boolean}
 */
function attachExtensionPolicy(scopeCtx, sessionId, settings, log, where) {
  if (typeof scopeCtx !== 'object' || scopeCtx === null) return false;
  if (!inWechatChatSession(sessionId, settings)) return false;
  const ownDefinitions = () => [
    { name: TOOL_LIST, description: LIST_DESCRIPTION, parameters: structuredClone(LIST_PARAMETERS) },
    { name: TOOL_SEND, description: SEND_DESCRIPTION, parameters: structuredClone(SEND_PARAMETERS) },
  ];
  const existing = scopeCtx[EXTENSION_POLICY];
  try {
    if (existing === undefined) {
      Object.defineProperty(scopeCtx, EXTENSION_POLICY, {
        configurable: true,
        value: {
          names: () => [...TOOL_NAMES],
          check: (toolName) => TOOL_NAMES.includes(toolName),
          definitions: ownDefinitions,
        },
      });
    } else if (typeof existing === 'object' && existing !== null && existing[POLICY_MERGED] !== true) {
      const previousNames = existing.names?.bind(existing);
      const previousCheck = existing.check?.bind(existing);
      const previousDefinitions = existing.definitions?.bind(existing);
      existing.names = () => [...new Set([...(previousNames?.() ?? []), ...TOOL_NAMES])];
      existing.check = (toolName) => TOOL_NAMES.includes(toolName) || Boolean(previousCheck?.(toolName));
      existing.definitions = () => [...(previousDefinitions?.() ?? []), ...ownDefinitions()];
      Object.defineProperty(existing, POLICY_MERGED, { configurable: true, value: true });
    } else {
      return false;
    }
  } catch {
    return false;
  }
  log(`policy: voicepack tools allowed (${where}) session=${sessionId}`);
  return true;
}

/**
 * Register our tools on one agent scope's own registry, once.
 *
 * @param {unknown} scopeCtx
 * @param {Array<Record<string, any>>} definitions
 * @param {(line: string) => void} log
 */
function ensureScopedTools(scopeCtx, definitions, log) {
  if (typeof scopeCtx !== 'object' || scopeCtx === null) return;
  if (scopeCtx[SCOPED_TOOLS] !== undefined) return;
  const tools = scopeCtx.tools ?? scopeCtx.get?.('tools');
  if (!tools || typeof tools.register !== 'function') return;
  try {
    const disposers = definitions.map((definition) => tools.register(definition));
    Object.defineProperty(scopeCtx, SCOPED_TOOLS, { configurable: true, value: disposers });
    log('scoped: voicepack tools registered on agent tool registry');
  } catch {
    /* best-effort */
  }
}

/** @returns {Record<string, any>} */
function textOutput() {
  return {
    render: (value) => {
      if (typeof value === 'string') return value;
      if (value && typeof value.detail === 'string') return value.detail;
      return JSON.stringify(value ?? {}, null, 2);
    },
  };
}

/**
 * One `voice_pack_list` invocation.
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {Record<string, unknown>} args
 * @returns {Promise<string>}
 */
async function listToolCall(settings, log, args) {
  const gender = String(args?.gender ?? 'all').toLowerCase();
  const list = formatVoiceList({
    gender: ['female', 'male'].includes(gender) ? gender : 'all',
    locale: typeof args?.locale === 'string' ? args.locale : '',
    tag: typeof args?.tag === 'string' ? args.tag : '',
  });
  log(`list: gender=${gender} chars=${list.length}`);
  const rvcLine = settings.rvcEnabled
    ? settings.rvcRoot === ''
      ? 'RVC 音色层未启用：没找到 RVC 目录（配置 rvcRoot 或 RVC_ROOT 后可用 大肥鱼/派蒙 等音色）。'
      : `RVC 音色层可用（${settings.rvcRoot}）。`
    : 'RVC 音色层已在配置里关闭。';
  return `${list}\n当前默认音色：${settings.defaultVoiceRequested}。${rvcLine}`;
}

/**
 * One `send_voice_pack` invocation.
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {string} sessionId
 * @param {Record<string, unknown>} args
 * @param {{signal?: AbortSignal}} exec
 * @returns {Promise<string>}
 */
async function sendToolCall(settings, log, sessionId, args, exec) {
  const text = String(args?.text ?? '').trim();
  if (text === '') throw new Error('text 不能为空：要说什么？');
  const selection = resolveSelection({ voice: args?.voice, rvc: args?.rvc });
  const stage = buildRvcStage(settings, args?.rvc);
  const prepared = prepareVoiceChunks(text, {
    maxCharsPerVoice: Number.isFinite(Number(args?.maxChars))
      ? Math.max(12, Math.min(1000, Number(args.maxChars)))
      : settings.maxCharsPerVoice,
    maxVoicesPerCall: settings.maxVoicesPerCall,
  });
  if (prepared.chunks.length === 0) throw new Error('这段文字里没有可朗读的内容。');

  const workspace = resolveWorkspace(settings.workspace);
  const chat = resolveChatKey(sessionId, workspace);
  if (!chat) throw new Error('当前会话没有绑定微信聊天，发不了语音条。');
  const target = await resolveUsername(workspace, chat.chatKey, exec?.signal);
  const token = readHookToken(workspace);

  const rvcName = stage.rvc ? (resolveRvcPreset(args?.rvc)?.display ?? stage.preset) : '';
  log(
    `send: session=${sessionId} chat=${chat.chatKey} voice=${selection.voice.id} rvc=${rvcName || 'off'} chunks=${prepared.chunks.length}`,
  );

  let sent = 0;
  let totalMs = 0;
  const failures = [];
  for (const chunk of prepared.chunks) {
    try {
      const audio = await synthesizeSpeech(chunk, {
        voice: selection.voice.id,
        rate: typeof args?.rate === 'string' && args.rate !== '' ? args.rate : settings.rate,
        pitch: typeof args?.pitch === 'string' && args.pitch !== '' ? args.pitch : settings.pitch,
        rvc: stage.rvc,
      });
      const stored = storeSilk(workspace, audio.silk);
      await submitVoice(workspace, {
        hookUrl: settings.hookUrl,
        token,
        toUser: target.username,
        silkPath: stored.path,
        md5: stored.md5,
        durationMs: audio.durationMs,
      });
      sent += 1;
      totalMs += audio.durationMs;
      log(`send: chunk sent (${Math.round(audio.durationMs / 100) / 10}s, ${chunk.length} chars)`);
    } catch (error) {
      const message = error instanceof VoiceSynthError ? error.message : String(error?.message ?? error);
      failures.push(message);
      log(`send: chunk failed: ${message}`);
    }
  }
  if (sent === 0) {
    throw new Error(`语音没发出去：${failures[0] ?? '未知错误'}`);
  }
  const parts = [
    `用「${selection.voice.name}」${rvcName ? ` + ${rvcName}` : ''} 发了 ${sent} 条语音条`,
    `共 ${Math.round(totalMs / 100) / 10} 秒`,
  ];
  if (prepared.truncated) parts.push('文字太长，后面的没读');
  if (failures.length > 0) parts.push(`${failures.length} 段合成失败`);
  return parts.join('，');
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const log = createLogger();
  log(
    `apply: enabled=${settings.enabled} default=${settings.defaultVoice} rvc=${settings.rvcEnabled ? settings.rvcRoot || '(not found)' : 'off'}`,
  );
  if (!settings.enabled) {
    log('apply: disabled by config');
    return;
  }

  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    log('apply: tools service unavailable, nothing registered');
    return;
  }

  const definitions = [
    {
      name: TOOL_LIST,
      description: LIST_DESCRIPTION,
      parameters: structuredClone(LIST_PARAMETERS),
      output: textOutput(),
      execute: async (args) => ({ detail: await listToolCall(settings, log, args ?? {}) }),
    },
    {
      name: TOOL_SEND,
      description: SEND_DESCRIPTION,
      parameters: structuredClone(SEND_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => {
        const sessionId = sessionIdOf(exec?.agent);
        if (sessionId === undefined) throw new Error('定位不到当前会话，无法确定发给哪个微信聊天。');
        return { detail: await sendToolCall(settings, log, sessionId, args ?? {}, exec ?? {}) };
      },
    },
  ];
  const registerAll = () => {
    const disposers = definitions.map((definition) => tools.register(definition));
    log(`apply: registered ${definitions.map((item) => item.name).join(', ')}`);
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose?.();
        } catch {
          /* disposal must not throw */
        }
      }
    };
  };
  if (typeof ctx.effect === 'function') ctx.effect(registerAll);
  else registerAll();

  if (typeof ctx.on !== 'function') return;

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const sessionId = sessionIdOf(agent);
      for (const target of [agent?.ctx, agent]) {
        attachExtensionPolicy(target, sessionId, settings, log, 'pre-step');
        ensureScopedTools(target, definitions, log);
      }
    } catch {
      /* policy attachment must never break a turn */
    }
    return next();
  });

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const sessionId = sessionIdOf(context?.agent) ?? sessionIdFromScope(context?.scope);
    try {
      for (const target of promptTargets(context, ctx)) {
        attachExtensionPolicy(target, sessionId, settings, log, 'assemble');
        ensureScopedTools(target, definitions, log);
      }
    } catch {
      /* must never break assembly */
    }
    const assembled = await next();
    try {
      if (settings.promptEnabled && inWechatChatSession(sessionId, settings)) {
        assembled.sections?.push({ name: 'dsh-voicepack:rules', text: settings.promptText });
      }
    } catch {
      /* best-effort */
    }
    return assembled;
  });
}

/** @returns {(line: string) => void} */
function createLogger() {
  const file = join(dshHome(), 'voicepack', 'voicepack.log');
  return (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${text}\n`);
    } catch {
      /* logging must never break a send */
    }
  };
}
