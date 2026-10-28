/**
 * QQ Music web API client (unofficial, the same endpoints y.qq.com uses).
 *
 *   search   GET  c.y.qq.com/soso/fcgi-bin/client_search_cp      (old but stable)
 *   vkey     POST u.y.qq.com/cgi-bin/musicu.fcg                  (vkey.GetVkeyServer)
 *   download GET  dl.stream.qqmusic.qq.com/<purl>                (128k mp3, free tracks)
 *   lyric    POST u.y.qq.com/cgi-bin/musicu.fcg                  (PlayLyricInfo)
 *
 * Only tracks whose `pay.pay_play` is 0 expose a playable URL without a login,
 * which is the whole reason `resolvePlayable` walks the candidate list instead
 * of trusting the first search hit.
 *
 * Everything here is plain `fetch` (Node >= 22), no dependency.
 */
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { cookieHeader } from './qqauth.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://y.qq.com/';
const SEARCH_URL = 'https://c.y.qq.com/soso/fcgi-bin/client_search_cp';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const CDN_URL = 'https://dl.stream.qqmusic.qq.com/';

/** A failure with a message intended for the agent / user. */
export class QQMusicError extends Error {
  /** @param {string} message @param {string} [detail] */
  constructor(message, detail) {
    super(message);
    this.name = 'QQMusicError';
    this.detail = detail;
  }
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function fetchJson(url, init = {}, timeoutMs = 15_000) {
  const response = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': UA,
      Referer: REFERER,
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new QQMusicError(`QQ 音乐接口返回 HTTP ${response.status}`, text.slice(0, 200));
  try {
    return JSON.parse(text);
  } catch {
    throw new QQMusicError('QQ 音乐接口返回的不是 JSON', text.slice(0, 200));
  }
}

/**
 * POST one musicu.fcg request envelope.
 *
 * @param {string} module
 * @param {string} method
 * @param {Record<string, unknown>} param
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
async function musicu(module, method, param, timeoutMs = 15_000, extraHeaders = {}, commOverrides = {}) {
  const data = await fetchJson(
    MUSICU_URL,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...extraHeaders },
      body: JSON.stringify({
        req_0: { module, method, param },
        comm: { uin: 0, format: 'json', ct: 24, cv: 0, ...commOverrides },
      }),
    },
    timeoutMs,
  );
  return data?.req_0 ?? {};
}

/**
 * Normalize one search row into the small shape the rest of the plugin uses.
 *
 * @param {Record<string, any>} row
 * @returns {{title: string, artist: string, mid: string, mediaMid: string, interval: number, free: boolean, tryBeginMs: number, tryEndMs: number}}
 */
function normalizeSong(row) {
  const singer = Array.isArray(row?.singer)
    ? row.singer.map((item) => item?.name).filter((name) => typeof name === 'string' && name !== '')
    : [];
  const file = row?.file ?? {};
  const preview = row?.preview ?? {};
  return {
    title: String(row?.name ?? row?.title ?? row?.songname ?? '').trim(),
    artist: singer.join('/'),
    mid: String(row?.mid ?? row?.songmid ?? ''),
    mediaMid: String(file.strMediaMid ?? row?.strMediaMid ?? row?.media_mid ?? ''),
    interval: Number(row?.interval) || 0,
    free: Number(row?.pay?.pay_play ?? row?.pay?.payplay ?? 1) === 0,
    tryBeginMs: Number(file.try_begin ?? preview.trybegin ?? 0) || 0,
    tryEndMs: Number(file.try_end ?? preview.tryend ?? 0) || 0,
  };
}

/**
 * Search QQ Music.
 *
 * @param {string} keyword
 * @param {number} [limit]
 * @returns {Promise<ReturnType<typeof normalizeSong>[]>}
 */
export async function searchSongs(keyword, limit = 10) {
  const term = String(keyword ?? '').trim();
  if (term === '') throw new QQMusicError('要搜的歌名是空的。');
  const count = Math.min(30, Math.max(1, Math.round(limit)));
  const data = await fetchJson(
    `${SEARCH_URL}?w=${encodeURIComponent(term)}&format=json&n=${count}&p=1&cr=1&new_json=1&t=0`,
  );
  const list = data?.data?.song?.list;
  if (!Array.isArray(list)) return [];
  return list.map(normalizeSong).filter((song) => song.mid !== '');
}

/**
 * How well one search row matches the requested keyword (0 = unrelated).
 *
 * QQ Music's search is fuzzy — a nonsense query still returns eight rows — so
 * the singing pipeline uses this to decide between "sing the top hit" and "say
 * I don't know that song". Handles the common "artist + title" phrasing by also
 * accepting a title contained in the keyword.
 *
 * @param {string} keyword
 * @param {ReturnType<typeof normalizeSong>} song
 * @returns {number}
 */
export function matchScore(keyword, song) {
  const wanted = normalizeTitle(keyword);
  const title = normalizeTitle(song.title);
  const artist = normalizeTitle(song.artist);
  if (wanted === '' || title === '') return 0;
  let score = 0;
  if (title === wanted) score = 100;
  else if (title.length >= 2 && wanted.startsWith(title)) score = 70;
  else if (title.length >= 2 && title.startsWith(wanted)) score = 65;
  else if (title.includes(wanted)) score = 45;
  else if (title.length >= 2 && wanted.includes(title)) score = 35;
  if (score > 0 && artist.length >= 2 && wanted.includes(artist)) score += 20;
  return score;
}

/**
 * Pick the candidates worth trying, best first: exact title, then title prefix,
 * then the rest — with the requested artist floating up when given.
 *
 * @param {ReturnType<typeof normalizeSong>[]} songs
 * @param {string} title
 * @param {string} [artist]
 * @param {{preferVip?: boolean}} [options] - with a member account the
 *   subscription/master versions are the real ones; free rows are often covers.
 * @returns {ReturnType<typeof normalizeSong>[]}
 */
export function rankCandidates(songs, title, artist = '', options = {}) {
  const wantedArtist = String(artist ?? '').trim().toLowerCase();
  const preferVip = options.preferVip === true;
  const scored = songs.map((song) => {
    let score = matchScore(title, song);
    if (wantedArtist !== '' && song.artist.toLowerCase().includes(wantedArtist)) score += 30;
    if (preferVip) {
      // Member account: the "needs membership" rows are usually the original
      // artist/master recording, while free rows are often cheap covers.
      if (!song.free) score += 8;
      if (song.interval >= 180) score += 2;
    } else if (song.free) {
      score += 5;
    }
    return { song, score };
  });
  scored.sort((left, right) => right.score - left.score);
  return scored.map((item) => item.song);
}

/**
 * Strip the decoration QQ Music puts in titles ("(Live)" / "（旧版）") so the
 * exact-match test is not defeated by brackets.
 *
 * @param {string} title
 * @returns {string}
 */
function normalizeTitle(title) {
  return String(title ?? '')
    .replace(/[\(（\[【].*?[\)）\]】]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * Resolve a playable CDN path for one song.
 *
 * Anonymous requests only get the free tier; when an account cookie is present
 * the same request is signed, which is what unlocks subscription tracks and the
 * higher bitrates. `filename` picks the asset explicitly:
 *
 *   M800…mp3  320k (subscription)   M500…mp3  128k mp3   C400…m4a  128k AAC
 *
 * @param {ReturnType<typeof normalizeSong>} song
 * @param {import('./qqauth.mjs').QqAuth} [auth]
 * @returns {Promise<{url: string, format: 'mp3'|'m4a', quality: string}>}
 */
export async function resolvePlayable(song, auth) {
  if (!song?.mid) throw new QQMusicError('这首歌没有 songmid，无法解析播放地址。');
  const attempts = [];
  if (auth && song.mediaMid) attempts.push({ filename: `M800${song.mediaMid}.mp3`, format: 'mp3', quality: '320k' });
  if (song.mediaMid) attempts.push({ filename: `M500${song.mediaMid}.mp3`, format: 'mp3', quality: '128k' });
  attempts.push({ filename: '', format: 'm4a', quality: '128k' });

  const headers = auth ? { Cookie: cookieHeader(auth) } : {};
  const comm = {
    uin: auth ? Number(auth.uin) || 0 : 0,
    format: 'json',
    ct: 24,
    cv: 0,
    ...(auth ? { authst: auth.key } : {}),
  };
  let lastResult = '';
  for (const attempt of attempts) {
    /** @type {Record<string, unknown>} */
    const param = {
      guid: auth?.guid ?? '10000',
      songmid: [song.mid],
      songtype: [0],
      uin: auth ? auth.uin : '0',
      loginflag: 1,
      platform: '20',
    };
    if (attempt.filename !== '') param.filename = [attempt.filename];
    const data = await musicu('vkey.GetVkeyServer', 'CgiGetVkey', param, 15_000, headers, comm);
    const info = data?.data?.midurlinfo?.[0] ?? {};
    const purl = String(info.purl ?? '');
    if (purl !== '') {
      // Some responses hand back an absolute URL, most a CDN-relative path.
      const url = purl.startsWith('http') ? purl : `${CDN_URL}${purl}`;
      return { url, format: attempt.format, quality: attempt.quality };
    }
    lastResult = String(info.result ?? info.errtype ?? '');
  }
  throw new QQMusicError(
    auth
      ? `《${song.title}》解析不到播放地址（会员也拿不到，可能受专辑购买/版权限制），换一首试试`
      : `《${song.title}》没有免费音源（QQ 音乐要会员），换一首试试`,
    lastResult === '' ? 'purl empty' : `result=${lastResult}`,
  );
}

/**
 * Download a resolved track into `cacheDir`, reusing an existing file.
 *
 * @param {ReturnType<typeof normalizeSong>} song
 * @param {string} cacheDir
 * @param {(line: string) => void} log
 * @param {import('./qqauth.mjs').QqAuth} [auth]
 * @returns {Promise<{path: string, bytes: number, cached: boolean, format: string, quality: string}>}
 */
export async function downloadSong(song, cacheDir, log, auth) {
  const playable = await resolvePlayable(song, auth);
  mkdirSync(cacheDir, { recursive: true });
  const suffix = playable.format === 'mp3' ? '.mp3' : '.m4a';
  const target = `${cacheDir}/song${suffix}`;
  if (isUsableFile(target)) {
    log(`download: cached ${target}`);
    return { path: target, bytes: sizeOf(target), cached: true, format: playable.format, quality: playable.quality };
  }
  const response = await fetch(playable.url, {
    headers: { 'User-Agent': UA, Referer: REFERER, Accept: '*/*', ...(auth ? { Cookie: cookieHeader(auth) } : {}) },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new QQMusicError(`下载失败（HTTP ${response.status}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < 64 * 1024) throw new QQMusicError('下载到的音频太小，可能不是有效文件');
  writeFileSync(target, buffer);
  log(`download: ${song.title} ${buffer.length} bytes (${playable.format}, ${playable.quality}) -> ${target}`);
  return { path: target, bytes: buffer.length, cached: false, format: playable.format, quality: playable.quality };
}

/**
 * Fetch the LRC lyric text for a song (synced lines kept as-is).
 *
 * @param {string} mid
 * @returns {Promise<string>}
 */
export async function fetchLyric(mid) {
  if (!mid) return '';
  try {
    const data = await musicu('music.musichallSong.PlayLyricInfo', 'GetPlayLyricInfo', {
      songMID: mid,
      songID: 0,
      format: 0,
    });
    const lyric = String(data?.data?.lyric ?? '');
    return lyric !== '' ? Buffer.from(lyric, 'base64').toString('utf8') : '';
  } catch {
    return '';
  }
}

/** @param {string} path @returns {boolean} */
function isUsableFile(path) {
  return sizeOf(path) > 64 * 1024;
}

/** @param {string} path @returns {number} */
function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
