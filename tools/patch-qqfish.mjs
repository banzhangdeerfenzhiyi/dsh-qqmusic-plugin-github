#!/usr/bin/env node
/**
 * Patch the QQ side bot (`dsh-xingzhudafeiyu-home`, aka qq-fish) so it can sing.
 *
 * Why patching: that plugin owns its own reply pipeline (LLM → text/TTS record)
 * and exposes no extension hook. We add a deterministic "点歌快速路径" in front of
 * its LLM reply: when a message contains 「唱 + 歌名」, render the cover through
 * `dsh-qqmusic-plugin` and send it as a normal QQ record message.
 *
 *   node tools/patch-qqfish.mjs             # install / re-apply the patch
 *   node tools/patch-qqfish.mjs --check     # report whether it is applied
 *   node tools/patch-qqfish.mjs --remove    # restore the backed-up engine.mjs
 *   node tools/patch-qqfish.mjs --force     # patch despite an untested plugin version
 *   node tools/patch-qqfish.mjs --dir <path>  # custom plugin directory
 *
 * Safety: the original engine.mjs is backed up once; every anchor is verified
 * before anything is written (a failure leaves the file untouched). The patch is
 * idempotent. qq-fish internals are not a stable API, hence the version check.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const SING_SOURCE = join(TOOLS_DIR, 'qqfish-sing.mjs');

const MARK_BEGIN = '// >>> dsh-qqmusic sing (managed by dsh-qqmusic-plugin) >>>';
const MARK_END = '// <<< dsh-qqmusic sing (managed by dsh-qqmusic-plugin) <<<';
const BACKUP_SUFFIX = '.orig-dsh-qqmusic';

/** qq-fish versions this patch has been tested with. */
const TESTED_VERSIONS = ['0.1.8'];

const argv = process.argv.slice(2);
const checkOnly = argv.includes('--check');
const remove = argv.includes('--remove');
const force = argv.includes('--force');
const dirIndex = argv.indexOf('--dir');

/**
 * Locate the installed qq-fish plugin without hardcoding a profile name.
 *
 * @returns {string}
 */
function findPluginDir() {
  if (dirIndex >= 0 && argv[dirIndex + 1]) return argv[dirIndex + 1];
  if (process.env.QQ_FISH_PLUGIN_DIR) return process.env.QQ_FISH_PLUGIN_DIR;
  const home = (
    process.env.DSH_HOME ||
    join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
  ).replace(/\\/g, '/');
  const profileDirs = [];
  if (process.env.DSH_PROFILE) profileDirs.push(`${home}/profiles/${process.env.DSH_PROFILE}`);
  const profiles = `${home}/profiles`;
  if (existsSync(profiles)) {
    for (const profile of readdirSync(profiles)) profileDirs.push(`${profiles}/${profile}`);
  }
  for (const profileDir of profileDirs) {
    const candidate = `${profileDir}/node_modules/dsh-xingzhudafeiyu-home`;
    if (existsSync(join(candidate, 'lib', 'engine.mjs'))) return candidate;
  }
  return `${home}/profiles/desktop/node_modules/dsh-xingzhudafeiyu-home`;
}

const pluginDir = findPluginDir();
const enginePath = join(pluginDir, 'lib', 'engine.mjs');
const singPath = join(pluginDir, 'lib', 'sing.mjs');
const backupPath = enginePath + BACKUP_SUFFIX;
const packagePath = join(pluginDir, 'package.json');

if (!existsSync(enginePath)) {
  console.error(`找不到 qq-fish 插件：${enginePath}`);
  console.error('先安装 dsh-xingzhudafeiyu-home（QQ 端机器人插件），或用 --dir 指定其目录。');
  process.exit(1);
}

let pluginVersion = 'unknown';
try {
  pluginVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version ?? 'unknown';
} catch {
  /* version is only informational */
}
const versionTested = TESTED_VERSIONS.includes(pluginVersion);

const current = readFileSync(enginePath, 'utf8');
const applied = current.includes(MARK_BEGIN) && current.includes('async trySingReply(');

if (checkOnly) {
  console.log(`插件目录：${pluginDir}`);
  console.log(`qq-fish 版本：${pluginVersion}${versionTested ? '（已适配）' : '（未适配的版本）'}`);
  console.log(`engine.mjs 已打补丁：${applied ? '是' : '否'}`);
  console.log(`lib/sing.mjs 存在：${existsSync(singPath) ? '是' : '否'}`);
  console.log(`备份存在：${existsSync(backupPath) ? '是' : '否'}`);
  process.exit(applied ? 0 : 2);
}

if (remove) {
  if (existsSync(backupPath)) {
    copyFileSync(backupPath, enginePath);
    console.log(`已还原 engine.mjs（备份 ${backupPath}）`);
  } else if (applied) {
    console.log('没有备份文件，无法自动还原；请重装 dsh-xingzhudafeiyu-home 覆盖。');
    process.exit(1);
  } else {
    console.log('没有补丁需要还原。');
  }
  process.exit(0);
}

// ---------------------------------------------------------------- sing module
if (!existsSync(SING_SOURCE)) {
  console.error(`缺少补丁源文件：${SING_SOURCE}`);
  process.exit(1);
}

// ---------------------------------------------------------------- engine patch
if (applied) {
  console.log('engine.mjs 补丁已存在，跳过引擎修改。');
  copyFileSync(SING_SOURCE, singPath);
  console.log(`同步 ${singPath}`);
  process.exit(0);
}

if (!existsSync(backupPath)) {
  copyFileSync(enginePath, backupPath);
  console.log(`备份原文件 -> ${backupPath}`);
}

// Version gate: only patch versions that were verified. Anchors are checked
// anyway; on mismatch nothing is written.
if (!versionTested && !force) {
  console.warn(`注意：qq-fish 当前版本 ${pluginVersion} 不在适配列表（${TESTED_VERSIONS.join(', ')}）。`);
  console.warn('补丁会先校验锚点、失败不写文件；确认继续请加 --force 重跑。');
  process.exit(3);
}

// The fast-path method inserted into ChatEngine. Kept as a template literal so
// the target file's formatting is untouched.
const SING_METHOD = `  /**
   * 点歌快速路径（由 dsh-qqmusic-plugin 安装）：命中「唱 + 歌名」时，本机渲染
   * AI 翻唱并通过 OneBot record 发出去，不再依赖模型的自觉。
   * @returns {Promise<boolean>} true 表示这条消息已经被点歌处理完
   */
  async trySingReply(msg, config, bridge, target) {
    const text = String((msg && msg.text) || '')
    if (!text) return false
    if (config.voiceEnabled === false) return false
    const title = extractSongTitle(text)
    if (!title) return false
    const conversation = conversationKey(msg.channel, msg.uin)
    const gap = Math.max(20, Number(config.voiceMinGapSec) || 60) * 1000
    if (Date.now() - (this.lastSingAt.get(conversation) || 0) < gap) return false
    this.lastSingAt.set(conversation, Date.now())
    try {
      await bridge
        .send(target, '《' + title + '》？好，等我一下，本小姐这就唱给你听～')
        .catch(() => {})
      appendVoiceLog('sing start title=' + title)
      let rendered
      try {
        rendered = await renderForQq({
          title,
          seconds: 30,
          log: (line) => appendVoiceLog('sing ' + line),
        })
      } catch (error) {
        if (error && error.code === 'NOT_FOUND') {
          const audio = await synthesizeSpeech('我不知道你说的歌怎么唱哦', config)
          if (audio && audio.path) await bridge.sendRecord(target, audio.path)
          appendVoiceLog('sing miss title=' + title)
          appendMessage({
            ts: Date.now(),
            direction: 'out',
            channel: msg.channel,
            conversation,
            uin: msg.uin,
            who: config.personaName || '助手',
            text: '我不知道你说的歌怎么唱哦',
            voice: true,
            replyTo: msg.messageId,
            generatedBy: 'sing-miss',
          })
          bumpStats('sent')
          return true
        }
        throw error
      }
      await bridge.sendRecord(target, rendered.mp3Path)
      this.lastVoiceAt.set(conversation, Date.now())
      appendVoiceLog('sing sent title=' + title + ' song=' + rendered.song.title)
      appendMessage({
        ts: Date.now(),
        direction: 'out',
        channel: msg.channel,
        conversation,
        uin: msg.uin,
        who: config.personaName || '助手',
        text: '🎵 ' + (rendered.song.artist ? rendered.song.artist + ' - ' : '') + rendered.song.title,
        voice: true,
        replyTo: msg.messageId,
        generatedBy: 'sing',
      })
      bumpStats('sent')
      bumpStats('replies')
      return true
    } catch (error) {
      appendVoiceLog('sing failed: ' + String((error && error.message) || error).slice(0, 200))
      this.log.warn('点歌失败，退回文字回复：' + String((error && error.message) || error))
      return false
    }
  }

`;

/**
 * Build the patched engine.mjs content; throws when any anchor is missing.
 *
 * @param {string} source
 * @returns {string}
 */
function buildPatched(source) {
  let patched = source;

  // 1) import
  const importAnchor = "import { recordUsage } from './usage.mjs'";
  if (!patched.includes(importAnchor)) throw new Error('找不到 usage import 锚点');
  patched = patched.replace(
    importAnchor,
    `${importAnchor}\n${MARK_BEGIN}\nimport { extractSongTitle, renderForQq } from './sing.mjs'\n${MARK_END}`,
  );

  // 2) per-conversation throttle state
  const stateAnchor =
    '    /** 每个会话上一次发语音的时间（防连发） */\n    this.lastVoiceAt = new Map()';
  if (!patched.includes(stateAnchor)) throw new Error('找不到 lastVoiceAt 锚点');
  patched = patched.replace(
    stateAnchor,
    `${stateAnchor}\n    /** 每个会话上一次点歌的时间（防连刷） */\n    this.lastSingAt = new Map()`,
  );

  // 3) the fast-path method, in front of tryVoiceReply
  const methodAnchor =
    '  /** 尝试把这条回复用语音发出去（TTS 合成 + record 消息）；返回是否真的发出去了 */';
  if (!patched.includes(methodAnchor)) throw new Error('找不到 tryVoiceReply 锚点');
  patched = patched.replace(methodAnchor, `${SING_METHOD}${methodAnchor}`);

  // 4) call the fast path at the very top of reply(), before the LLM
  const replyAnchor = `  async reply(msg, config) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return
    const conversation = conversationKey(msg.channel, msg.uin)`;
  if (!patched.includes(replyAnchor)) throw new Error('找不到 reply 头锚点');
  patched = patched.replace(
    replyAnchor,
    `  async reply(msg, config) {
    const bridge = this.getBridge()
    if (!bridge || bridge.state !== 'online') return
    const target =
      msg.channel === 'group'
        ? { kind: 'group', groupId: msg.groupId }
        : { kind: 'private', userId: msg.userId }
    ${MARK_BEGIN}
    if (await this.trySingReply(msg, config, bridge, target)) return
    ${MARK_END}
    const conversation = conversationKey(msg.channel, msg.uin)`,
  );

  // 5) drop the later duplicate target declaration
  const duplicateTarget =
    "    const target = msg.channel === 'group' ? { kind: 'group', groupId: msg.groupId } : { kind: 'private', userId: msg.userId }\n    const voiceSent = await this.tryVoiceReply(msg, config, text, bridge, target)";
  if (!patched.includes(duplicateTarget)) throw new Error('找不到 target 重复声明锚点');
  patched = patched.replace(
    duplicateTarget,
    '    const voiceSent = await this.tryVoiceReply(msg, config, text, bridge, target)',
  );

  return patched;
}

let patched;
try {
  patched = buildPatched(current);
} catch (error) {
  // Nothing has been written yet, so the original file is intact.
  console.error(`补丁失败（${error instanceof Error ? error.message : String(error)}）。`);
  console.error(`原文件未修改；备份仍在 ${backupPath}。`);
  console.error('如果是对 qq-fish 升级导致锚点变化，请提交 issue；也可以先 --remove 后重装。');
  process.exit(1);
}

writeFileSync(enginePath, patched);
copyFileSync(SING_SOURCE, singPath);
console.log(`已打补丁：${enginePath}`);
console.log(`写入 ${singPath}`);
console.log(`qq-fish 版本：${pluginVersion}${versionTested ? '' : '（未适配版本，但锚点校验通过）'}`);
console.log('重启 DeepSeek Harness 后生效；QQ 里 @她「唱首七里香」试试。');

