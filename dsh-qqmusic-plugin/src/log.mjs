/**
 * Append-only diagnostics for the QQ Music singing plugin.
 *
 * A failed sing has several silent stages (搜索 / 下载 / 分轨 / 音色转换 / 混音 /
 * SILK / 发送), so the log line per stage is the only thing that makes a bug
 * report actionable. Logging must never break a request.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string} [subdir]
 * @returns {(line: string) => void}
 */
export function createLogger(subdir = 'qqmusic') {
  let file;
  try {
    const dir = join(homedir(), '.dsh', subdir);
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'qqmusic.log');
  } catch {
    file = undefined;
  }
  return (line) => {
    const text = `${new Date().toISOString()} ${line}`;
    try {
      if (file !== undefined) appendFileSync(file, `${text}\n`);
    } catch {
      /* logging must never break a send */
    }
  };
}

/** @param {unknown} error */
export function messageOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
