/**
 * The voice pack: a catalogue of Edge neural TTS voices (female, male, dialect
 * and HK/TW) plus optional RVC timbre presets.
 *
 * Two layers of "voice":
 *   1. `edge` — the Edge read-aloud voice (what the words sound like; 20+).
 *   2. `rvc`  — an RVC timbre conversion applied on top (e.g. 大肥鱼 male model).
 *
 * The agent picks by alias (`云希`, `男声`, `dafeiyu`) or by the exact id. Pure
 * data + pure helpers, so this file is unit-testable offline.
 */

/**
 * @typedef {object} EdgeVoice
 * @property {string} id       Edge TTS voice id.
 * @property {string} name     Display name (Chinese).
 * @property {'female'|'male'} gender
 * @property {string} locale
 * @property {string[]} aliases
 * @property {string[]} tags
 */

/**
 * Verified against the Edge read-aloud service on 2026-10-28: only voices that
 * actually synthesize are listed. Azure-only voices (晓辰/晓涵/云野/云枫/云皓…)
 * are intentionally absent — the Edge endpoint rejects them.
 *
 * @type {EdgeVoice[]}
 */
export const EDGE_VOICES = [
  // ---- 普通话女声 ----------------------------------------------------------
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', gender: 'female', locale: 'zh-CN', aliases: ['xiaoxiao', '晓晓'], tags: ['标准', '自然'] },
  { id: 'zh-CN-XiaoyiNeural', name: '晓伊', gender: 'female', locale: 'zh-CN', aliases: ['xiaoyi', '小艺', '晓伊'], tags: ['默认', '御姐'] },
  { id: 'zh-CN-XiaoxuanNeural', name: '晓萱', gender: 'female', locale: 'zh-CN', aliases: ['xiaoxuan', '晓萱'], tags: ['干练'] },
  // ---- 普通话男声（常用新男声） --------------------------------------------
  { id: 'zh-CN-YunxiNeural', name: '云希', gender: 'male', locale: 'zh-CN', aliases: ['yunxi', '云希', '男声'], tags: ['年轻', '常用男声'] },
  { id: 'zh-CN-YunjianNeural', name: '云健', gender: 'male', locale: 'zh-CN', aliases: ['yunjian', '云健', '男声'], tags: ['播音', '运动'] },
  { id: 'zh-CN-YunyangNeural', name: '云扬', gender: 'male', locale: 'zh-CN', aliases: ['yunyang', '云扬', '男声'], tags: ['新闻', '磁性'] },
  { id: 'zh-CN-YunxiaNeural', name: '云夏', gender: 'male', locale: 'zh-CN', aliases: ['yunxia', '云夏', '男声'], tags: ['少年'] },
  // ---- 方言 ----------------------------------------------------------------
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '晓北（东北话）', gender: 'female', locale: 'zh-CN', aliases: ['xiaobei', '晓北', '东北话'], tags: ['方言'] },
  { id: 'zh-CN-shaanxi-XiaoniNeural', name: '晓妮（陕西话）', gender: 'female', locale: 'zh-CN', aliases: ['xiaoni', '晓妮', '陕西话'], tags: ['方言'] },
  // ---- 粤语 ----------------------------------------------------------------
  { id: 'zh-HK-HiuMaanNeural', name: '曉曼（粤语）', gender: 'female', locale: 'zh-HK', aliases: ['hiumaan', '晓曼'], tags: ['粤语'] },
  { id: 'zh-HK-HiuGaaiNeural', name: '曉佳（粤语）', gender: 'female', locale: 'zh-HK', aliases: ['hiugaai', '晓佳'], tags: ['粤语'] },
  { id: 'zh-HK-WanLungNeural', name: '雲龍（粤语）', gender: 'male', locale: 'zh-HK', aliases: ['wanlung', '云龙', '粤语男声'], tags: ['粤语', '男声'] },
  // ---- 台湾腔 --------------------------------------------------------------
  { id: 'zh-TW-HsiaoChenNeural', name: '曉臻（台湾腔）', gender: 'female', locale: 'zh-TW', aliases: ['hsiaochen', '晓臻'], tags: ['台湾腔'] },
  { id: 'zh-TW-HsiaoYuNeural', name: '曉雨（台湾腔）', gender: 'female', locale: 'zh-TW', aliases: ['hsiaoyu', '晓雨'], tags: ['台湾腔'] },
  { id: 'zh-TW-YunJheNeural', name: '雲哲（台湾腔）', gender: 'male', locale: 'zh-TW', aliases: ['yunjhe', '云哲', '台湾男声'], tags: ['台湾腔', '男声'] },
];

/** Default voice for the pack. */
export const DEFAULT_VOICE = 'zh-CN-XiaoyiNeural';

/**
 * @typedef {object} RvcPreset
 * @property {string} name        Preset key.
 * @property {string} display     Chinese display name.
 * @property {'female'|'male'|'unknown'} gender
 * @property {number} pitch       Semitones for the conversion.
 * @property {string[]} aliases
 * @property {string} modelPath   Default model path relative to <rvcRoot>.
 * @property {string} indexPath   Default index path relative to <rvcRoot>.
 * @property {string} filter      Optional ffmpeg post filter.
 * @property {string[]} args      Extra RVC args after pitch (indexRate,timbre,qfrency,volume,protect).
 */

/** @type {RvcPreset[]} */
export const RVC_PRESETS = [
  {
    name: 'paimon',
    display: '派蒙（女声）',
    gender: 'female',
    pitch: -5,
    aliases: ['paimon', '派蒙', 'p-6'],
    modelPath: 'models/Paimon/paimon_cn.pth',
    indexPath: 'models/Paimon/added_IVF522_Flat_nprobe_1_paimon_cn_v2.index',
    filter:
      'highpass=f=65,afftdn=nr=10:nf=-40,equalizer=f=180:t=q:w=1:g=2.5,' +
      'equalizer=f=3000:t=q:w=1.4:g=-3.5,equalizer=f=7500:t=h:w=1:g=-2.5,' +
      'acompressor=threshold=-20dB:ratio=2:attack=15:release=180,loudnorm=I=-16:TP=-1.5:LRA=11',
    args: ['0.35', '0.98', '20', '1.0', '0.50'],
  },
  {
    name: 'dafeiyu',
    display: '大肥鱼（男声）',
    gender: 'male',
    pitch: 0,
    aliases: ['dafeiyu', 'dfy', '大肥鱼', '男声', '男'],
    modelPath: 'models/DaFeiYu/dafeiyu.pth',
    indexPath: 'models/DaFeiYu/added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index',
    filter: 'highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11',
    args: ['0.45', '1.0', '15', '1.0', '0.33'],
  },
  {
    name: 'ying',
    display: '影（女声）',
    gender: 'female',
    pitch: 0,
    aliases: ['ying', '影'],
    modelPath: 'models/Ying/yingRVC.pth',
    indexPath: 'models/Ying/added_IVF402_Flat_nprobe_1_yingRVC_v2.index',
    filter: 'highpass=f=70,loudnorm=I=-16:TP=-1.5:LRA=11',
    args: ['0.40', '1.0', '15', '1.0', '0.33'],
  },
];

/** All gender tags the catalogue understands. */
export const GENDERS = new Set(['female', 'male', 'all']);

/**
 * Resolve a user/agent supplied name to an Edge voice.
 *
 * Accepts the exact id, a Chinese display name, a Latin alias, or a gender word
 * (`男声` / `女声`). Returns undefined when nothing matches.
 *
 * @param {string|undefined} input
 * @returns {EdgeVoice|undefined}
 */
export function resolveVoice(input) {
  const value = String(input ?? '').trim();
  if (value === '') return undefined;
  const lower = value.toLowerCase();
  const exact = EDGE_VOICES.find((voice) => voice.id.toLowerCase() === lower);
  if (exact) return exact;
  const byName = EDGE_VOICES.find((voice) => voice.name === value);
  if (byName) return byName;
  const byAlias = EDGE_VOICES.find((voice) => voice.aliases.some((alias) => alias.toLowerCase() === lower));
  if (byAlias) return byAlias;
  // Partial match: "云希的声音" / "东北话男声".
  const byPartial = EDGE_VOICES.find(
    (voice) =>
      voice.name.includes(value) ||
      voice.aliases.some((alias) => alias.length >= 2 && lower.includes(alias.toLowerCase())),
  );
  return byPartial;
}

/**
 * Resolve an RVC preset by name/alias.
 *
 * @param {string|undefined} input
 * @returns {RvcPreset|undefined}
 */
export function resolveRvcPreset(input) {
  const value = String(input ?? '').trim();
  if (value === '') return undefined;
  const lower = value.toLowerCase();
  return RVC_PRESETS.find(
    (preset) =>
      preset.name === lower ||
      preset.aliases.some((alias) => alias.toLowerCase() === lower) ||
      preset.display.includes(value),
  );
}

/**
 * Resolve a preset or voice from one free-form request. Used by tool calls:
 * `voice` may be "云希", `rvc` may be "大肥鱼".
 *
 * @param {{voice?: string, rvc?: string}} args
 * @returns {{voice: EdgeVoice, rvc: RvcPreset|undefined}}
 */
export function resolveSelection(args = {}) {
  const voice = resolveVoice(args.voice) ?? EDGE_VOICES.find((item) => item.id === DEFAULT_VOICE);
  let rvc = resolveRvcPreset(args.rvc);
  // `rvc: "男声"` was consumed by resolveVoice above only when passed as voice;
  // when no explicit rvc preset is named, a gender word picks the first preset
  // of that gender.
  if (!rvc && typeof args.rvc === 'string' && /男/.test(args.rvc)) {
    rvc = RVC_PRESETS.find((preset) => preset.gender === 'male');
  }
  return { voice, rvc };
}

/**
 * Human-readable catalogue, grouped by gender/locale.
 *
 * @param {{gender?: string, locale?: string, tag?: string}} filter
 * @returns {string}
 */
export function formatVoiceList(filter = {}) {
  const gender = String(filter.gender ?? 'all').toLowerCase();
  const locale = String(filter.locale ?? '').trim().toLowerCase();
  const tag = String(filter.tag ?? '').trim();
  const voices = EDGE_VOICES.filter((voice) => {
    if (gender !== 'all' && voice.gender !== gender) return false;
    if (locale !== '' && !voice.locale.toLowerCase().startsWith(locale)) return false;
    if (tag !== '' && !voice.tags.some((item) => item.includes(tag))) return false;
    return true;
  });
  const lines = [];
  lines.push(`语音包里有 ${voices.length} 个 Edge 音色（女声 ${voices.filter((item) => item.gender === 'female').length} / 男声 ${voices.filter((item) => item.gender === 'male').length}）：`);
  for (const voice of voices) {
    const flags = [voice.gender === 'male' ? '男声' : '女声', ...voice.tags].join('/');
    lines.push(`- ${voice.name}（${voice.id}，${flags}）`);
  }
  lines.push(`RVC 音色预设：${RVC_PRESETS.map((preset) => `${preset.display}（${preset.name}）`).join('、')}`);
  return lines.join('\n');
}
