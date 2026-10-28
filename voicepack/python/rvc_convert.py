"""Convert a short audio clip into a target RVC voice (Applio backend).

Runs inside the RVC virtualenv; all machine-specific paths come from the
environment so the plugin works on any install.

Usage:
  python rvc_convert.py <input.wav> <output.wav> [pitch] [index_rate] [timbre]
                        [qfrency] [volume_envelope] [protect]

Environment (set by the plugin):
  RVC_ROOT      root of the RVC install
  APPLIO_DIR    directory containing Applio core.py (default <RVC_ROOT>/applio)
  VENV_PY       python of the RVC virtualenv (default <RVC_ROOT>/venv312/Scripts/python.exe)
  RVC_MODEL     path to the .pth voice model (required)
  RVC_INDEX     path to the .index feature index (required)
"""
import os
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

RVC_ROOT = os.environ.get('RVC_ROOT') or ''
if not RVC_ROOT:
    print('missing RVC_ROOT environment variable')
    raise SystemExit(2)
APPLIO_DIR = os.environ.get('APPLIO_DIR') or os.path.join(RVC_ROOT, 'applio')
VENV_PY = os.environ.get('VENV_PY') or os.path.join(RVC_ROOT, 'venv312', 'Scripts', 'python.exe')
MODEL_PTH = os.environ.get('RVC_MODEL') or ''
MODEL_INDEX = os.environ.get('RVC_INDEX') or ''


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    if not MODEL_PTH or not MODEL_INDEX:
        print('missing RVC_MODEL / RVC_INDEX')
        return 2
    input_path = os.path.abspath(sys.argv[1])
    output_path = os.path.abspath(sys.argv[2])
    pitch = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    index_rate = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    timbre = float(sys.argv[5]) if len(sys.argv) > 5 else 1.0
    qfrency = float(sys.argv[6]) if len(sys.argv) > 6 else 15.0
    volume_envelope = float(sys.argv[7]) if len(sys.argv) > 7 else 1.0
    protect = float(sys.argv[8]) if len(sys.argv) > 8 else 0.33
    for path in (input_path, MODEL_PTH, MODEL_INDEX):
        if not os.path.exists(path):
            print('missing file:', path)
            return 2
    python = VENV_PY if os.path.exists(VENV_PY) else sys.executable
    command = [
        python,
        'core.py',
        'infer',
        '--input-path', input_path,
        '--output-path', output_path,
        '--pth-path', MODEL_PTH,
        '--index-path', MODEL_INDEX,
        '--pitch', str(pitch),
        '--index-rate', str(index_rate),
        '--volume-envelope', str(volume_envelope),
        '--protect', str(protect),
        '--f0-method', 'rmvpe',
        '--export-format', 'WAV',
        '--embedder-model', 'contentvec',
    ]
    formant_shifting = abs(timbre - 1.0) > 1e-6
    if formant_shifting:
        command += ['--formant-shifting', '--formant-qfrency', str(qfrency), '--formant-timbre', str(timbre)]
    env = dict(os.environ)
    env['HF_ENDPOINT'] = 'https://hf-mirror.com'
    result = subprocess.run(command, cwd=APPLIO_DIR, env=env, capture_output=True, text=True,
                            encoding='utf-8', errors='replace', timeout=900)
    output = (result.stdout or '') + '\n' + (result.stderr or '')
    print(output[-1500:])
    if result.returncode != 0 or not os.path.exists(output_path):
        print('RVC conversion failed, exit', result.returncode)
        return 1
    print('RVC ok:', output_path, os.path.getsize(output_path), 'bytes')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
