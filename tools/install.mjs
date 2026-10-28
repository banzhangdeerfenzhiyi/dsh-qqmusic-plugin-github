#!/usr/bin/env node
/**
 * Install / uninstall dsh-qqmusic-plugin for a DeepSeek Harness profile.
 *
 *   node tools/install.mjs                          # copy to <DSH_HOME>/dsh-qqmusic-plugin + patch profile
 *   node tools/install.mjs --profile desktop        # pick a specific profile
 *   node tools/install.mjs --rvc-root D:/rvc        # write an explicit RVC root into the config
 *   node tools/install.mjs --workspace D:/wa        # WeChatAgent workspace root
 *   node tools/install.mjs --remove                # drop the managed patch block (files stay)
 *   node tools/install.mjs --patch-only            # only patch; assume the files are in place
 *   node tools/install.mjs --target DIR            # custom install directory
 *   node tools/install.mjs --no-deps               # do not try `npm install`
 *
 * The profile patch gets one `- insert:` entry pointing at the plugin's
 * index.mjs, wrapped in markers so re-running replaces it instead of stacking
 * duplicates. Paths that can be auto-detected on this machine are written into
 * the config so a fresh install usually needs no hand editing.
 *
 * After installing, DSH has to load the host plugin: restart DeepSeek Harness
 * (or let a watcher reload it) and check ~/.dsh/qqmusic/qqmusic.log.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/$/, '');
const PLUGIN_ID = 'dsh-qqmusic';
const BLOCK_BEGIN = '# >>> dsh-qqmusic (managed by dsh-qqmusic-plugin) >>>';
const BLOCK_END = '# <<< dsh-qqmusic <<<';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined;
};

const remove = flag('--remove');
const patchOnly = flag('--patch-only');
const noDeps = flag('--no-deps');

// ---------------------------------------------------------------- paths

/** @param {string} value @returns {string} */
function slash(value) {
  return String(value).replace(/\\/g, '/').replace(/\/$/, '');
}

/** Find the profile directory to patch. */
function findProfileDir() {
  const explicit = value('--profile') || process.env.DSH_PROFILE;
  if (explicit) {
    const dir = join(DSH_HOME, 'profiles', explicit);
    if (existsSync(join(dir, 'cordis.patch.yml'))) return dir;
    throw new Error(`profile "${explicit}" 下没有 cordis.patch.yml：${dir}`);
  }
  const profiles = join(DSH_HOME, 'profiles');
  const preferred = join(profiles, 'desktop');
  if (existsSync(join(preferred, 'cordis.patch.yml'))) return preferred;
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(profiles, entry.name);
      if (existsSync(join(dir, 'cordis.patch.yml'))) return dir;
    }
  }
  throw new Error(`找不到任何 DSH profile：${profiles}`);
}

const profileDir = remove || patchOnly ? findProfileDir() : findProfileDir();
const patchFile = join(profileDir, 'cordis.patch.yml');
const installDir = slash(
  value('--target') ? resolve(value('--target')) : join(DSH_HOME, 'dsh-qqmusic-plugin'),
);

// ---------------------------------------------------------------- detection

/**
 * Find an RVC installation (folder with applio/core.py).
 * Order: CLI flag → RVC_ROOT env → ~/rvc → ~/Documents/rvc → <DSH_HOME>/rvc.
 *
 * @returns {string}
 */
function detectRvcRoot() {
  const candidates = [
    slash(value('--rvc-root') || ''),
    slash(process.env.RVC_ROOT || ''),
    slash(join(homedir(), 'rvc')),
    slash(join(homedir(), 'Documents', 'rvc')),
    `${DSH_HOME}/rvc`,
  ].filter((item) => item !== '');
  for (const root of candidates) {
    if (existsSync(join(root, 'applio', 'core.py')) || existsSync(join(root, 'core.py'))) return root;
  }
  return '';
}

/**
 * Find a WeChatAgent workspace (folder with state/accounts + config/wechatagent.json).
 * Order: CLI flag → WECHATAGENT_WORKSPACE env → ~/Documents/data/workspace →
 * ~/WeChatAgent → <DSH_HOME>/wechatagent.
 *
 * @returns {string}
 */
function detectWorkspace() {
  const candidates = [
    slash(value('--workspace') || ''),
    slash(process.env.WECHATAGENT_WORKSPACE || ''),
    slash(join(homedir(), 'Documents', 'data', 'workspace')),
    slash(join(homedir(), 'WeChatAgent')),
    `${DSH_HOME}/wechatagent`,
  ].filter((item) => item !== '');
  for (const root of candidates) {
    if (existsSync(join(root, 'state', 'accounts')) && existsSync(join(root, 'config', 'wechatagent.json'))) {
      return root;
    }
  }
  return '';
}

// ---------------------------------------------------------------- actions

if (remove) {
  writeWithBackup(patchFile, stripBlock(readFileSync(patchFile, 'utf8')));
  console.log(`已从 ${patchFile} 移除 dsh-qqmusic 入口。`);
  console.log('重启 DeepSeek Harness 后生效（或被监视时自动重载）。');
  process.exit(0);
}

if (!patchOnly) {
  if (resolve(installDir) !== resolve(PLUGIN_ROOT)) {
    console.log(`复制插件：${PLUGIN_ROOT} -> ${installDir}`);
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(installDir, { recursive: true });
    cpSync(PLUGIN_ROOT, installDir, {
      recursive: true,
      filter: (source) => {
        const normalized = slash(source);
        if (normalized.includes('/.work')) return false;
        if (normalized.includes('/.git/')) return false;
        if (normalized.includes('/.qr')) return false;
        if (normalized.includes('/node_modules/')) return false;
        return true;
      },
    });
  } else {
    console.log(`插件就地在 ${installDir}，跳过复制。`);
  }

  // One runtime dependency (silk-wasm). Try to install it so the plugin can be
  // used without a second manual step; failures are explained, not fatal.
  if (!noDeps && !existsSync(join(installDir, 'node_modules', 'silk-wasm'))) {
    console.log('安装运行依赖 silk-wasm（npm install）…');
    const result = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
      cwd: installDir,
      stdio: 'inherit',
      shell: true,
    });
    if (result.status !== 0) {
      console.warn('npm install 失败，请手动执行：cd "' + installDir + '" && npm install');
    }
  }
}

const rvcRoot = detectRvcRoot();
const workspace = detectWorkspace();
const entry = [
  BLOCK_BEGIN,
  '- insert:',
  `    - id: ${PLUGIN_ID}`,
  `      name: "file:///${installDir}/index.mjs"`,
  '      config:',
  '        enabled: true',
  '        promptEnabled: true',
  ...(rvcRoot !== '' ? [`        rvcRoot: "${rvcRoot}"`] : []),
  '        model: "Paimon"',
  '        autoPitch: true',
  '        defaultSeconds: 30',
  '        maxSeconds: 45',
  ...(workspace !== '' ? [`        workspace: "${workspace}"`] : []),
  '        hookUrl: "http://127.0.0.1:30001"',
  '        autoSingEnabled: true',
  '        authEnabled: true',
  BLOCK_END,
].join('\n');

writeWithBackup(patchFile, `${stripBlock(readFileSync(patchFile, 'utf8')).replace(/\s+$/, '')}\n${entry}\n`);

console.log('');
console.log(`profile patch：${patchFile}`);
console.log(`插件目录：${installDir}`);
console.log(`RVC 根目录：${rvcRoot || '未检测到（请设置 config.rvcRoot 或 RVC_ROOT 环境变量）'}`);
console.log(`WeChatAgent 工作区：${workspace || '未检测到（请设置 config.workspace 或 WECHATAGENT_WORKSPACE）'}`);
console.log('');
console.log('下一步：');
console.log('  1) 重启 DeepSeek Harness（host 插件只在启动时加载）');
console.log(`  2) 查看日志：${DSH_HOME}/qqmusic/qqmusic.log`);
console.log('  3) 微信里说「唱首稻香」试试；不想等可以先用：node tools/live-sing.mjs --keyword "稻香"');
console.log('  4) 想用会员音源：node tools/lift-cookie.mjs 然后 node tools/qq-status.mjs');
console.log('  5) QQ 端点歌（可选）：node tools/patch-qqfish.mjs');

// ---------------------------------------------------------------- helpers

/**
 * Remove a previously managed block (and the old reload-touch line), leaving the
 * user's own entries untouched.
 *
 * @param {string} text
 * @returns {string}
 */
function stripBlock(text) {
  const lines = text.split(/\r?\n/);
  const kept = [];
  let inside = false;
  for (const line of lines) {
    if (line.trim() === BLOCK_BEGIN) {
      inside = true;
      continue;
    }
    if (inside && line.trim() === BLOCK_END) {
      inside = false;
      continue;
    }
    if (inside) continue;
    if (line.startsWith('# reload touch ')) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/** @param {string} file @param {string} content */
function writeWithBackup(file, content) {
  if (existsSync(file)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    writeFileSync(`${file}.bak-${stamp}`, readFileSync(file));
  }
  writeFileSync(file, content);
}
