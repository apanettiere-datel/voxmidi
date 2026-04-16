"""Clerk JWT verification + user lookup/creation."""

import os
import time
import json
import base64
import urllib.request
from datetime import datetime, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session

from database import get_db, User

DEV_MODE = os.environ.get("DEV_MODE", "false").lower() == "true"
CLERK_SECRET_KEY = os.environ.get("CLERK_SECRET_KEY", "")

# JWKS cache
_jwks_cache: Optional[dict] = None
_jwks_fetched_at: float = 0
JWKS_TTL = 3600  # 1 hour


def _get_jwks() -> dict:
    global _jwks_cache, _jwks_fetched_at
    now = time.time()
    if _jwks_cache and (now - _jwks_fetched_at) < JWKS_TTL:
        return _jwks_cache

    url = "https://api.clerk.com/v1/jwks"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}"})
    with urllib.request.urlopen(req, timeout=10) as r:
        _jwks_cache = json.loads(r.read())
        _jwks_fetched_at = now
        return _jwks_cache


def _decode_jwt_unverified(token: str) -> dict:
    """Decode JWT payload without verification (for key selection)."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format")
    payload_b64 = parts[1] + "=="  # add padding
    payload_bytes = base64.urlsafe_b64decode(payload_b64)
    return json.loads(payload_bytes)


def _verify_jwt(token: str) -> dict:
    """Verify JWT using Clerk JWKS. Returns decoded claims."""
    import jwt  # pyjwt

    jwks = _get_jwks()

    # Decode header to find key ID
    header_b64 = token.split(".")[0] + "=="
    header = json.loads(base64.urlsafe_b64decode(header_b64))
    kid = header.get("kid")

    # Find matching key
    key_data = None
    for key in jwks.get("keys", []):
        if key.get("kid") == kid:
            key_data = key
            break

    if not key_data:
        raise HTTPException(status_code=401, detail="JWT key not found in JWKS")

    from jwt.algorithms import RSAAlgorithm
    public_key = RSAAlgorithm.from_jwk(json.dumps(key_data))

    try:
        claims = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            options={"verify_aud": False},  # Clerk doesn't use aud claim
        )
        return claims
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


def _upsert_user(db: Session, user_id: str, email: str, name: str) -> User:
    """Get or create user, reset monthly usage if needed."""
    user = db.query(User).filter(User.id == user_id).first()
    now = datetime.now(timezone.utc)
    current_month = now.month

    if not user:
        user = User(
            id=user_id,
            email=email,
            name=name,
            usage_count=0,
            usage_reset_month=current_month,
        )
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
        # Reset usage if month changed
        if user.usage_reset_month != current_month:
            user.usage_count = 0
            user.usage_reset_month = current_month
            db.commit()
            db.refresh(user)

    return user


async def get_current_user(
    authorization: Optional[str] = Header(None),
    db: Session = Depends(get_db),
) -> User:
    """FastAPI dependency: authenticate request and return User."""

    if DEV_MODE:
        # Dev mode: return or create a local dev user
        user = _upsert_user(db, "dev", "dev@local", "Dev")
        return user

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = authorization.removeprefix("Bearer ").strip()

    try:
        claims = _verify_jwt(token)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"Auth error: {e}")

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="No sub claim in token")

    # Extract email and name from Clerk token claims
    email = claims.get("email", "")
    name = (
        f"{claims.get('given_name', '')} {claims.get('family_name', '')}".strip()
        or claims.get("name", "")
        or email
    )

    user = _upsert_user(db, user_id, email, name)
    return user
