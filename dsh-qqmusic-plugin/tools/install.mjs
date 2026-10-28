#!/usr/bin/env node
/**
 * Install / uninstall the dsh-qqmusic plugin in the current DSH profile.
 *
 *   node tools/install.mjs                # copy to <DSH_HOME>/dsh-qqmusic-plugin, patch profile
 *   node tools/install.mjs --remove       # drop the managed patch block (files stay)
 *   node tools/install.mjs --patch-only   # only patch; assume the files are in place
 *   node tools/install.mjs --target DIR   # custom install directory
 *
 * The profile patch is the same mechanism the other local plugins use: one
 * `- insert:` entry pointing at the plugin's index.mjs, wrapped in markers so a
 * re-run replaces it instead of stacking duplicates.
 *
 * After installing, DSH has to load the host plugin. If the profile patch is
 * watched the new tools appear immediately; otherwise restart DeepSeek Harness.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH_HOME = (process.env.DSH_HOME || join(homedir(), '.dsh')).replace(/\\/g, '/');
const PROFILE_DIR = (process.env.DSH_PROFILE_DIR || join(DSH_HOME, 'profiles', 'desktop')).replace(/\\/g, '/');
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml');
const PLUGIN_ID = 'dsh-qqmusic';
const BLOCK_BEGIN = '# >>> dsh-qqmusic (managed by dsh-qqmusic-plugin) >>>';
const BLOCK_END = '# <<< dsh-qqmusic <<<';

/** Defaults written into the patch; the plugin itself has the same defaults. */
const DEFAULT_RVC_ROOT = 'D:/Administrator/Documents/rvc';
const DEFAULT_WORKSPACE = 'D:/Administrator/Documents/data/workspace';

const argv = process.argv.slice(2);
const remove = argv.includes('--remove');
const patchOnly = argv.includes('--patch-only');
const targetIndex = argv.indexOf('--target');
const installDir = (
  targetIndex >= 0 && argv[targetIndex + 1] ? resolve(argv[targetIndex + 1]) : join(DSH_HOME, 'dsh-qqmusic-plugin')
).replace(/\\/g, '/');

if (!existsSync(PATCH_FILE)) {
  console.error(`找不到 profile patch：${PATCH_FILE}`);
  process.exit(1);
}

if (remove) {
  writeWithBackup(PATCH_FILE, stripBlock(readFileSync(PATCH_FILE, 'utf8')));
  console.log(`已从 ${PATCH_FILE} 移除 dsh-qqmusic 入口。`);
  console.log('重启 DeepSeek Harness 后生效（或在被监视时自动重载）。');
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
        const normalized = source.replace(/\\/g, '/');
        if (normalized.includes('/.work')) return false;
        if (normalized.includes('/.git/')) return false;
        return true;
      },
    });
  } else {
    console.log(`插件就地在 ${installDir}，跳过复制。`);
  }
}

const entry = [
  BLOCK_BEGIN,
  '- insert:',
  `    - id: ${PLUGIN_ID}`,
  `      name: "file:///${installDir}/index.mjs"`,
  '      config:',
  '        enabled: true',
  '        promptEnabled: true',
  `        rvcRoot: "${DEFAULT_RVC_ROOT}"`,
  '        model: "Paimon"',
  '        autoPitch: true',
  '        defaultSeconds: 30',
  '        maxSeconds: 45',
  `        workDir: "${DEFAULT_RVC_ROOT}/songs/qqmusic"`,
  `        workspace: "${DEFAULT_WORKSPACE}"`,
  '        hookUrl: "http://127.0.0.1:30001"',
  BLOCK_END,
].join('\n');

const next = `${stripBlock(readFileSync(PATCH_FILE, 'utf8')).replace(/\s+$/, '')}\n${entry}\n# reload touch ${new Date().toISOString()}\n`;
writeWithBackup(PATCH_FILE, next);

console.log(`已写入 profile patch：${PATCH_FILE}`);
console.log(`插件目录：${installDir}`);
console.log('');
console.log('下一步：让 DSH 重新加载 host 插件（被监视时会自动重载，否则重启 DeepSeek Harness）。');
console.log('验证：微信里说「唱首歌，起风了」；或看日志 %USERPROFILE%\\.dsh\\qqmusic\\qqmusic.log');

/**
 * Remove a previously managed block, including the reload-touch comment right
 * after it, without touching the user's own entries.
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
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`${file}.bak-${stamp}`, readFileSync(file));
  writeFileSync(file, content);
}
