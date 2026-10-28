#!/usr/bin/env node
/**
 * Check what a QQ Music login can actually play — i.e. "which account has the
 * membership".
 *
 *   node tools/qq-status.mjs                              # check the saved cookie
 *   node tools/qq-status.mjs --cookie "uin=...; qqmusic_key=..."   # check a pasted cookie
 *   node tools/qq-status.mjs --cookie "..." --save         # also persist it for the plugin
 *
 * Two checks:
 *  1. functional: resolve a *subscription-only* track (VIP) at 320k/128k and
 *     confirm the CDN returns bytes — this is what the singing pipeline needs;
 *  2. vip flags: ask the account-info endpoints for the membership level, for a
 *     human-readable answer.
 */
import { writeAuth } from '../src/qqauth.mjs';
import { downloadSong, rankCandidates, resolvePlayable, searchSongs } from '../src/qqmusic.mjs';
import { readAuth } from '../src/qqauth.mjs';
import { defaultCookieFile } from '../src/qqauth.mjs';

const argv = process.argv.slice(2);
const cookieArgIndex = argv.indexOf('--cookie');
const pasted = cookieArgIndex >= 0 ? argv[cookieArgIndex + 1] : undefined;
const save = argv.includes('--save');
const cookieFile = defaultCookieFile();

/** @param {string} text @returns {Record<string,string>} */
function parseCookie(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const part of String(text ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

let auth;
if (pasted) {
  const parsed = parseCookie(pasted);
  const uin = parsed.qqmusic_uin ?? parsed.uin ?? parsed.musicid ?? parsed.wxuin ?? parsed.euinneruin ?? '';
  const key = parsed.qqmusic_key ?? parsed.qm_keyst ?? parsed.musickey ?? '';
  if (uin === '' || key === '') {
    console.error('cookie 里没找到 uin 或 qqmusic_key，检查是否复制完整');
    process.exit(2);
  }
  auth = { uin: String(uin).replace(/^o/, ''), key: String(key), guid: '' };
  console.log(`使用粘贴的 cookie：uin=${auth.uin} key=${auth.key.slice(0, 8)}…`);
  if (save) {
    writeAuth(cookieFile, auth);
    console.log(`已保存到 ${cookieFile}`);
  }
} else {
  auth = readAuth(cookieFile);
  if (!auth) {
    console.error(`没有找到登录态（${cookieFile}）；用 --cookie "..." 传进来`);
    process.exit(2);
  }
  console.log(`使用已保存的 cookie：uin=${auth.uin}`);
}

// ---------------------------------------------------------------- functional
const songs = await searchSongs('晴天 周杰伦', 10);
const vipSong = songs.find((song) => !song.free) ?? songs[0];
if (!vipSong) {
  console.error('搜索不到测试用的会员歌曲');
  process.exit(1);
}
console.log(`\n[1] 会员音源测试：《${vipSong.title}》 - ${vipSong.artist}（free=${vipSong.free}）`);
let functionalOk = false;
try {
  const playable = await resolvePlayable(vipSong, auth ?? undefined);
  console.log(`    解析成功：${playable.quality} ${playable.format}`);
  const downloaded = await downloadSong(vipSong, './.work/status-probe', () => {}, auth ?? undefined);
  console.log(`    下载成功：${downloaded.bytes} bytes（${downloaded.cached ? '缓存' : '新下载'}）`);
  functionalOk = downloaded.bytes > 400_000;
} catch (error) {
  console.log(`    解析/下载失败：${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.detail) console.log(`    详情：${String(error.detail).slice(0, 200)}`);
}

// ---------------------------------------------------------------- vip flags
console.log('\n[2] 会员状态接口：');
const musicu = async (moduleName, method, param) => {
  const response = await fetch('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Referer: 'https://y.qq.com/',
      Cookie: `uin=${auth.uin}; qqmusic_key=${auth.key}; qm_keyst=${auth.key};`,
    },
    body: JSON.stringify({
      req_0: { module: moduleName, method, param },
      comm: { ct: 24, cv: 0, format: 'json', uin: auth.uin, authst: auth.key },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text)?.req_0 ?? { raw: text.slice(0, 200) };
  } catch {
    return { raw: text.slice(0, 200) };
  }
};

const probes = [
  ['music.musicVip.VipInfoServer', 'GetVipInfo', {}],
  ['music.vip.VipInfoServer', 'CgiGetVipInfo', {}],
  ['music.musicVip.VipInfo', 'GetVipInfo', {}],
  ['music.UserInfo.userInfoServer', 'GetUserInfo', {}],
];
for (const [moduleName, method, param] of probes) {
  try {
    const data = await musicu(moduleName, method, param);
    const payload = data?.data ?? data;
    const interesting = JSON.stringify(payload).slice(0, 400);
    console.log(`    ${moduleName}/${method}: code=${data?.code ?? '?'} ${interesting}`);
  } catch (error) {
    console.log(`    ${moduleName}/${method}: ERR ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`\n结论：${functionalOk ? '这个账号可以播放会员/高音质音源 ✅' : '这个账号拿不到会员音源 ❌（可能不是会员账号，或登录态不完整）'}`);
if (functionalOk && !save && pasted) console.log('提示：加 --save 可以把这份登录态保存给插件用');
process.exit(functionalOk ? 0 : 1);
