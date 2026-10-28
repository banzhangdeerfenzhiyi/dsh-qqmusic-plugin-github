#!/usr/bin/env node
/**
 * Print the voice pack catalogue, grouped by gender/locale, plus whether the
 * optional RVC layer is available on this machine.
 *
 *   node tools/list-voices.mjs
 *   node tools/list-voices.mjs --gender male
 */
import { formatVoiceList, RVC_PRESETS } from '../src/voices.mjs';
import { detectRvcRoot, detectPython } from '../index.mjs';

const argv = process.argv.slice(2);
const value = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : undefined;
};

const gender = value('--gender') ?? 'all';
console.log(formatVoiceList({ gender }));
console.log('');
console.log('RVC 音色预设（需要本机 RVC 环境）：');
for (const preset of RVC_PRESETS) {
  console.log(`- ${preset.display}（${preset.name}，pitch ${preset.pitch}）`);
}
const rvcRoot = detectRvcRoot('');
if (rvcRoot === '') {
  console.log('\nRVC 根目录：未检测到（只使用 Edge 音色；可用 RVC_ROOT 或配置 rvcRoot 指定）。');
} else {
  console.log(`\nRVC 根目录：${rvcRoot}`);
  console.log(`RVC Python：${detectPython(rvcRoot)}`);
}
