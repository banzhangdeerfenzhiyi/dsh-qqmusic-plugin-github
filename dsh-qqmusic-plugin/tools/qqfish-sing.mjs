/**
 * lib/sing.mjs — 点歌：复用本机 dsh-qqmusic-plugin 的「QQ 音乐 → Demucs → RVC →
 * 伴奏混音」流水线，产出可直接交给 NapCat record 消息的 mp3。
 *
 * 这是 qq-fish 插件（dsh-xingzhudafeiyu-home）的扩展文件，由
 * dsh-qqmusic-plugin/tools/patch-qqfish.mjs 安装。依赖关系是单向的：
 * qq-fish 只在被「唱 + 歌名」命中时懒加载 dsh-qqmusic-plugin，插件不在就返回
 * null，不影响原有聊天。
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH_HOME = String(process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/[\\/]+$/, '')
const PLUGIN_ROOT = join(DSH_HOME, 'dsh-qqmusic-plugin')

let cached

/** 懒加载翻唱插件；不存在/加载失败返回 null。 */
export async function loadSinger() {
  if (cached !== undefined) return cached
  try {
    const entry = join(PLUGIN_ROOT, 'index.mjs')
    if (!existsSync(entry)) {
      cached = null
      return null
    }
    const { resolveSettings } = await import(pathToFileURL(entry).href)
    const { renderSinging } = await import(pathToFileURL(join(PLUGIN_ROOT, 'src', 'singing.mjs')).href)
    cached = { settings: resolveSettings({}), renderSinging }
    return cached
  } catch {
    cached = null
    return null
  }
}

/** 短语过滤：明显不是歌名的片段直接放弃。 */
function cleanTitle(value) {
  let title = String(value || '').trim()
  title = title.replace(/^[《「【(（\s]+/, '').replace(/[》」】)）\s]+$/, '')
  title = title.replace(/[吧吗呢呀呗嘛哦啊噢啦咯~～]+$/g, '')
  if (title.length < 2 || title.length > 20) return undefined
  if (/(听|你说|给你|给我|一句|两句|一声|一下|什么|怎么|咋|这个|那个|首歌)/.test(title)) return undefined
  return title
}

/**
 * 从 QQ 消息纯文本里抠歌名：
 *   "唱首歌，起风了" / "唱首七里香" / "会不会唱《晴天》" / "点歌 稻香"
 * @param {string} text
 * @returns {string|undefined}
 */
export function extractSongTitle(text) {
  let value = String(text || '').trim()
  if (!value) return undefined
  if (!/(唱|点歌|来一首|来一段|来段|哼一)/.test(value)) return undefined
  value = value.replace(/^@[^\s]+[\s]+/, '')
  const quoted = value.match(/[《「]([^》」]{1,20})[》」]/)
  if (quoted) return cleanTitle(quoted[1])
  const index = value.search(/(唱|点歌|来一首|来一段|来段|哼一)/)
  if (index < 0) return undefined
  let rest = value.slice(index)
  rest = rest.replace(/^(?:唱|来|点|哼)/, '')
  rest = rest.replace(/^(?:首歌|一首|首|一段|一个|个|两句|句|下|一)/, '')
  rest = rest.replace(/^(?:歌|曲|首|的)/, '')
  rest = rest.replace(/^[\s，,。.：:、~～\-—《「]+/, '')
  const segment = rest.split(/[，,。！!？?；;\s《「【(（~～]/)[0] || ''
  return cleanTitle(segment)
}

/**
 * 渲染一段翻唱，返回 mp3 路径。
 * @param {{title: string, seconds?: number, log?: (line: string) => void}} params
 * @returns {Promise<{mp3Path: string, song: {title: string, artist: string}, durationMs: number, notes: string[]}>}
 */
export async function renderForQq(params) {
  const singer = await loadSinger()
  if (!singer) {
    const error = new Error('dsh-qqmusic-plugin 未安装，无法点歌')
    error.code = 'SING_UNAVAILABLE'
    throw error
  }
  const seconds = Math.max(8, Math.min(45, Number(params && params.seconds) || singer.settings.defaultSeconds))
  const log = (params && params.log) || (() => {})
  const rendered = await singer.renderSinging(
    { keyword: params.title, mode: 'cover', seconds },
    singer.settings,
    log,
  )
  if (!rendered.mp3Path || !existsSync(rendered.mp3Path)) {
    const error = new Error('翻唱渲染没有产出可发送的音频')
    error.code = 'SING_RENDER_FAILED'
    throw error
  }
  return {
    mp3Path: rendered.mp3Path,
    song: rendered.song,
    durationMs: rendered.durationMs,
    notes: rendered.notes || [],
  }
}
