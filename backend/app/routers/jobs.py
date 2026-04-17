"""Shared in-memory job state with concurrency queue."""

import threading
from collections import deque
from typing import Callable, Any

MAX_CONCURRENT = 3

_jobs: dict = {}
_lock = threading.Lock()
_running = 0
_queue: deque = deque()  # (job_id, fn, args)


def set_job(job_id: str, data: dict) -> None:
    with _lock:
        _jobs[job_id] = dict(data)


def update_job(job_id: str, data: dict) -> None:
    with _lock:
        if job_id in _jobs:
            _jobs[job_id].update(data)
        else:
            _jobs[job_id] = dict(data)


def get_job(job_id: str) -> dict | None:
    with _lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


def queue_position(job_id: str) -> int:
    """1-based queue position; 0 if not in queue."""
    with _lock:
        for i, (jid, _, _) in enumerate(_queue):
            if jid == job_id:
                return i + 1
        return 0


def try_start(job_id: str, fn: Callable, args: tuple) -> bool:
    """
    Attempt to run fn(*args) immediately in a daemon thread.
    If MAX_CONCURRENT is reached, enqueue instead.
    Returns True if started immediately, False if queued.
    """
    global _running
    with _lock:
        if _running < MAX_CONCURRENT:
            _running += 1
            started = True
        else:
            _queue.append((job_id, fn, args))
            started = False

    if started:
        t = threading.Thread(target=_wrap(job_id, fn), args=args, daemon=True)
        t.start()
    return started


def _wrap(job_id: str, fn: Callable) -> Callable:
    """Wrap fn so that when it finishes, the next queued job is started."""
    def wrapper(*args):
        try:
            fn(*args)
        finally:
            _on_job_done()
    return wrapper


def _on_job_done() -> None:
    global _running
    next_job = None
    with _lock:
        _running -= 1
        if _queue:
            next_job = _queue.popleft()
            _running += 1

    if next_job:
        job_id, fn, args = next_job
        update_job(job_id, {"status": "processing", "progress": 0, "queue_position": None})
        t = threading.Thread(target=_wrap(job_id, fn), args=args, daemon=True)
        t.start()
