/**
 * Offline unit tests for the voice pack (no TTS, no network, no GPU).
 *
 *   node test/unit.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRvcStage, detectPython, detectRvcRoot, resolveSettings } from '../index.mjs';
import { EDGE_VOICES, formatVoiceList, resolveRvcPreset, resolveSelection, resolveVoice } from '../src/voices.mjs';

let passed = 0;
/** @param {string} label @param {() => void} body */
function test(label, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${label}`);
  } catch (error) {
    console.error(`FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

test('catalogue has female and male voices and the classic defaults', () => {
  assert.ok(EDGE_VOICES.length >= 15, `expected >=15 voices, got ${EDGE_VOICES.length}`);
  const female = EDGE_VOICES.filter((voice) => voice.gender === 'female').length;
  const male = EDGE_VOICES.filter((voice) => voice.gender === 'male').length;
  assert.ok(female >= 9, `female=${female}`);
  assert.ok(male >= 6, `male=${male}`);
  assert.ok(EDGE_VOICES.some((voice) => voice.id === 'zh-CN-YunxiNeural'), '云希 missing');
  assert.ok(EDGE_VOICES.some((voice) => voice.id === 'zh-HK-WanLungNeural'), '粤语男声 missing');
});

test('resolveVoice accepts ids, names and aliases', () => {
  assert.equal(resolveVoice('zh-CN-YunxiNeural').id, 'zh-CN-YunxiNeural');
  assert.equal(resolveVoice('云希').id, 'zh-CN-YunxiNeural');
  assert.equal(resolveVoice('yunxi').id, 'zh-CN-YunxiNeural');
  assert.equal(resolveVoice('男声').gender, 'male');
  assert.equal(resolveVoice('晓伊').id, 'zh-CN-XiaoyiNeural');
  assert.equal(resolveVoice('东北话').id, 'zh-CN-liaoning-XiaobeiNeural');
  assert.equal(resolveVoice('不存在的音色'), undefined);
});

test('resolveSelection falls back to the default voice', () => {
  const selection = resolveSelection({});
  assert.equal(selection.voice.id, resolveSettings({}).defaultVoice);
  assert.equal(selection.rvc, undefined);
});

test('resolveRvcPreset knows the male DaFeiYu preset', () => {
  const preset = resolveRvcPreset('大肥鱼');
  assert.equal(preset.name, 'dafeiyu');
  assert.equal(preset.gender, 'male');
  assert.ok(preset.modelPath.includes('dafeiyu.pth'));
});

test('formatVoiceList filters by gender and tag', () => {
  const male = formatVoiceList({ gender: 'male' });
  assert.ok(male.includes('云希'));
  assert.ok(!male.includes('晓伊'));
  const dialect = formatVoiceList({ tag: '方言' });
  assert.ok(dialect.includes('东北话'));
});

test('detectRvcRoot and detectPython work from temp directories', () => {
  const root = mkdtempSync(join(tmpdir(), 'voicepack-rvc-'));
  const slashed = root.replace(/\\/g, '/');
  mkdirSync(join(root, 'applio'), { recursive: true });
  writeFileSync(join(root, 'applio', 'core.py'), '# fake\n');
  mkdirSync(join(root, 'venv312', 'Scripts'), { recursive: true });
  writeFileSync(join(root, 'venv312', 'Scripts', 'python.exe'), '');
  try {
    assert.equal(detectRvcRoot(root), slashed);
    assert.equal(detectPython(slashed), `${slashed}/venv312/Scripts/python.exe`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSettings merges config and clamps numbers', () => {
  const settings = resolveSettings({ maxCharsPerVoice: 5, maxVoicesPerCall: 99, defaultVoice: '云希' });
  assert.equal(settings.defaultVoice, 'zh-CN-YunxiNeural');
  assert.equal(settings.maxCharsPerVoice, 12);
  assert.equal(settings.maxVoicesPerCall, 5);
  assert.equal(settings.hookUrl, 'http://127.0.0.1:30001');
  assert.equal(settings.rvcEnabled, true);
});

test('buildRvcStage returns a usable stage only when the model files exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'voicepack-models-'));
  const slashed = root.replace(/\\/g, '/');
  mkdirSync(join(root, 'applio'), { recursive: true });
  writeFileSync(join(root, 'applio', 'core.py'), '# fake\n');
  mkdirSync(join(root, 'models', 'DaFeiYu'), { recursive: true });
  writeFileSync(join(root, 'models', 'DaFeiYu', 'dafeiyu.pth'), 'x');
  writeFileSync(join(root, 'models', 'DaFeiYu', 'added_IVF1314_Flat_nprobe_1_dafeiyu_v2.index'), 'x');
  const settings = resolveSettings({ rvcRoot: root });
  try {
    const stage = buildRvcStage(settings, '大肥鱼');
    assert.ok(stage.rvc, 'expected rvc stage');
    assert.equal(stage.preset, 'dafeiyu');
    assert.ok(stage.rvc.model.endsWith('dafeiyu.pth'));
    // A preset whose model files are missing degrades to Edge-only instead of throwing.
    const missing = buildRvcStage(settings, 'ying');
    assert.equal(missing.rvc, null);
    assert.equal(missing.preset, 'ying');
    // Disabled RVC means no stage at all.
    assert.equal(buildRvcStage(resolveSettings({ rvcRoot: root, rvcEnabled: false }), '大肥鱼').rvc, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed${process.exitCode ? ', see failures above' : ''}`);

