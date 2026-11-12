"""
Lumio stem worker: separates songs (or windows of them) into vocals, drums, bass and other for the editor's smart
filters ("Mix-Modus"). Stateless: it long-polls the Lumio server for the next job, pulls the job's audio through the
server (which streams it from Jellyfin; no token or library copy here), separates it with an HTDemucs ONNX model
(onnxruntime, CPU or CUDA) and uploads the four stems as FLAC. Runs next to Lumio or on another machine; it needs only
outbound HTTP to the Lumio server.

Environment:
  LUMIO_URL            the server's API base, e.g. http://lumio:8097/api
  STEMS_WORKER_TOKEN   the shared secret (the same as the server's)
  MODEL_PATH           the HTDemucs ONNX graph (input `mix` [1, 2, segment], output `sources` [1, 4, 2, segment],
                       stems drums/bass/other/vocals); default /models/htdemucs.onnx
  PROVIDER             cpu (default) or cuda
  THREADS              CPU threads for onnxruntime (default: all)
  ROLE                 primary (default: takes every job) or fallback (e.g. on the Lumio server's own CPU: takes
                       windows only, and nothing while a primary worker is around)
  NICE                 raise the process's niceness by this much (e.g. 19 for a fallback on a busy server)
Limit a fallback's CPU with the container (docker --cpus / compose cpus); it runs one job at a time.
"""
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

import numpy as np
import onnxruntime as ort
import soundfile as sf

LUMIO_URL = os.environ.get('LUMIO_URL', 'http://localhost:8097/api').rstrip('/')
TOKEN = os.environ.get('STEMS_WORKER_TOKEN', '')
MODEL_PATH = os.environ.get('MODEL_PATH', '/models/htdemucs.onnx')
PROVIDER = os.environ.get('PROVIDER', 'cpu')
THREADS = int(os.environ.get('THREADS', '0'))
ROLE = 'fallback' if os.environ.get('ROLE') == 'fallback' else 'primary'
NICE = int(os.environ.get('NICE', '0'))
SOURCES = ['drums', 'bass', 'other', 'vocals']


def request(method, path, body=None, content_type=None, timeout=600):
    headers = {'Authorization': f'Bearer {TOKEN}'}
    if content_type:
        headers['Content-Type'] = content_type
    req = urllib.request.Request(f'{LUMIO_URL}{path}', data=body, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, response.read()


def gpu_present():
    """Whether the container got an NVIDIA GPU (the toolkit mounts nvidia-smi and the device nodes)."""
    try:
        return subprocess.run(['nvidia-smi', '-L'], capture_output=True, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def load_model():
    if PROVIDER == 'cuda' and not gpu_present():
        # onnxruntime-gpu crashes (rather than failing) when asked for CUDA without a GPU in the container.
        sys.exit('CUDA requested but no NVIDIA GPU in this container: run it with the GPU (compose device reservation, '
                 'docker --gpus all) and the NVIDIA Container Toolkit, or set PROVIDER=cpu')
    options = ort.SessionOptions()
    if THREADS:
        options.intra_op_num_threads = THREADS
    providers = ['CUDAExecutionProvider', 'CPUExecutionProvider'] if PROVIDER == 'cuda' else ['CPUExecutionProvider']
    session = ort.InferenceSession(MODEL_PATH, options, providers=providers)
    if PROVIDER == 'cuda' and 'CUDAExecutionProvider' not in session.get_providers():
        # Don't fall back to the CPU silently: a GPU worker that isn't one would hold every job far too long.
        sys.exit(f'CUDA requested but not available (providers: {session.get_providers()}); check the GPU, driver and NVIDIA Container Toolkit')
    shape = session.get_inputs()[0].shape
    segment = shape[2] if isinstance(shape[2], int) else 343980
    return session, segment


def separate(session, segment, audio):
    """audio: (frames, 2) float32 at 44.1 kHz -> {stem: (frames, 2)}; 25 % overlap, triangular cross-fade (as Demucs)."""
    x = audio.T.astype(np.float32)
    mean, std = float(x.mean()), float(x.std()) + 1e-8
    x = (x - mean) / std
    n = x.shape[1]
    step = int(segment * 0.75)
    weight = np.concatenate([np.arange(1, segment // 2 + 1), np.arange(segment - segment // 2, 0, -1)]).astype(np.float32)
    weight /= weight.max()
    out = np.zeros((len(SOURCES), 2, n), np.float32)
    total = np.zeros(n, np.float32)
    name = session.get_inputs()[0].name
    for start in range(0, n, step):
        chunk = x[:, start:start + segment]
        m = chunk.shape[1]
        if m < segment:
            chunk = np.pad(chunk, ((0, 0), (0, segment - m)))
        y = session.run(None, {name: chunk[None]})[0][0]
        out[:, :, start:start + m] += y[:, :, :m] * weight[:m]
        total[start:start + m] += weight[:m]
        if start + segment >= n:
            break
    out = out / np.maximum(total, 1e-8) * std + mean
    return {stem: out[i].T for i, stem in enumerate(SOURCES)}


def run_job(session, segment, job):
    started = time.time()
    _, wav = request('GET', f"/music/stems/jobs/{job['id']}/audio")
    audio, rate = sf.read(io.BytesIO(wav), dtype='float32', always_2d=True)
    if rate != 44100 or audio.shape[1] != 2:
        raise ValueError(f'expected stereo 44.1 kHz, got {audio.shape[1]} ch {rate} Hz')
    stems = separate(session, segment, audio)
    for stem, data in stems.items():
        buffer = io.BytesIO()
        sf.write(buffer, np.clip(data, -1, 1), rate, format='FLAC', subtype='PCM_24')
        request('PUT', f"/music/stems/jobs/{job['id']}/{stem}?role={ROLE}", buffer.getvalue(), 'audio/flac')
    seconds = len(audio) / rate
    print(f"job {job['id']} {job['item']} {job['window']['id']}: {seconds:.0f} s of audio in {time.time() - started:.1f} s", flush=True)


def main():
    if not TOKEN:
        sys.exit('STEMS_WORKER_TOKEN is not set')
    if NICE:
        os.nice(NICE)
    session, segment = load_model()
    print(f'stem worker ({ROLE}): {MODEL_PATH} ({PROVIDER}, segment {segment}), polling {LUMIO_URL}', flush=True)
    while True:
        try:
            status, body = request('GET', f'/music/stems/jobs/next?wait=25&role={ROLE}', timeout=60)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as error:
            print(f'poll failed: {error}', flush=True)
            time.sleep(10)
            continue
        if status == 204 or not body:
            continue
        job = json.loads(body)
        try:
            run_job(session, segment, job)
        except Exception as error:  # report and carry on with the next job
            print(f"job {job['id']} failed: {error}", flush=True)
            try:
                request('POST', f"/music/stems/jobs/{job['id']}/fail", json.dumps({'error': str(error)[:400]}).encode(), 'application/json')
            except Exception:
                pass


if __name__ == '__main__':
    main()
