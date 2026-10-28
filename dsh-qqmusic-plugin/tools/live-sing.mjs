/**
 * Standalone live test / demo for the QQ Music singing pipeline.
 *
 * Runs the exact same code path the `sing_song` tool uses, without DSH:
 *
 *   node tools/live-sing.mjs --keyword "稻香"                    # cover, no send
 *   node tools/live-sing.mjs --keyword "稻香" --mode original --seconds 15
 *   node tools/live-sing.mjs --keyword "起风了" --send --chat wechat:private:693030550
 *
 * `--send` pushes the rendered SILK through the local WeChat hook to the given
 * chat key (resolved through the WeChatAgent reader API), which is how the tool
 * sends it normally.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolveSettings } from '../index.mjs';
import { createLogger } from '../src/log.mjs';
import { renderSinging } from '../src/singing.mjs';
import {
  readHookToken,
  resolveUsername,
  resolveWorkspace,
  storeSilk,
  submitVoice,
} from '../src/wechat.mjs';

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** @param {string[]} argv */
function parseArgs(argv) {
  const args = { mode: 'cover', seconds: undefined, start: undefined, send: false, chat: '', localSilk: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--send') args.send = true;
    else if (token === '--local-silk') args.localSilk = true;
    else if (token === '--keyword') args.keyword = argv[++index];
    else if (token === '--mode') args.mode = argv[++index];
    else if (token === '--seconds') args.seconds = Number(argv[++index]);
    else if (token === '--start') args.start = Number(argv[++index]);
    else if (token === '--chat') args.chat = argv[++index];
    else if (token === '--config') args.configPath = argv[++index];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (!args.keyword) {
  console.error('usage: node tools/live-sing.mjs --keyword "歌名" [--mode cover|original|acapella] [--seconds 30] [--start 60] [--send --chat wechat:private:693030550]');
  process.exit(2);
}

const fileConfig = args.configPath ? JSON.parse(readFileSync(args.configPath, 'utf8')) : {};
const settings = resolveSettings({ ...fileConfig, workDir: join(PLUGIN_ROOT, '.work') });
const log = createLogger('qqmusic-cli');
log(`cli: keyword=${args.keyword} mode=${args.mode} seconds=${args.seconds ?? settings.defaultSeconds} send=${args.send}`);

const started = Date.now();
const rendered = await renderSinging(
  {
    keyword: args.keyword,
    mode: args.mode,
    seconds: args.seconds,
    start: args.start,
  },
  settings,
  log,
);
const elapsed = Math.round((Date.now() - started) / 1000);

const outFile = join(settings.workDir, `rendered-${Date.now()}.silk`);
writeFileSync(outFile, rendered.silk);
console.log(
  JSON.stringify(
    {
      song: rendered.song,
      mode: rendered.mode,
      start: rendered.start,
      durationMs: rendered.durationMs,
      pitch: rendered.pitch,
      model: rendered.model,
      silkBytes: rendered.silk.length,
      notes: rendered.notes,
      elapsedSeconds: elapsed,
      silkFile: outFile,
    },
    null,
    2,
  ),
);

if (args.send) {
  const chatKey = args.chat || 'wechat:private:693030550';
  const workspace = resolveWorkspace(settings.workspace);
  const target = await resolveUsername(workspace, chatKey);
  const token = readHookToken(workspace);
  let silkPath;
  let md5;
  if (args.localSilk) {
    // The hook reads whatever absolute path it is given; keeping the file in the
    // dev workspace lets the CLI run without write access to the hook workspace.
    const dir = join(PLUGIN_ROOT, '.work', 'outgoing');
    mkdirSync(dir, { recursive: true });
    md5 = createHash('md5').update(rendered.silk).digest('hex');
    silkPath = join(dir, `${md5}.silk`).replace(/\\/g, '/');
    writeFileSync(silkPath, rendered.silk);
  } else {
    const stored = storeSilk(workspace, rendered.silk);
    silkPath = stored.path;
    md5 = stored.md5;
  }
  const result = await submitVoice({
    hookUrl: settings.hookUrl,
    token,
    toUser: target.username,
    silkPath,
    md5,
    durationMs: rendered.durationMs,
  });
  console.log('sent:', JSON.stringify({ chatKey, toUser: target.username, md5, silkPath, result }));
} else {
  console.log('(dry run; pass --send --chat <chatKey> to push it to WeChat)');
}
