/**
 * QQ Music account credentials (optional).
 *
 * Anonymous requests only ever see the free tier: every track with
 * `pay.pay_play = 1` resolves to an empty `purl`. With a logged-in account that
 * has a QQ Music subscription, the same vkey request returns a playable URL when
 * the cookie (`uin` + `qqmusic_key`) is attached.
 *
 * The cookie lives in a small JSON file so it survives plugin reloads and can be
 * produced by `tools/qq-login.mjs` (QR login) instead of being pasted into the
 * profile patch.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

/**
 * @typedef {{uin: string, key: string, guid: string, savedAt?: string, nickname?: string}} QqAuth
 */

/**
 * Default cookie location. Overridable through the plugin config; `DSH_HOME`
 * (if set) wins over `~/.dsh` so the same file is shared with the DSH profile.
 *
 * @returns {string}
 */
export function defaultCookieFile() {
  const home = process.env.DSH_HOME || `${homedir()}/.dsh`;
  return `${String(home).replace(/\\/g, '/').replace(/\/$/, '')}/qqmusic/cookie.json`;
}

/**
 * Read the account cookie from disk. Returns undefined when absent/incomplete;
 * a malformed file is ignored (the plugin simply stays in free tier mode).
 *
 * @param {string} cookieFile
 * @returns {QqAuth|undefined}
 */
export function readAuth(cookieFile) {
  if (typeof cookieFile !== 'string' || cookieFile === '') return undefined;
  if (!existsSync(cookieFile)) return undefined;
  let data;
  try {
    const text = readFileSync(cookieFile, 'utf8').trim();
    if (text === '') return undefined;
    data = text.startsWith('{') ? JSON.parse(text) : parseCookieText(text);
  } catch {
    return undefined;
  }
  return normalizeAuth(data);
}

/**
 * Accept either a JSON object or a plain `key=value; key=value` cookie string.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
function parseCookieText(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const part of text.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

/**
 * @param {Record<string, any>} data
 * @returns {QqAuth|undefined}
 */
export function normalizeAuth(data) {
  if (!data || typeof data !== 'object') return undefined;
  const uin = String(
    data.uin ?? data.qqmusic_uin ?? data.musicid ?? data.wxuin ?? data.qq ?? '',
  ).trim();
  const key = String(
    data.qqmusic_key ??
      data.musicKey ??
      data.musickey ??
      data.qm_keyst ??
      data.key ??
      data['qqmusic_key'.toUpperCase()] ??
      '',
  ).trim();
  if (uin === '' || key === '') return undefined;
  const guid = String(data.guid ?? '').trim() || makeGuid();
  // A full cookie string (as lifted from the client) carries the WeChat-side
  // fields the web API wants; keep it when present and just use it verbatim.
  const raw = typeof data.raw === 'string' && data.raw.includes('qqmusic_key=') ? data.raw : '';
  return {
    uin,
    key,
    guid,
    ...(raw !== '' ? { raw } : {}),
    ...(typeof data.savedAt === 'string' ? { savedAt: data.savedAt } : {}),
    ...(typeof data.nickname === 'string' ? { nickname: data.nickname } : {}),
  };
}

/** A stable pseudo-device id, the way the web client's `guid` works. */
export function makeGuid() {
  let value = '';
  while (value.length < 10) value += String(Math.floor(Math.random() * 10));
  return value.slice(0, 10);
}

/**
 * Persist a freshly obtained account cookie.
 *
 * @param {string} cookieFile
 * @param {QqAuth} auth
 */
export function writeAuth(cookieFile, auth) {
  const normalized = normalizeAuth(auth);
  if (!normalized) throw new Error('cookie 缺少 uin 或 qqmusic_key，拒绝写入');
  if (!existsSync(dirname(cookieFile))) mkdirSync(dirname(cookieFile), { recursive: true });
  writeFileSync(
    cookieFile,
    `${JSON.stringify({ ...normalized, savedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  );
  return cookieFile;
}

/**
 * `Cookie:` header value for the QQ Music API.
 *
 * @param {QqAuth} auth
 * @returns {string}
 */
export function cookieHeader(auth) {
  if (typeof auth.raw === 'string' && auth.raw !== '') {
    // Trim a leading "=;" the client's cookie jar prints for its empty first slot.
    return auth.raw.replace(/^[=;]+/, '');
  }
  return `qqmusic_fromtag=54257; qqmusic_uin=${auth.uin}; qqmusic_key=${auth.key}; qm_keyst=${auth.key};`;
}

/**
 * Cheap freshness probe for logs: file mtime of the cookie file.
 *
 * @param {string} cookieFile
 * @returns {string}
 */
export function describeAuthSource(cookieFile) {
  try {
    return statSync(cookieFile).mtime.toISOString();
  } catch {
    return 'missing';
  }
}
