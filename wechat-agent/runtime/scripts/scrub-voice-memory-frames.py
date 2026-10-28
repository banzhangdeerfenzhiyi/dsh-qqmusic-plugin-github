"""Frame-preserving version of the "remove the no-microphone excuses" scrub.

The previous attempt rewrote each session file as ONE zstd frame; DSH's session
loader then failed to restore that chat (bridge saw `agent_unavailable`). This
version keeps the exact frame layout: every original zstd frame is decompressed,
its JSONL lines are edited in place, and the frame is recompressed separately, so
the frame count and boundaries stay identical.

Run only while DSH is stopped.
"""
import io
import json
import os
import re
from datetime import datetime
from pathlib import Path

import zstandard

SESSIONS_ROOT = Path(os.environ.get('DSH_SCRUB_SESSIONS_ROOT', r'C:\Users\Administrator\.dsh\sessions'))
LOG = Path(r'C:\Users\Administrator\Documents\data\workspace\state\scrub-voice-memory.log')
REFUSAL = re.compile(r'麦克风|发不出|没有那个工具|没有语音|开不了口|没有工具|不能发语音|没发语音')
REPLACEMENT = '（旧消息已作废：本聊天现在已经可以正常发语音条，之前的说法不算数。）'
MAGIC = b'\x28\xb5\x2f\xfd'


def log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(f'{stamp} {line}\n')


def split_frames(raw: bytes) -> list[bytes]:
    positions = [index for index in range(len(raw) - 3) if raw[index:index + 4] == MAGIC]
    if not positions or positions[0] != 0:
        return [raw]
    frames = []
    for index, start in enumerate(positions):
        end = positions[index + 1] if index + 1 < len(positions) else len(raw)
        frames.append(raw[start:end])
    return frames


def scrub_frame(frame: bytes) -> tuple[bytes, int]:
    try:
        text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(frame)).read().decode('utf-8', 'replace')
    except zstandard.ZstdError:
        return frame, 0
    changed = 0
    output = []
    for line in text.split('\n'):
        stripped = line.strip()
        if not stripped:
            output.append(line)
            continue
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            output.append(line)
            continue
        touched = False
        if event.get('type') == 'assistant/message':
            blocks = (event.get('data') or {}).get('message', {}).get('content') or []
            for block in blocks:
                if isinstance(block, dict) and block.get('type') == 'text' and isinstance(block.get('text'), str):
                    if REFUSAL.search(block['text']):
                        block['text'] = REPLACEMENT
                        touched = True
        if touched:
            changed += 1
            output.append(json.dumps(event, ensure_ascii=False))
        else:
            output.append(line)
    if changed == 0:
        return frame, 0
    rewritten = '\n'.join(output).encode('utf-8')
    return zstandard.ZstdCompressor(level=3).compress(rewritten), changed


def scrub_file(path: Path) -> tuple[int, int]:
    raw = path.read_bytes()
    frames = split_frames(raw)
    total_changed = 0
    rebuilt = []
    for frame in frames:
        new_frame, changed = scrub_frame(frame)
        rebuilt.append(new_frame)
        total_changed += changed
    if total_changed == 0:
        return 0, len(frames)
    backup = path.with_suffix(path.suffix + f'.bak-scrub-{datetime.now().strftime("%Y%m%d%H%M%S")}')
    backup.write_bytes(raw)
    path.write_bytes(b''.join(rebuilt))
    return total_changed, len(frames)


def main() -> int:
    scrubbed = 0
    scanned = 0
    for session_file in SESSIONS_ROOT.rglob('session.v4.jsonl.zstd'):
        if not session_file.parent.name.startswith('social-'):
            continue
        scanned += 1
        try:
            changed, frames = scrub_file(session_file)
        except Exception as error:  # noqa: BLE001
            log(f'failed {session_file}: {error}')
            continue
        if changed:
            scrubbed += 1
            log(f'scrubbed {session_file.parent.name}: {changed} messages over {frames} frames')
    log(f'done: scanned={scanned} scrubbed_sessions={scrubbed}')
    print(f'scanned={scanned} scrubbed_sessions={scrubbed}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
