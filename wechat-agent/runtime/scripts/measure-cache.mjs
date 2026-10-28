#!/usr/bin/env node
/**
 * 从 DSH 会话日志统计每轮的提示词缓存命中率与模型调用开销。
 *
 * 只读 node 内置模块，不依赖 DSH 运行时。日志是「多帧 zstd + 每帧若干 JSONL」，
 * 且相邻帧可能重复事件，因此按 seq 去重后再重建 surface。
 *
 * 用法：
 *   node scripts/measure-cache.mjs                       # 所有 social 会话
 *   node scripts/measure-cache.mjs --since 2026-10-25T22:15:00
 *   node scripts/measure-cache.mjs --json
 *   node scripts/measure-cache.mjs --all                 # 含人类会话，作对照组
 *
 * 判读：
 *   fresh     — 本轮按全价计费的输入 token
 *   cacheRead — 命中前缀缓存的输入 token
 *   calls     — step/start 数量，即真实模型调用次数（request/header 会在 surface
 *               变动时重写一次，不能当作调用次数）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'system/message', 'developer/message']);

function parseArgs(argv) {
  const out = { json: false, since: null, limit: 40, all: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--all') out.all = true;
    else if (arg === '--since') out.since = Date.parse(argv[++i]);
    else if (arg === '--limit') out.limit = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

/** 依次解压文件中的每一个 zstd 帧（Node 的同步 API 只解第一帧）。 */
export function readFrames(file) {
  const bytes = fs.readFileSync(file);
  const offsets = [];
  for (let i = 0; i + 4 <= bytes.length; i++) {
    if (bytes[i] === 0x28 && bytes[i + 1] === 0xb5 && bytes[i + 2] === 0x2f && bytes[i + 3] === 0xfd) offsets.push(i);
  }
  const chunks = [];
  let failedFrames = 0;
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : bytes.length;
    try { chunks.push(zlib.zstdDecompressSync(bytes.subarray(offsets[k], end))); } catch { failedFrames++; }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames: offsets.length, failedFrames };
}

/** 解析成按 seq 排序、且 seq 唯一的事件数组（重叠帧保留最后一次）。 */
export function readEvents(file) {
  const { text, frames, failedFrames } = readFrames(file);
  const lines = text.split('\n').filter(Boolean);
  const bySeq = new Map();
  let unparsed = 0;
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { unparsed++; continue; }
    if (Number.isInteger(event.seq)) bySeq.set(event.seq, event);
  }
  const events = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { events, frames, failedFrames, lines: lines.length, unparsed };
}

/** 重建 surface：append 追加；replace 换掉原位置的内容但保持位置。 */
export function buildSurface(events) {
  const surface = [];
  for (const event of events) {
    if (!MESSAGE_TYPES.has(event.type)) continue;
    const op = event.surfaceOp;
    if (!op || op === 'append' || op?.op === 'append') { surface.push(event.seq); continue; }
    if (op?.op === 'replace') {
      const at = surface.indexOf(op.startSeq);
      if (at >= 0) surface[at] = event.seq;
      else surface.push(event.seq);
    }
  }
  return surface;
}

const textOf = (event) => (event?.data?.content ?? []).map((block) => block.text ?? `<${block.type}>`).join('');

export function measureSession(file, { since = null } = {}) {
  const { events, frames, failedFrames, unparsed } = readEvents(file);
  if (!events.length) return null;
  const surface = buildSurface(events);
  const title = events.find((e) => e.type === 'session/title')?.data?.title ?? path.basename(path.dirname(file));

  const rows = [];
  // 顺序扫描：turn/start 推进编号，user/message 记录本轮批次原文，assistant/message 结算。
  let current = null;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data?.turn, seq: event.seq, time: event.time, batchText: '', headers: 0, calls: 0 };
      continue;
    }
    if (!current) continue;
    if (event.type === 'request/header') { current.headers++; continue; }
    if (event.type === 'step/start') { current.calls++; continue; }
    if (event.type === 'user/message') {
      const text = textOf(event);
      if (text.trim()) current.batchText = text;
      continue;
    }
    if (event.type !== 'assistant/message') continue;
    const usage = event.data?.usage ?? {};
    if (since && current.time < since) { current.batchText = ''; current.headers = 0; current.calls = 0; continue; }
    const fresh = usage.inputTokens ?? 0;
    const cached = usage.cacheReadTokens ?? 0;
    const total = fresh + cached;
    rows.push({
      turn: current.turn,
      fresh,
      cached,
      output: usage.outputTokens ?? 0,
      hitRate: total ? +(cached / total * 100).toFixed(1) : 0,
      repair: /^本机发送格式校正：/.test(current.batchText.trim()),
      calls: current.calls,
      headers: current.headers,
      time: current.time,
    });
    current = { ...current, batchText: '', headers: 0, calls: 0 };
  }

  const normal = rows.filter((row) => !row.repair);
  const repairs = rows.filter((row) => row.repair);
  const sum = (list, key) => list.reduce((total, row) => total + row[key], 0);
  const fresh = sum(rows, 'fresh');
  const cached = sum(rows, 'cached');
  const normalFresh = sum(normal, 'fresh');
  const normalCached = sum(normal, 'cached');
  return {
    file,
    title,
    frames,
    failedFrames,
    unparsed,
    surfaceNodes: surface.length,
    turns: rows.length,
    calls: sum(rows, 'calls'),
    headers: sum(rows, 'headers'),
    repairTurns: repairs.length,
    freshInput: fresh,
    cacheRead: cached,
    outputTokens: sum(rows, 'output'),
    overallHitRate: fresh + cached ? +(cached / (fresh + cached) * 100).toFixed(1) : 0,
    normalHitRate: normalFresh + normalCached ? +(normalCached / (normalFresh + normalCached) * 100).toFixed(1) : 0,
    freshPerTurn: rows.length ? Math.round(fresh / rows.length) : 0,
    callsPerTurn: rows.length ? +(sum(rows, 'calls') / rows.length).toFixed(2) : 0,
    rows,
  };
}

export function findSessionFiles(home = path.join(os.homedir(), '.dsh'), { all = false } = {}) {
  const root = path.join(home, 'sessions');
  if (!fs.existsSync(root)) return [];
  const files = [];
  for (const project of fs.readdirSync(root)) {
    const projectDir = path.join(root, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const session of fs.readdirSync(projectDir)) {
      const dir = path.join(projectDir, session);
      if (!fs.statSync(dir).isDirectory()) continue;
      if (!all && !session.startsWith('social-')) continue;   // 默认只看桥接会话
      const file = path.join(dir, 'session.v4.jsonl.zstd');
      if (fs.existsSync(file) && !session.includes('format-repair')) files.push(file);
    }
  }
  return files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
}

function printReport(report) {
  console.log(`\n# ${report.title}`);
  console.log(`  ${report.file}`);
  console.log(`  帧 ${report.frames} / 失败帧 ${report.failedFrames} / 未解析行 ${report.unparsed} / surface ${report.surfaceNodes} 条`);
  console.log(`  轮次 ${report.turns} / 模型调用 ${report.calls}（${report.callsPerTurn}/轮）/ 请求头 ${report.headers} / 格式校正 ${report.repairTurns}`);
  console.log(`  整体命中 ${report.overallHitRate}% · 正常轮次命中 ${report.normalHitRate}% · 每轮 fresh ${report.freshPerTurn}`);
  console.log(`  fresh input ${report.freshInput.toLocaleString()} · cache read ${report.cacheRead.toLocaleString()} · output ${report.outputTokens.toLocaleString()}`);
  console.log('  turn | fresh | cacheRead | hit% | out | 类型');
  for (const row of report.rows) {
    console.log(`  ${String(row.turn).padStart(4)} | ${String(row.fresh).padStart(6)} | ${String(row.cached).padStart(9)} | ${String(row.hitRate).padStart(5)} | ${String(row.output).padStart(4)} | ${row.repair ? '格式校正' : '正常'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log('node scripts/measure-cache.mjs [--json] [--since ISO8601] [--all] [--limit N]'); process.exit(0); }
  const files = findSessionFiles(path.join(os.homedir(), '.dsh'), { all: args.all }).slice(0, args.limit);
  const reports = files.map((file) => measureSession(file, { since: args.since })).filter((report) => report && report.turns > 0);
  if (args.json) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), since: args.since ? new Date(args.since).toISOString() : null, reports }, null, 2));
  } else if (!reports.length) {
    console.log('没有找到含模型轮次的会话日志。');
  } else {
    for (const report of reports) printReport(report);
    const fresh = reports.reduce((total, report) => total + report.freshInput, 0);
    const cached = reports.reduce((total, report) => total + report.cacheRead, 0);
    const turns = reports.reduce((total, report) => total + report.turns, 0);
    const calls = reports.reduce((total, report) => total + report.calls, 0);
    const repairs = reports.reduce((total, report) => total + report.repairTurns, 0);
    console.log(`\n合计：${turns} 轮 · 模型调用 ${calls}（${(calls / Math.max(1, turns)).toFixed(2)}/轮）· 格式校正 ${repairs} · fresh ${fresh.toLocaleString()} · cache ${cached.toLocaleString()} · 整体命中 ${(cached / Math.max(1, fresh + cached) * 100).toFixed(1)}%`);
  }
}
