#!/usr/bin/env node
/**
 * QQ Music account login (QR code) — unlocks subscription tracks for the plugin.
 *
 *   node tools/qq-login.mjs                 # show QR, wait for the scan, save cookie
 *   node tools/qq-login.mjs --no-wait       # only fetch a fresh QR image
 *   node tools/qq-login.mjs --status        # print the saved account
 *   node tools/qq-login.mjs --clear         # forget the saved account
 *
 * Flow: QQ connect `ptqrshow` -> QR png + qrsig cookie; poll `ptqrlogin` until
 * the phone confirms; then exchange the login token for the QQ Music web cookie
 * (`uin` + `qqmusic_key`) through `music.login.LoginServer/Login`, and persist it
 * where the plugin reads it (`~/.dsh/qqmusic/cookie.json`).
 *
 * The QR is written to `<repo>/.qr/qqmusic-qr.png` (and upscaled 4x when Python
 * with Pillow is available) so it can be shown in a chat or opened on screen.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAuth, writeAuth } from '../src/qqauth.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const QR_DIR = join(PLUGIN_ROOT, '.qr');
const QR_PNG = join(QR_DIR, 'qqmusic-qr.png');
const COOKIE_FILE = `${homedir().replace(/\\/g, '/')}/.dsh/qqmusic/cookie.json`;

const APPID = '716027609';
const DAID = '383';
const PT_3RD_AID = '100497308';
const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const argv = process.argv.slice(2);
const noWait = argv.includes('--no-wait');
const statusOnly = argv.includes('--status');
const clear = argv.includes('--clear');
const waitSeconds = Number(argv[argv.indexOf('--wait') + 1]) || 180;

if (statusOnly) {
  const auth = readAuth(COOKIE_FILE);
  console.log(auth ? JSON.stringify(auth, null, 2) : '尚未登录（没有 cookie 文件）');
  process.exit(0);
}
if (clear) {
  try {
    writeFileSync(COOKIE_FILE, '{}\n');
  } catch {
    /* ignore */
  }
  console.log('已清除保存的登录状态（重启插件后回到免费模式）');
  process.exit(0);
}

/** Minimal cookie jar. */
const jar = new Map();

/** @param {string} url @param {RequestInit} [init] */
async function request(url, init = {}) {
  const cookie = [...jar.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: {
      'User-Agent': UA,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(25_000),
  });
  for (const header of response.headers.getSetCookie?.() ?? []) {
    const [pair] = header.split(';');
    const index = pair.indexOf('=');
    if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
  return response;
}

/** hash33 used by ptlogin for ptqrtoken. */
function hash33(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash += (hash << 5) + text.charCodeAt(index);
  }
  return hash & 0x7fffffff;
}

/**
 * Try to make the tiny 1-bit QR PNG easier to scan (4x nearest-neighbour) via
 * the RVC venv's Pillow. Silently keeps the original on failure.
 *
 * @param {string} pngPath
 */
async function upscaleQr(pngPath) {
  const { spawn } = await import('node:child_process');
  const python = 'D:/Administrator/Documents/rvc/venv312/Scripts/python.exe';
  if (!existsSync(python)) return;
  const script =
    `from PIL import Image\n` +
    `import sys\n` +
    `p=sys.argv[1]\n` +
    `im=Image.open(p).convert('L')\n` +
    `im=im.resize((im.width*4,im.height*4), Image.NEAREST)\n` +
    `im.save(p)\n`;
  await new Promise((resolve) => {
    const child = spawn(python, ['-c', script, pngPath], { stdio: 'ignore', windowsHide: true });
    child.on('close', resolve);
    child.on('error', resolve);
    setTimeout(resolve, 15_000);
  });
}

/**
 * GET a redirect chain with the cookie jar, following until it reaches y.qq.com
 * (or runs out of redirects); returns the final URL.
 *
 * @param {string} url
 * @param {number} [hops]
 * @returns {Promise<string>}
 */
async function follow(url, hops = 0) {
  if (hops > 8) return url;
  const response = await request(url);
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) return url;
    const next = new URL(location, url).toString();
    return follow(next, hops + 1);
  }
  return url;
}

/**
 * Exchange the QQ connect login token for the QQ Music web cookie.
 *
 * @param {string} uin
 * @param {string} pt4Token
 * @returns {Promise<{key: string, nickname?: string}>}
 */
async function exchangeForMusicKey(uin, pt4Token) {
  const body = {
    req_1: {
      module: 'music.login.LoginServer',
      method: 'Login',
      param: {
        loginType: 1,
        appid: '100497308',
        uin,
        pt4_token: pt4Token,
        pt_3rd_aid: '100497308',
      },
    },
    comm: { ct: 24, cv: 0, format: 'json', uin, tmeAppID: 'qqmusic' },
  };
  const response = await request(MUSICU_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`登录接口返回非 JSON：${text.slice(0, 160)}`);
  }
  const payload = data?.req_1?.data ?? {};
  const key =
    String(
      payload.qqmusic_key ??
        payload.musickey ??
        payload.musicKey ??
        payload.qm_keyst ??
        payload.key ??
        '',
    ).trim() ||
    // Some responses nest it deeper.
    findKeyLike(payload);
  if (key === '') {
    throw new Error(`登录接口没返回 key：${text.slice(0, 240)}`);
  }
  return { key, nickname: String(payload.nickname ?? payload.nick ?? '') };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function findKeyLike(value) {
  if (typeof value === 'string') {
    if (/^Q_H_L_|^qqmusic/i.test(value) && value.length > 40) return value;
    return '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findKeyLike(item);
      if (hit !== '') return hit;
    }
    return '';
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const hit = findKeyLike(item);
      if (hit !== '') return hit;
    }
  }
  return '';
}

// ---------------------------------------------------------------- run

mkdirSync(QR_DIR, { recursive: true });
const qrUrl =
  `https://ssl.ptlogin2.qq.com/ptqrshow?appid=${APPID}&e=2&l=M&s=3&d=72&v=4&t=${Math.random()}` +
  `&daid=${DAID}&pt_3rd_aid=${PT_3RD_AID}`;
const qrResponse = await request(qrUrl, { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } });
if (qrResponse.status !== 200) throw new Error(`获取二维码失败（HTTP ${qrResponse.status}）`);
const qrBytes = Buffer.from(await qrResponse.arrayBuffer());
if (qrBytes.length < 200) throw new Error(`二维码内容异常（${qrBytes.length} 字节）`);
writeFileSync(QR_PNG, qrBytes);
await upscaleQr(QR_PNG);
const qrsig = jar.get('qrsig') ?? '';
console.log(`二维码已生成：${QR_PNG}`);
console.log(`有效约 2 分钟；请用手机 QQ / QQ音乐 App 扫一扫（App 内可从相册选这张图）。`);

if (noWait) process.exit(0);

const pollUrl = () => {
  const params = new URLSearchParams({
    u1: 'https://graph.qq.com/oauth2.0/login_jump',
    ptqrtoken: String(hash33(qrsig)),
    ptredirect: '0',
    h: '1',
    t: '1',
    g: '1',
    from_ui: '1',
    ptlang: '2052',
    action: `0-0-${Date.now()}`,
    js_ver: '20102616',
    js_type: '1',
    login_sig: '',
    pt_uistyle: '40',
    aid: APPID,
    daid: DAID,
    pt_3rd_aid: PT_3RD_AID,
  });
  return `https://ssl.ptlogin2.qq.com/ptqrlogin?${params.toString()}`;
};

/** Parse `ptuiCB('code','sub','url','flag','message','nickname')`. */
function parseCallback(text) {
  const match = text.match(/ptuiCB\(([\s\S]*?)\)\s*;?/);
  if (!match) return undefined;
  const parts = [...match[1].matchAll(/'([^']*)'/g)].map((item) => item[1]);
  return { code: parts[0], url: parts[2] ?? '', message: parts[4] ?? '', nickname: parts[5] ?? '' };
}

const started = Date.now();
let lastState = '';
let result;
while ((Date.now() - started) / 1000 < waitSeconds) {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  let text;
  try {
    const response = await request(pollUrl(), { headers: { Referer: 'https://xui.ptlogin2.qq.com/' } });
    text = await response.text();
  } catch {
    continue;
  }
  const callback = parseCallback(text);
  if (!callback) continue;
  const state = `${callback.code}:${callback.message}`;
  if (state !== lastState) {
    lastState = state;
    console.log(`[${Math.round((Date.now() - started) / 1000)}s] ${callback.code} ${callback.message}`);
  }
  if (callback.code === '0') {
    result = callback;
    break;
  }
  if (callback.code === '65') continue; // scanned, waiting for the phone confirm
  if (callback.code === '67') break; // expired
}
if (!result) {
  console.error('登录未完成（二维码过期或超时）。重新运行本脚本再扫一次。');
  process.exit(1);
}

console.log('扫码成功，正在换取 QQ 音乐登录态…');
const finalUrl = await follow(result.url);
const uinFromUrl = new URL(finalUrl).searchParams.get('uin') ?? new URL(result.url).searchParams.get('uin') ?? '';
const uin =
  uinFromUrl || jar.get('uin') || jar.get('ptui_loginuin') || jar.get('p_uin') || '';
if (uin === '') throw new Error('登录成功但没解析到 QQ 号（uin），无法继续。');
const pt4Token = jar.get('pt4_token') ?? jar.get('pt4Token') ?? '';
if (pt4Token === '') throw new Error('登录成功但没有 pt4_token，无法换取 QQ 音乐 key。');

const { key, nickname } = await exchangeForMusicKey(uin, pt4Token);
writeAuth(COOKIE_FILE, { uin, key, ...(nickname ? { nickname } : {}) });
console.log(`已保存登录态：uin=${uin}${nickname ? ` (${nickname})` : ''} -> ${COOKIE_FILE}`);
console.log('插件下次请求会自动带上会员账号（无需重启）；想撤销用 --clear。');
