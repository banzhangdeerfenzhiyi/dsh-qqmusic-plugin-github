"""Replace only the bot's past "no microphone / cannot send voice" claims in
WeChatAgent social session histories, keeping every other memory untouched.

Run while DSH is stopped: the session files are rewritten, then the app starts
again. Original files are backed up next to the rewritten ones.
"""
import io
import json
import re
import sys
from datetime import datetime
from pathlib import Path

import zstandard

SESSIONS_ROOT = Path(__import__('os').environ.get('DSH_SCRUB_SESSIONS_ROOT', r'C:\Users\Administrator\.dsh\sessions'))
LOG = Path(r'C:\Users\Administrator\Documents\data\workspace\state\scrub-voice-memory.log')
REFUSAL = re.compile(r'麦克风|发不出|没有那个工具|没有语音|开不了口|没有工具|不能发语音|语音功能|没发语音')
REPLACEMENT = '（旧消息已作废：本聊天现在已经可以正常发语音条，之前的说法不算数。）'


def log(line: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().astimezone().strftime('%Y-%m-%dT%H:%M:%S%z')
    with LOG.open('a', encoding='utf-8') as handle:
        handle.write(f'{stamp} {line}\n')


def scrub_file(path: Path) -> tuple[int, int]:
    raw = path.read_bytes()
    text = zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw)).read().decode('utf-8', 'replace')
    lines = text.split('\n')
    changed = 0
    total = 0
    output = []
    for line in lines:
        stripped = line.strip()
        if not stripped:
            output.append(line)
            continue
        total += 1
        try:
            event = json.loads(stripped)
        except json.JSONDecodeError:
            output.append(line)
            continue
        if event.get('type') != 'assistant/message':
            output.append(line)
            continue
        message = (event.get('data') or {}).get('message') or {}
        blocks = message.get('content') or []
        touched = False
        for block in blocks:
            if not isinstance(block, dict) or block.get('type') != 'text':
                continue
            value = block.get('text')
            if not isinstance(value, str):
                continue
            if REFUSAL.search(value):
                block['text'] = REPLACEMENT
                touched = True
        if touched:
            changed += 1
            output.append(json.dumps(event, ensure_ascii=False))
        else:
            output.append(line)
    if changed == 0:
        return 0, total
    path.with_suffix(path.suffix + f'.bak-scrub-{datetime.now().strftime("%Y%m%d%H%M%S")}').write_bytes(raw)
    rewritten = '\n'.join(output).encode('utf-8')
    path.write_bytes(zstandard.ZstdCompressor().compress(rewritten))
    return changed, total


def main() -> int:
    scrubbed = 0
    scanned = 0
    for session_file in SESSIONS_ROOT.rglob('session.v4.jsonl.zstd'):
        if not session_file.parent.name.startswith('social-'):
            continue
        scanned += 1
        try:
            changed, total = scrub_file(session_file)
        except Exception as error:  # noqa: BLE001 - keep going for other sessions
            log(f'failed {session_file}: {error}')
            continue
        if changed:
            scrubbed += 1
            log(f'scrubbed {session_file.parent.name}: {changed} of {total} events')
    log(f'done: scanned={scanned} scrubbed_sessions={scrubbed}')
    print(f'scanned={scanned} scrubbed_sessions={scrubbed}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
