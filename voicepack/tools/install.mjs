#!/usr/bin/env node
/**
 * Install / uninstall dsh-voicepack-plugin in a DeepSeek Harness profile.
 *
 *   node tools/install.mjs                          # copy to <DSH_HOME>/dsh-voicepack-plugin + patch profile
 *   node tools/install.mjs --remove                # drop the managed patch block (files stay)
 *   node tools/install.mjs --target DIR            # custom install directory
 *   node tools/install.mjs --workspace DIR         # explicit WeChatAgent workspace
 *   node tools/install.mjs --rvc-root DIR          # explicit RVC root
 *   node tools/install.mjs --no-deps               # skip `npm install`
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/').replace(/\/$/, '');
const PLUGIN_ID = 'dsh-voicepack';
const BLOCK_BEGIN = '# >>> dsh-voicepack (managed by dsh-voicepack-plugin) >>>';
const BLOCK_END = '# <<< dsh-voicepack <<<';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : undefined;
};

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
  const preferred = join(DSH_HOME, 'profiles', 'desktop');
  if (existsSync(join(preferred, 'cordis.patch.yml'))) return preferred;
  const profiles = join(DSH_HOME, 'profiles');
  if (existsSync(profiles)) {
    for (const entry of readdirSync(profiles, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(profiles, entry.name);
      if (existsSync(join(dir, 'cordis.patch.yml'))) return dir;
    }
  }
  throw new Error(`找不到任何 DSH profile：${profiles}`);
}

/** @returns {string} */
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

/** @returns {string} */
function detectRvcRoot() {
  const candidates = [
    slash(value('--rvc-root') || ''),
    slash(process.env.RVC_ROOT || ''),
    slash(join(homedir(), 'rvc')),
    slash(join(homedir(), 'Documents', 'rvc')),
    `${DSH_HOME}/rvc`,
  ].filter((item) => item !== '');
  for (const root of candidates) {
    if (existsSync(join(root, 'applio', 'core.py'))) return root;
  }
  return '';
}

const installDir = slash(
  value('--target') ? resolve(value('--target')) : join(DSH_HOME, 'dsh-voicepack-plugin'),
);
const profileDir = findProfileDir();
const patchFile = join(profileDir, 'cordis.patch.yml');

if (flag('--remove')) {
  writeWithBackup(patchFile, normalizePatchAfterRemove(stripBlock(readFileSync(patchFile, 'utf8'))));
  console.log(`已从 ${patchFile} 移除 dsh-voicepack 入口。重启 DSH 后生效。`);
  process.exit(0);
}

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
      return true;
    },
  });
} else {
  console.log(`插件就地在 ${installDir}，跳过复制。`);
}

if (!flag('--no-deps') && !existsSync(join(installDir, 'node_modules', 'msedge-tts'))) {
  console.log('安装依赖（msedge-tts / mpg123-decoder / silk-wasm）…');
  const result = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
    cwd: installDir,
    stdio: 'inherit',
    shell: true,
  });
  if (result.status !== 0) {
    console.warn('npm install 失败，请手动执行：cd "' + installDir + '" && npm install');
  }
}

const workspace = detectWorkspace();
const rvcRoot = detectRvcRoot();
const entry = [
  BLOCK_BEGIN,
  '- insert:',
  `    - id: ${PLUGIN_ID}`,
  `      name: "file:///${installDir}/index.mjs"`,
  '      config:',
  '        enabled: true',
  '        promptEnabled: true',
  '        defaultVoice: "zh-CN-XiaoyiNeural"',
  '        maxCharsPerVoice: 120',
  '        maxVoicesPerCall: 3',
  '        rvcEnabled: true',
  ...(workspace !== '' ? [`        workspace: "${workspace}"`] : []),
  ...(rvcRoot !== '' ? [`        rvcRoot: "${rvcRoot}"`] : []),
  '        hookUrl: "http://127.0.0.1:30001"',
  BLOCK_END,
].join('\n');

writeWithBackup(
  patchFile,
  `${dropEmptyDocumentMarker(stripBlock(readFileSync(patchFile, 'utf8')))
    .replace(/\s+$/, '')}\n${entry}\n`,
);

console.log('');
console.log(`profile patch：${patchFile}`);
console.log(`插件目录：${installDir}`);
console.log(`WeChatAgent 工作区：${workspace || '未检测到（请设置 config.workspace 或 WECHATAGENT_WORKSPACE）'}`);
console.log(`RVC 根目录：${rvcRoot || '未检测到（可选；没有 RVC 时只用 Edge 音色）'}`);
console.log('重启 DeepSeek Harness 后生效。可用 `node tools/list-voices.mjs` 预览音色。');

// ---------------------------------------------------------------- helpers

/**
 * Drop a standalone empty-array document (`[]`) so appending a sequence entry
 * cannot create the invalid mix `[]` + `- insert:` at the top level.
 *
 * @param {string} text
 * @returns {string}
 */
function dropEmptyDocumentMarker(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[\s*\]\s*$/.test(line))
    .join('\n');
}

/**
 * Keep a patch file valid after removing our block: no entries must be `[]`.
 *
 * @param {string} text
 * @returns {string}
 */
function normalizePatchAfterRemove(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '[]');
  const body = lines.join('\n').replace(/\s+$/, '');
  const hasEntries = body.split(/\r?\n/).some((line) => /^\s*-\s/.test(line));
  if (!hasEntries) return `${body === '' ? '' : `${body}\n\n`}[]\n`;
  return `${body}\n`;
}

/**
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
