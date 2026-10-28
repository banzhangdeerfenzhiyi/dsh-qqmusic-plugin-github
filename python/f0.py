"""Print the median F0 (Hz) of a vocal clip.

The plugin uses it to pick the RVC pitch shift: it brings the source vocal's
median pitch up/down to the target voice's comfortable range, which beats a
per-song hard-coded semitone value.

`pyin` is used instead of `yin` because it tracks the fundamental through
octave jumps; a plain yin median lands an octave high on dense mixes and the
automatic transpose would come out ~7 semitones too low.

Usage: f0.py <audio.wav> [result.txt]
When `result.txt` is given the number is also written there, so a caller that
cannot capture stdout still gets the value.
"""
import sys

import librosa
import numpy as np


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print("usage: f0.py <audio.wav> [result.txt]")
        return 2
    y, sample_rate = librosa.load(sys.argv[1], sr=22050, mono=True)
    median = 0.0
    try:
        f0, voiced_flag, voiced_prob = librosa.pyin(
            y,
            fmin=60,
            fmax=520,
            sr=sample_rate,
            frame_length=2048,
            fill_na=np.nan,
        )
        mask = np.isfinite(f0) & voiced_flag & (voiced_prob > 0.25)
        values = f0[mask]
        if values.size > 0:
            median = float(np.median(values))
    except Exception as error:  # pyin can fail on near-silence
        print(f"pyin failed: {error}", file=sys.stderr)
    if median <= 0:
        # Fallback: plain yin, still better than "keep the configured pitch".
        f0 = librosa.yin(y, fmin=60, fmax=520, sr=sample_rate)
        values = f0[np.isfinite(f0)]
        if values.size > 0:
            median = float(np.median(values))
    text = f"{median:.2f}"
    print(text)
    if len(sys.argv) > 2:
        with open(sys.argv[2], "w", encoding="utf-8") as handle:
            handle.write(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
