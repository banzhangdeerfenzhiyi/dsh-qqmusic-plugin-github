#!/usr/bin/env node
/**
 * Lift the QQ Music account session straight out of the running Windows client.
 *
 * The client is normally already logged in (that is where the subscription is),
 * so this is the zero-interaction way to give the plugin a member cookie:
 * `tools/qq-lift-cookie.ps1` scans QQMusic.exe memory for the web cookie the
 * client keeps for its embedded requests, and this wrapper persists it.
 *
 *   node tools/lift-cookie.mjs            # lift + save to ~/.dsh/qqmusic/cookie.json
 *   node tools/lift-cookie.mjs --print    # also print the cookie
 *   node tools/lift-cookie.mjs --check    # only print the saved account
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCookieFile, readAuth, writeAuth } from '../src/qqauth.mjs';

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
const PS1 = join(TOOLS_DIR, 'qq-lift-cookie.ps1');
const argv = process.argv.slice(2);
const cookieFile = defaultCookieFile();

if (argv.includes('--check')) {
  const auth = readAuth(cookieFile);
  console.log(auth ? JSON.stringify(auth, null, 2) : '还没有保存登录态');
  process.exit(auth ? 0 : 2);
}

const run = spawnSync(
  'powershell',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-Json'],
  { encoding: 'utf8', timeout: 240_000, windowsHide: true },
);
const stdout = String(run.stdout ?? '').trim();
const stderr = String(run.stderr ?? '').trim();
const jsonLine = stdout
  .split(/\r?\n/)
  .reverse()
  .find((line) => line.trim().startsWith('{'));
if (!jsonLine) {
  console.error('提取失败：');
  console.error(stdout || stderr || `powershell exit ${run.status}`);
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(jsonLine);
} catch (error) {
  console.error('解析输出失败：', jsonLine.slice(0, 300));
  process.exit(1);
}
if (!parsed.ok) {
  console.error(`提取失败：${parsed.error}`);
  console.error('（先打开并登录 QQ 音乐客户端，再运行一次）');
  process.exit(1);
}
const file = writeAuth(cookieFile, { uin: parsed.uin, key: parsed.key, raw: parsed.raw });
console.log(`已从 QQ 音乐客户端提取登录态：uin=${parsed.uin}`);
console.log(`已保存 -> ${file}`);
if (argv.includes('--print')) {
  console.log(`cookie: ${parsed.raw}`);
} else {
  console.log('验证会员：node tools/qq-status.mjs');
}
