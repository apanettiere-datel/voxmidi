"""Job status polling endpoint."""

from fastapi import APIRouter, HTTPException
from .jobs import get_job

router = APIRouter()


@router.get("/status/{job_id}")
async def get_status(job_id: str):
    """Poll async job status. Returns <1s — safe behind Cloudflare free tier."""
    job = get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return job
