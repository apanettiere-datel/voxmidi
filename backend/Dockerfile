FROM nvidia/cuda:12.4.0-runtime-ubuntu24.04

RUN apt-get update && apt-get install -y \
    python3.11 python3.11-venv python3-pip \
    ffmpeg fluidsynth libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --break-system-packages -r requirements.txt

COPY app/ /app/

EXPOSE 8080
# Single worker: the job store (routers/jobs.py) is in-process memory, so a second
# worker 404s status polls for jobs it never saw. Concurrency comes from job threads.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
