/**
 * dsh-qqmusic-plugin — QQ Music + AI singing for the WeChat persona.
 *
 * Registers two host tools:
 *
 *   qq_music_search(keyword)                       -> candidate list
 *   sing_song(keyword, mode, seconds, start)       -> a real WeChat voice bubble
 *
 * `sing_song` renders an excerpt of a QQ Music track and gives it her voice:
 * Demucs splits the excerpt into vocals/accompaniment, RVC converts the vocal
 * into the configured voice model, the two are mixed, and the result is encoded
 * to SILK and handed to the local WeChat hook as a native voice message.
 *
 * Host scope, no client half. Configuration comes from the insert entry in the
 * profile's cordis.patch.yml (see README / tools/install.mjs).
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAutoSingHandler } from './src/autosing.mjs';
import { createLogger, messageOf } from './src/log.mjs';
import { defaultCookieFile, readAuth } from './src/qqauth.mjs';
import { searchSongs } from './src/qqmusic.mjs';
import { renderSinging, resolveModel } from './src/singing.mjs';
import { resolveSessionTarget, resolveChatKey, resolveWorkspace, sendSingingVoice } from './src/wechat.mjs';
import { sendFallbackVoice } from './src/voice-fallback.mjs';

/** Cordis plugin name. */
export const name = 'dsh-qqmusic';

/** Keep the plugin pending until the tool registry is mounted. */
export const inject = ['tools'];

const TOOL_SEARCH = 'qq_music_search';
const TOOL_SING = 'sing_song';
const TOOL_NAMES = [TOOL_SEARCH, TOOL_SING];

/**
 * Root of the DeepSeek Harness home (`~/.dsh` unless DSH_HOME overrides it).
 *
 * @returns {string}
 */
function dshHome() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return String(home).replace(/\\/g, '/').replace(/\/$/, '');
}

/** @param {unknown} value @returns {string} */
function slashPath(value) {
  return String(value ?? '')
    .replace(/\\/g, '/')
    .replace(/\/$/, '');
}

/**
 * Locate the RVC installation: the directory that contains `applio/core.py`.
 * Order: explicit config → `RVC_ROOT` env → `~/rvc` → `~/Documents/rvc`.
 * Anything else can still be set explicitly in the plugin config.
 *
 * @param {string} configured
 * @returns {string}
 */
export function detectRvcRoot(configured) {
  const candidates = [
    slashPath(configured),
    slashPath(process.env.RVC_ROOT ?? ''),
    `${slashPath(homedir())}/rvc`,
    `${slashPath(homedir())}/Documents/rvc`,
    `${dshHome()}/rvc`,
  ].filter((item) => item !== '');
  for (const root of candidates) {
    if (existsSync(`${root}/applio/core.py`) || existsSync(`${root}/core.py`)) return root;
  }
  return slashPath(configured);
}

/**
 * Pick the RVC virtualenv interpreter by trying the usual layout names.
 *
 * @param {string} rvcRoot
 * @returns {string}
 */
export function detectPython(rvcRoot) {
  if (rvcRoot === '') return '';
  const candidates = [
    'venv312/Scripts/python.exe',
    'venv/Scripts/python.exe',
    '.venv/Scripts/python.exe',
    'venv312/bin/python',
    'venv/bin/python',
    '.venv/bin/python',
  ];
  for (const rel of candidates) {
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

/** @param {string} applioDir @returns {string} */
export function detectFfprobe(applioDir) {
  if (applioDir === '') return '';
  for (const rel of ['ffprobe.exe', 'bin/ffprobe.exe', 'ffprobe', 'bin/ffprobe']) {
    if (existsSync(`${applioDir}/${rel}`)) return `${applioDir}/${rel}`;
  }
  return `${applioDir}/ffprobe.exe`;
}

/**
 * Where the sibling WeChat voice plugin lives. Only used for the spoken
 * "I don't know that song" fallback, so a missing plugin is not fatal.
 *
 * @returns {string}
 */
export function detectVoicePluginDir() {
  const env = slashPath(process.env.QQMUSIC_VOICE_PLUGIN_DIR ?? '');
  if (env !== '') return env;
  const candidates = [
    `${dshHome()}/dsh-wechatagent-voice-plugin`,
    `${dshHome()}/dsh-wechat-voice-plugin`,
  ];
  for (const dir of candidates) {
    if (existsSync(`${dir}/src/voice.mjs`)) return dir;
  }
  return `${dshHome()}/dsh-wechatagent-voice-plugin`;
}

const DEFAULTS = {
  enabled: true,
  promptEnabled: true,
  /** RVC install root: models/, applio/, venv312/ live here. Empty = auto-detect. */
  rvcRoot: '',
  /** Python interpreter of the RVC virtualenv (Demucs + Applio deps). Empty = derive from rvcRoot. */
  python: '',
  /** Directory containing Applio's core.py. Empty = <rvcRoot>/applio. */
  applioDir: '',
  /** ffmpeg / ffprobe used for cutting, mixing and resampling. Empty = <applioDir>/ffmpeg(.exe). */
  ffmpeg: '',
  ffprobe: '',
  /** RVC voice model name; must exist in `models`. */
  model: 'Paimon',
  /** Extra / override models: { Name: { pth, index, targetF0 } }. */
  models: null,
  /** Pitch shift in semitones, used when autoPitch is off or F0 detection fails. */
  pitch: 9,
  /** Shift each song's vocal onto the target voice's median F0 automatically. */
  autoPitch: true,
  indexRate: 0.45,
  protect: 0.5,
  timbre: 1.0,
  qfrency: 15,
  volumeEnvelope: 1.0,
  /** Accompaniment level relative to the converted vocal. */
  accompanimentGain: 0.45,
  demucsModel: 'htdemucs',
  defaultSeconds: 30,
  maxSeconds: 45,
  searchLimit: 12,
  maxCandidates: 6,
  /** Below this title-match score the plugin answers "I don't know that song". */
  minMatchScore: 30,
  /** Disk cache; one directory per QQ Music songmid. Empty = <rvcRoot>/songs/qqmusic. */
  workDir: '',
  /** WeChatAgent local hook and its workspace (accounts / session map / token). */
  hookUrl: 'http://127.0.0.1:30001',
  /**
   * WeChatAgent workspace root: must contain `state/accounts` and
   * `config/wechatagent.json`. Empty = `WECHATAGENT_WORKSPACE` env or fail loudly.
   */
  workspace: '',
  /** If the cover stages fail, still send the untouched excerpt. */
  fallbackToOriginal: true,
  demucsTimeoutMs: 240_000,
  rvcTimeoutMs: 420_000,
  /** QQ Music account cookie (written by tools/qq-login.mjs); unlocks VIP songs. */
  authEnabled: true,
  cookieFile: '',
  /** Sibling voice plugin used for the spoken "I don't know that song" fallback. Empty = auto-detect. */
  voiceFallbackEnabled: true,
  voicePluginDir: '',
  notFoundVoiceText: '我不知道你说的歌怎么唱哦',
  voiceName: 'zh-CN-XiaoyiNeural',
  voiceRate: '+10%',
  voicePitch: '+40Hz',
  /**
   * Guarantee mode: if a relayed chat message asks for a song but the model's
   * finished turn never called sing_song, the plugin sings it itself. Long-lived
   * group sessions otherwise keep repeating their old "can't sing here" habit.
   */
  autoSingEnabled: true,
  autoSingCooldownMs: 90_000,
  promptText: '',
};

const SING_DESCRIPTION =
  '点歌/唱歌：真的唱出来——从 QQ 音乐找歌，用她的 AI 音色翻唱一小段（默认 30 秒），' +
  '以真实微信语音条发到当前微信聊天。只要用户话里出现“唱”+一个歌名（例如“唱首起风了”“给我唱一段稻香”“你会唱七里香吗”），就调用它。' +
  'keyword 填歌名或“歌手 歌名”；mode：cover=她翻唱（默认）、original=放原声片段（最快）、acapella=清唱；' +
  'seconds 是片段秒数（8~45，默认 30），start 是从第几秒开始（可选）。' +
  '已接入 QQ 音乐会员账号，会员歌也能唱；如果真找不到这首歌，插件会自动用语音说“我不知道你说的歌怎么唱哦”，你只回一句简短文字即可。一次调用约 30~90 秒。';

const SING_PARAMETERS = {
  type: 'object',
  properties: {
    keyword: {
      type: 'string',
      description: '歌名，或“歌手 歌名”，例如「起风了」「周杰伦 稻香」。',
    },
    mode: {
      type: 'string',
      enum: ['cover', 'original', 'acapella'],
      description: 'cover=她的声音翻唱（默认），original=原声片段，acapella=她的声音清唱。',
    },
    seconds: {
      type: 'integer',
      minimum: 8,
      maximum: 45,
      description: '唱多少秒，默认 30。',
    },
    start: {
      type: 'integer',
      minimum: 0,
      description: '从歌曲第几秒开始截取（不填则由插件挑副歌附近）。',
    },
  },
  required: ['keyword'],
  additionalProperties: false,
};

const SEARCH_DESCRIPTION =
  '在 QQ 音乐搜索歌曲，返回候选（歌名、歌手、时长、是否免费可播）。' +
  '不确定点哪首时用它；能直接点歌时不必搜。已登录会员账号，会员歌也能播。';

const SEARCH_PARAMETERS = {
  type: 'object',
  properties: {
    keyword: { type: 'string', description: '搜索词：歌名或“歌手 歌名”。' },
    limit: { type: 'integer', minimum: 1, maximum: 10, description: '返回几条，默认 5。' },
  },
  required: ['keyword'],
  additionalProperties: false,
};

const DEFAULT_PROMPT = [
  '唱歌规则：你有真的唱歌能力——调用 sing_song 会从 QQ 音乐找歌、用她的 AI 音色翻唱一小段（默认 30 秒），以真实微信语音条发出去。',
  '- 触发范围很宽：用户消息里只要同时有「唱」这个字和一个歌名，就直接调用 sing_song 开始唱。例如“唱首起风了”“给我唱一段稻香”“你会唱七里香吗”“来一个晴天听听”“唱个孤勇者”，都算。不用等他说“点歌/发语音/用语音唱”。',
  '- 重要：私聊、群聊、大群都能唱、都能发语音条，不存在“群里唱不了/大群发不了语音”这回事。如果历史记录里出现过这种说法，那是旧版本的限制，现在作废；被点名要唱就必须调用 sing_song。',
  '- 唱完再简短回一句话，不要说“我不会唱 / 没有工具 / 群里唱不了 / 只能哼两句 / 你自己去听原唱”。',
  '- mode 默认 cover（她翻唱）；用户说“放一段××/听原唱”用 original；“清唱”用 acapella。',
  '- 片段默认 30 秒（8~45 秒）：用户说“唱两句”就给 10~15 秒，说“唱一整段/多唱点”给 40~45 秒。',
  '- 歌名拿不准就直接用他说的词去唱；如果 QQ 音乐里确实找不到这首歌，插件会自动用语音说“我不知道你说的歌怎么唱哦”，这时你只回一句简短文字，不要再重复道歉或再发语音。',
  '- 已经接了 QQ 音乐会员账号，会员歌也能唱，不用换成免费版。',
  '- 用时约 30~90 秒：可以先回一句“等我一下，马上唱给你听”，但不要因为慢就不调用。',
  '- 万一你漏了调用，宿主会自动替你把这首歌唱出来并发语音条；但你是第一责任人，不要依赖兜底。',
  '- 群聊里被点到再唱，别刷屏；一轮最多唱一首。',
].join('\n');

/**
 * Cordis default MODEL registry. Kept next to the defaults so a fresh install
 * only needs `rvcRoot` to point at a working RVC tree.
 *
 * @param {string} rvcRoot
 */
function defaultModels(rvcRoot) {
  const root = rvcRoot.replace(/\\/g, '/').replace(/\/$/, '');
  return {
    Paimon: {
      pth: `${root}/models/Paimon/paimon_cn.pth`,
      index: `${root}/models/Paimon/added_IVF522_Flat_nprobe_1_paimon_cn_v2.index`,
      targetF0: 320,
    },
    DaFeiYu: {
      pth: `${root}/models/DaFeiYu/dafeiyu.pth`,
      index: `${root}/models/DaFeiYu/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index`,
      targetF0: 300,
    },
    Ying: {
      pth: `${root}/models/Ying/yingRVC.pth`,
      index: `${root}/models/Ying/added_IVF402_Flat_nprobe_1_yingRVC_v2.index`,
      targetF0: 320,
    },
  };
}

/**
 * Mount the plugin.
 *
 * @param {object} ctx - Cordis host context.
 * @param {Record<string, unknown>} [config] - Patch configuration.
 */
export function apply(ctx, config = {}) {
  const settings = resolveSettings(config);
  const log = createLogger();
  log(
    `apply: enabled=${settings.enabled} model=${settings.modelName} autoPitch=${settings.autoPitch} ` +
      `seconds=${settings.defaultSeconds}/${settings.maxSeconds} prompt=${settings.promptEnabled} ` +
      `rvcRoot=${settings.rvcRoot || '(not found)'}`,
  );
  if (!settings.enabled) {
    log('apply: disabled by config, nothing registered');
    return;
  }
  if (!ensureWorkDir(settings.workDir)) log(`apply: workDir not writable: ${settings.workDir}`);

  // Setup hints: the plugin still loads without these, but singing will fail
  // until they are configured. Say so once, in one actionable line each.
  if (settings.rvcRoot === '') {
    log(
      'apply: RVC root not found — set config.rvcRoot (or the RVC_ROOT env var) to a folder containing applio/core.py; singing cannot run until then',
    );
  }
  if (settings.workspace === '') {
    log(
      'apply: WeChatAgent workspace not configured — set config.workspace (or WECHATAGENT_WORKSPACE) to the folder that has state/accounts and config/wechatagent.json; voice sending will fail until then',
    );
  }

  try {
    const model = resolveModel(settings);
    log(`apply: model ${model.name} pth=${model.pth}`);
    for (const [label, path] of [
      ['python', settings.python],
      ['ffmpeg', settings.ffmpeg],
      ['model', model.pth],
      ['index', model.index],
    ]) {
      log(`apply: ${label} ${existsFile(path) ? 'ok' : 'MISSING'} ${path}`);
    }
  } catch (error) {
    log(`apply: model config problem: ${messageOf(error)}`);
  }

  try {
    const auth = settings.authEnabled ? readAuth(settings.cookieFile) : undefined;
    log(
      auth
        ? `apply: QQ Music account uin=${auth.uin} (${auth.nickname ?? 'no nickname'}) cookie=${settings.cookieFile}`
        : `apply: no QQ Music account cookie (${settings.cookieFile}); free tier only`,
    );
  } catch (error) {
    log(`apply: cookie check failed: ${messageOf(error)}`);
  }

  const tools = ctx.get?.('tools') ?? ctx.tools;
  if (!tools || typeof tools.register !== 'function') {
    log('apply: tools service unavailable, nothing registered');
    return;
  }

  const definitions = [
    {
      name: TOOL_SING,
      description: SING_DESCRIPTION,
      parameters: structuredClone(SING_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({ detail: await singToolCall(settings, log, args, exec) }),
    },
    {
      name: TOOL_SEARCH,
      description: SEARCH_DESCRIPTION,
      parameters: structuredClone(SEARCH_PARAMETERS),
      output: textOutput(),
      execute: async (args, exec) => ({ detail: await searchToolCall(settings, log, args, exec) }),
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
          /* disposal must not throw during reload */
        }
      }
    };
  };
  if (typeof ctx.effect === 'function') ctx.effect(registerAll);
  else registerAll();

  if (typeof ctx.on !== 'function') return;

  // The social bridge filters the persona-chat tool surface inside its own
  // `system-prompt/assemble` hook. Attach (and merge into) the per-session
  // extension policy before awaiting next() so the filter sees our tools; the
  // send_voice plugin uses the same slot, hence the merge instead of a claim.
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    try {
      const sessionId = sessionIdOf(agent);
      for (const target of [agent?.ctx, agent]) {
        attachExtensionPolicy(target, sessionId, settings, log, 'pre-step');
        ensureScopedTools(target, settings, definitions, log);
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
        ensureScopedTools(target, settings, definitions, log);
      }
    } catch {
      /* policy attachment must never break assembly */
    }
    const assembled = await next();
    try {
      if (settings.promptEnabled && inWechatChatSession(sessionId, settings)) {
        assembled.sections?.push({ name: 'dsh-qqmusic:rules', text: settings.promptText });
      }
      const names = Array.isArray(assembled.tools) ? assembled.tools.map((item) => item?.name) : [];
      log(`prompt: session=${sessionId ?? '?'} tools=${names.length} sing=${names.includes(TOOL_SING)}`);
    } catch {
      /* a composition without sections just gets no rules */
    }
    return assembled;
  });
  log('apply: policy + prompt hooks attached');

  if (settings.autoSingEnabled && typeof ctx.on === 'function') {
    // Guarantee path: long-lived group sessions sometimes reply "I can't sing
    // here" indefinitely (verified: zero tool calls in that session's history),
    // so the host listens for the request itself and performs it if the model
    // did not. Sending happens off-turn; the model's text reply is untouched.
    const handler = createAutoSingHandler({
      settings,
      log,
      sing: async (sessionId, title) => {
        const detail = await performSing(settings, log, sessionId, {
          keyword: title,
          mode: 'cover',
          seconds: settings.defaultSeconds,
        });
        log(`autosing: sent «${title}» -> ${detail.slice(0, 120)}`);
      },
    });
    ctx.on('session/event', (session, event) => {
      try {
        handler(session, event);
      } catch {
        /* auto-sing must never break a turn */
      }
    });
    log(`apply: auto-sing fallback armed (cooldown=${Math.round(settings.autoSingCooldownMs / 1000)}s)`);
  }
}

/** @returns {{schema: object, render: (args: unknown, value: any) => Array<{type: string, text: string}>}} */
function textOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { detail: { type: 'string' } },
      required: ['detail'],
    },
    render: (_args, value) => [{ type: 'text', text: String(value?.detail ?? '') }],
  };
}

/**
 * One `sing_song` invocation: render the excerpt, send it as a voice bubble.
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {Record<string, unknown>} args
 * @param {{signal?: AbortSignal, agent?: unknown}} exec
 * @returns {Promise<string>}
 */
async function singToolCall(settings, log, args, exec) {
  const sessionId = sessionIdOf(exec?.agent);
  if (sessionId === undefined) throw new Error('定位不到当前会话，无法确定唱给哪个微信聊天。');
  const keyword = String(args?.keyword ?? '').trim();
  if (keyword === '') throw new Error('keyword 不能为空：把歌名（或“歌手 歌名”）放进来。');
  return await performSing(settings, log, sessionId, { ...args, keyword }, exec?.signal);
}

/**
 * Render + send one song for a session. Shared by the tool and the auto-sing
 * fallback, so both paths behave exactly the same (including the spoken apology
 * when the track does not exist).
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {string} sessionId
 * @param {Record<string, unknown>} args
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>}
 */
async function performSing(settings, log, sessionId, args, signal) {
  const keyword = String(args?.keyword ?? '').trim();
  const target = await resolveSessionTarget({
    sessionId,
    settings,
    ...(signal === undefined ? {} : { signal }),
  });

  const started = Date.now();
  let rendered;
  try {
    rendered = await renderSinging(
      {
        keyword,
        mode: typeof args?.mode === 'string' ? args.mode : undefined,
        seconds: Number.isFinite(Number(args?.seconds)) ? Number(args.seconds) : undefined,
        start: Number.isFinite(Number(args?.start)) ? Number(args.start) : undefined,
      },
      settings,
      log,
    );
  } catch (error) {
    // A song that QQ Music simply doesn't have is answered with a spoken
    // apology (the user asked for a voice, not an error bubble).
    if (error?.code === 'NOT_FOUND') {
      log(`sing: not found «${keyword}» (${messageOf(error)}), speaking apology`);
      const apology = await sendFallbackVoice({
        sessionId,
        toUser: target.toUser,
        text: settings.notFoundVoiceText,
        settings,
        log,
        ...(signal === undefined ? {} : { signal }),
      });
      if (apology.sent) {
        return `QQ 音乐里找不到《${keyword}》，已经用她的声音发语音说“${settings.notFoundVoiceText}”；你只需要回一句很短的文字，不要再发语音、也不要再道歉一次。`;
      }
      return `QQ 音乐里找不到《${keyword}》，语音兜底也没发出去（${apology.reason ?? '未知原因'}）；简短告诉对方换一首。`;
    }
    throw error;
  }
  const sent = await sendSingingVoice({
    sessionId,
    silk: rendered.silk,
    durationMs: rendered.durationMs,
    settings,
    log,
    ...(signal === undefined ? {} : { signal }),
  });
  const elapsed = Math.round((Date.now() - started) / 1000);
  log(`sing: done ${elapsed}s song=${rendered.song.title} chat=${sent.chatKey}`);

  const title = rendered.song.artist
    ? `《${rendered.song.title}》（${rendered.song.artist}）`
    : `《${rendered.song.title}》`;
  const parts = [
    `已经唱了${title}第 ${Math.round(rendered.start)} 秒起的 ${Math.round(rendered.durationMs / 1000)} 秒，语音条已发出`,
  ];
  if (rendered.notes.length > 0) parts.push(rendered.notes.join('；'));
  parts.push(`耗时约 ${elapsed} 秒`);
  return parts.join('。');
}

/**
 * One `qq_music_search` invocation.
 *
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {(line: string) => void} log
 * @param {Record<string, unknown>} args
 * @param {{signal?: AbortSignal}} exec
 * @returns {Promise<string>}
 */
async function searchToolCall(settings, log, args, exec) {
  const keyword = String(args?.keyword ?? '').trim();
  if (keyword === '') throw new Error('keyword 不能为空：要搜什么？');
  const limit = Number.isFinite(Number(args?.limit)) ? Math.round(Number(args.limit)) : 5;
  const songs = await searchSongs(keyword, Math.min(10, Math.max(1, limit)));
  if (songs.length === 0) {
    log(`search: ${keyword} -> 0`);
    return `QQ 音乐没搜到《${keyword}》。`;
  }
  void exec;
  const lines = songs.map((song, index) => {
    const duration = song.interval > 0 ? `${Math.floor(song.interval / 60)}:${String(song.interval % 60).padStart(2, '0')}` : '?:??';
    const flag = song.free ? '免费可播' : '会员/无免费音源';
    return `${index + 1}. ${song.title}${song.artist ? ` - ${song.artist}` : ''}（${duration}，${flag}）`;
  });
  log(`search: ${keyword} -> ${songs.length}`);
  return [`QQ 音乐搜到 ${songs.length} 首：`, ...lines].join('\n');
}

/** The generic host extension slot the social bridge reads. */
const EXTENSION_POLICY = Symbol.for('wechatagent.extension-tools.v1');

/** Marks the scoped registration so one agent scope registers only once. */
const SCOPED_TOOLS = Symbol.for('dsh.qqmusic.scoped-tools.v1');

/** Guards the policy merge so the slot is only wrapped once. */
const POLICY_MERGED = Symbol.for('dsh.qqmusic.policy-merged.v1');

/**
 * Allow our tools inside one WeChatAgent chat's tool surface.
 *
 * The send_voice plugin owns the same slot with its own single tool; if it got
 * there first, merge our definitions into its policy instead of silently
 * losing one of the two tools.
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
    { name: TOOL_SING, description: SING_DESCRIPTION, parameters: structuredClone(SING_PARAMETERS) },
    { name: TOOL_SEARCH, description: SEARCH_DESCRIPTION, parameters: structuredClone(SEARCH_PARAMETERS) },
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
      existing.check = (toolName) =>
        TOOL_NAMES.includes(toolName) || Boolean(previousCheck?.(toolName));
      existing.definitions = () => [...(previousDefinitions?.() ?? []), ...ownDefinitions()];
      Object.defineProperty(existing, POLICY_MERGED, { configurable: true, value: true });
    } else {
      return false;
    }
  } catch {
    return false;
  }
  log(`policy: qqmusic tools allowed (${where}) session=${sessionId}`);
  return true;
}

/**
 * Register our tools on one agent scope's own registry, once.
 *
 * @param {unknown} scopeCtx
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {Array<Record<string, any>>} definitions
 * @param {(line: string) => void} log
 */
function ensureScopedTools(scopeCtx, settings, definitions, log) {
  if (typeof scopeCtx !== 'object' || scopeCtx === null) return;
  if (scopeCtx[SCOPED_TOOLS] !== undefined) return;
  const tools = scopeCtx.tools ?? scopeCtx.get?.('tools');
  if (!tools || typeof tools.register !== 'function') return;
  try {
    const disposers = definitions.map((definition) => tools.register(definition));
    Object.defineProperty(scopeCtx, SCOPED_TOOLS, { configurable: true, value: disposers });
    log('scoped: qqmusic tools registered on agent tool registry');
  } catch {
    /* scoped registration is best-effort */
  }
}

/**
 * Every object that might carry the policy slot for this assembly.
 *
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
 * Whether a session id belongs to a WeChat chat this plugin can sing into.
 *
 * @param {string|undefined} sessionId
 * @param {ReturnType<typeof resolveSettings>} settings
 * @returns {boolean}
 */
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

/** @param {string} path @returns {boolean} */
function existsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Merge patch config over the defaults, resolving every derived path so a typo
 * in one place cannot yield a half-working plugin.
 *
 * @param {Record<string, unknown>} config
 */
export function resolveSettings(config) {
  const raw = config && typeof config === 'object' ? config : {};
  const text = (value, fallback) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback);
  const number = (value, fallback, min, max) => {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const flag = (value, fallback) => (typeof value === 'boolean' ? value : fallback);

  const rvcRoot = detectRvcRoot(text(raw.rvcRoot, DEFAULTS.rvcRoot));
  const applioDir = slashPath(
    text(raw.applioDir, rvcRoot === '' ? '' : `${rvcRoot}/applio`),
  );
  const python = slashPath(text(raw.python, detectPython(rvcRoot)));
  const ffmpeg = slashPath(text(raw.ffmpeg, detectFfmpeg(applioDir)));
  const ffprobe = slashPath(text(raw.ffprobe, detectFfprobe(applioDir)));
  const workDir = slashPath(
    text(raw.workDir, rvcRoot === '' ? `${dshHome()}/qqmusic-cache` : `${rvcRoot}/songs/qqmusic`),
  );
  const workspace = slashPath(text(raw.workspace, process.env.WECHATAGENT_WORKSPACE || DEFAULTS.workspace));
  const voicePluginDir = slashPath(text(raw.voicePluginDir, detectVoicePluginDir()));
  const baseModels = defaultModels(rvcRoot);
  const modelOverrides = raw.models && typeof raw.models === 'object' ? raw.models : {};
  const models = { ...baseModels };
  for (const [modelName, entry] of Object.entries(modelOverrides)) {
    if (!entry || typeof entry !== 'object') continue;
    const merged = { ...(baseModels[modelName] ?? { targetF0: 300 }), ...entry };
    merged.pth = String(merged.pth ?? '').replace(/\\/g, '/');
    merged.index = String(merged.index ?? '').replace(/\\/g, '/');
    models[modelName] = merged;
  }

  return {
    enabled: raw.enabled !== false,
    promptEnabled: raw.promptEnabled !== false,
    rvcRoot,
    applioDir,
    python,
    ffmpeg,
    ffprobe,
    models,
    modelName: text(raw.model, DEFAULTS.model),
    pitch: Math.round(number(raw.pitch, DEFAULTS.pitch, -12, 12)),
    autoPitch: flag(raw.autoPitch, DEFAULTS.autoPitch),
    indexRate: number(raw.indexRate, DEFAULTS.indexRate, 0, 1),
    protect: number(raw.protect, DEFAULTS.protect, 0, 0.5),
    timbre: number(raw.timbre, DEFAULTS.timbre, 0.5, 1.5),
    qfrency: number(raw.qfrency, DEFAULTS.qfrency, 0, 50),
    volumeEnvelope: number(raw.volumeEnvelope, DEFAULTS.volumeEnvelope, 0, 1),
    accompanimentGain: number(raw.accompanimentGain, DEFAULTS.accompanimentGain, 0, 1.5),
    demucsModel: text(raw.demucsModel, DEFAULTS.demucsModel),
    defaultSeconds: Math.round(number(raw.defaultSeconds, DEFAULTS.defaultSeconds, 8, DEFAULTS.maxSeconds)),
    maxSeconds: Math.round(number(raw.maxSeconds, DEFAULTS.maxSeconds, 8, 60)),
    searchLimit: Math.round(number(raw.searchLimit, DEFAULTS.searchLimit, 3, 30)),
    maxCandidates: Math.round(number(raw.maxCandidates, DEFAULTS.maxCandidates, 1, 10)),
    minMatchScore: Math.round(number(raw.minMatchScore, DEFAULTS.minMatchScore, 0, 100)),
    workDir,
    hookUrl: text(raw.hookUrl, DEFAULTS.hookUrl),
    workspace,
    fallbackToOriginal: flag(raw.fallbackToOriginal, DEFAULTS.fallbackToOriginal),
    demucsTimeoutMs: Math.round(number(raw.demucsTimeoutMs, DEFAULTS.demucsTimeoutMs, 30_000, 900_000)),
    rvcTimeoutMs: Math.round(number(raw.rvcTimeoutMs, DEFAULTS.rvcTimeoutMs, 30_000, 900_000)),
    authEnabled: flag(raw.authEnabled, DEFAULTS.authEnabled),
    cookieFile: text(raw.cookieFile, defaultCookieFile()).replace(/\\/g, '/'),
    voiceFallbackEnabled: flag(raw.voiceFallbackEnabled, DEFAULTS.voiceFallbackEnabled),
    voicePluginDir,
    notFoundVoiceText: text(raw.notFoundVoiceText, DEFAULTS.notFoundVoiceText),
    voiceName: text(raw.voiceName, DEFAULTS.voiceName),
    voiceRate: text(raw.voiceRate, DEFAULTS.voiceRate),
    voicePitch: text(raw.voicePitch, DEFAULTS.voicePitch),
    autoSingEnabled: flag(raw.autoSingEnabled, DEFAULTS.autoSingEnabled),
    autoSingCooldownMs: Math.round(
      number(raw.autoSingCooldownMs, DEFAULTS.autoSingCooldownMs, 10_000, 3_600_000),
    ),
    promptText: text(raw.promptText, DEFAULT_PROMPT),
  };
}

/**
 * Ensure the work directory exists once at apply time (host process is not
 * sandboxed; a read-only work dir simply makes the first sing fail loudly).
 *
 * @param {string} workDir
 */
export function ensureWorkDir(workDir) {
  try {
    mkdirSync(join(workDir), { recursive: true });
    return true;
  } catch {
    return false;
  }
}
