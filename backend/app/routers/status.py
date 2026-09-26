"""Job status polling endpoint."""

from fastapi import APIRouter, HTTPException, Depends

from database import User
from middleware.auth import get_current_user
from .jobs import get_job

router = APIRouter()


@router.get("/status/{job_id}")
async def get_status(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Poll async job status. Returns <1s, safe behind Cloudflare free tier.

    Only the user who started a job can see it; anyone else gets 404.
    """
    job = get_job(job_id)
    if job is None or job.get("_owner") != current_user.id:
        raise HTTPException(status_code=404, detail="Job not found")
    # Keys starting with "_" are internal bookkeeping (owner, pending refund)
    return {k: v for k, v in job.items() if not k.startswith("_")}
