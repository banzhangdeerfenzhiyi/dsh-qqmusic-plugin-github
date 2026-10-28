"""Split one audio segment into vocals / accompaniment with Demucs.

Called by the plugin through the RVC virtualenv Python. Outputs sit next to the
input as ``<stem>.vocals.wav`` and ``<stem>.accompaniment.wav``; existing outputs
are reused so a repeated request only pays for the RVC stage.

Usage: separate.py <audio.wav> [model]
"""
import os
import sys

import numpy as np
import soundfile as sf
import torch
from demucs.apply import apply_model
from demucs.pretrained import get_model

MIN_BYTES = 40_000


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass
    if len(sys.argv) < 2:
        print("usage: separate.py <audio.wav> [model]")
        return 2
    input_path = os.path.abspath(sys.argv[1])
    model_name = sys.argv[2] if len(sys.argv) > 2 else "htdemucs"
    base = os.path.splitext(input_path)[0]
    vocals_path = base + ".vocals.wav"
    accomp_path = base + ".accompaniment.wav"
    if (
        os.path.exists(vocals_path)
        and os.path.exists(accomp_path)
        and os.path.getsize(vocals_path) > MIN_BYTES
        and os.path.getsize(accomp_path) > MIN_BYTES
    ):
        print("vocals:", vocals_path, os.path.getsize(vocals_path), "(cached)")
        print("accompaniment:", accomp_path, os.path.getsize(accomp_path), "(cached)")
        return 0

    model = get_model(model_name)
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model.to(device).eval()
    data, sample_rate = sf.read(input_path, always_2d=True)
    if sample_rate != model.samplerate:
        import scipy.signal

        ratio = model.samplerate / sample_rate
        data = scipy.signal.resample_poly(data, int(ratio * 1000), 1000, axis=0)
        sample_rate = model.samplerate
    wav = torch.tensor(data.T, dtype=torch.float32)
    ref = wav.mean(0, keepdim=True)
    wav = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(model, wav[None].to(device), device=device, shifts=1, split=True)[0].cpu()
    sources = sources * ref.std() + ref.mean()
    vocals = sources[model.sources.index("vocals")]
    accompaniment = sources.sum(0) - vocals
    sf.write(vocals_path, vocals.numpy().T, sample_rate)
    sf.write(accomp_path, accompaniment.numpy().T, sample_rate)
    print("device:", device)
    print("vocals:", vocals_path, os.path.getsize(vocals_path))
    print("accompaniment:", accomp_path, os.path.getsize(accomp_path))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
