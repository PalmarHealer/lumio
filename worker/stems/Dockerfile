# Lumio stem worker (see worker.py). The model is NOT in the image: mount it at /models/htdemucs.onnx (converted from
# the official Demucs weights). CPU build; for NVIDIA GPUs build with --build-arg ORT=onnxruntime-gpu and run with
# --gpus all -e PROVIDER=cuda.
FROM python:3.12-slim-trixie
ARG ORT=onnxruntime==1.20.1
RUN pip install --no-cache-dir "$ORT" numpy==2.1.3 soundfile==0.12.1
WORKDIR /app
COPY worker.py .
USER nobody
CMD ["python", "-u", "worker.py"]
