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

# JWKS cache keyed by issuer URL so we handle multiple issuers
_jwks_cache: dict = {}
_jwks_fetched_at: dict = {}
JWKS_TTL = 3600  # 1 hour


def _decode_b64(s: str) -> bytes:
    """Decode base64url with padding."""
    s += "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s)


def _decode_jwt_unverified(token: str) -> tuple[dict, dict]:
    """Decode JWT header and payload without verification."""
    parts = token.split(".")
    if len(parts) != 3:
        raise ValueError("Invalid JWT format")
    header = json.loads(_decode_b64(parts[0]))
    payload = json.loads(_decode_b64(parts[1]))
    return header, payload


def _get_jwks(issuer: str) -> dict:
    """Fetch JWKS from issuer's well-known endpoint (public, no auth required)."""
    now = time.time()
    if issuer in _jwks_cache and (now - _jwks_fetched_at.get(issuer, 0)) < JWKS_TTL:
        return _jwks_cache[issuer]

    # Use the issuer's public JWKS endpoint — no secret key required
    url = f"{issuer}/.well-known/jwks.json"
    print(f"[auth] Fetching JWKS from {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "VoxMIDI/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
            _jwks_cache[issuer] = data
            _jwks_fetched_at[issuer] = now
            print(f"[auth] JWKS fetched OK — {len(data.get('keys', []))} keys")
            return data
    except Exception as e:
        print(f"[auth] JWKS fetch failed from {url}: {e}")
        # Fallback to Clerk API endpoint if secret key is available
        if CLERK_SECRET_KEY:
            fallback = "https://api.clerk.com/v1/jwks"
            print(f"[auth] Falling back to {fallback}")
            req2 = urllib.request.Request(
                fallback,
                headers={"Authorization": f"Bearer {CLERK_SECRET_KEY}", "User-Agent": "VoxMIDI/1.0"},
            )
            with urllib.request.urlopen(req2, timeout=10) as r2:
                data2 = json.loads(r2.read())
                _jwks_cache[issuer] = data2
                _jwks_fetched_at[issuer] = now
                return data2
        raise RuntimeError(f"Cannot fetch JWKS: {e}")


def _verify_jwt(token: str) -> dict:
    """Verify JWT using Clerk JWKS. Returns decoded claims."""
    import jwt  # pyjwt

    header, payload = _decode_jwt_unverified(token)
    kid = header.get("kid")
    issuer = payload.get("iss", "")

    print(f"[auth] Verifying JWT — kid={kid} iss={issuer} sub={payload.get('sub', '?')[:12]}...")

    if not issuer:
        raise HTTPException(status_code=401, detail="JWT missing issuer (iss) claim")

    try:
        jwks = _get_jwks(issuer)
    except Exception as e:
        raise HTTPException(status_code=401, detail=f"JWKS fetch failed: {e}")

    # Find matching key by kid
    key_data = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
    if not key_data:
        # kid mismatch — invalidate cache and retry once
        _jwks_cache.pop(issuer, None)
        try:
            jwks = _get_jwks(issuer)
            key_data = next((k for k in jwks.get("keys", []) if k.get("kid") == kid), None)
        except Exception:
            pass

    if not key_data:
        print(f"[auth] kid={kid} not found in JWKS keys: {[k.get('kid') for k in jwks.get('keys', [])]}")
        raise HTTPException(status_code=401, detail=f"JWT key '{kid}' not found in JWKS")

    from jwt.algorithms import RSAAlgorithm
    public_key = RSAAlgorithm.from_jwk(json.dumps(key_data))

    try:
        claims = jwt.decode(
            token,
            public_key,
            algorithms=["RS256"],
            options={"verify_aud": False},  # Clerk doesn't use aud claim
        )
        print(f"[auth] JWT verified OK — sub={claims.get('sub', '?')[:12]}...")
        return claims
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired — please sign in again")
    except jwt.InvalidTokenError as e:
        print(f"[auth] JWT invalid: {e}")
        raise HTTPException(status_code=401, detail=f"Invalid token: {e}")


def _upsert_user(db: Session, user_id: str, email: str, name: str) -> User:
    """Get or create user, reset monthly usage if needed."""
    user = db.query(User).filter(User.id == user_id).first()
    now = datetime.now(timezone.utc)
    current_month = now.month

    if not user:
        user = User(id=user_id, email=email, name=name, usage_count=0, usage_reset_month=current_month)
        db.add(user)
        db.commit()
        db.refresh(user)
    else:
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
        user = _upsert_user(db, "dev", "dev@local", "Dev")
        return user

    if not authorization or not authorization.startswith("Bearer "):
        print(f"[auth] Missing/malformed Authorization header: {repr(authorization)[:60]}")
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    print(f"[auth] Received token (first 40 chars): {token[:40]}...")

    try:
        claims = _verify_jwt(token)
    except HTTPException:
        raise
    except Exception as e:
        print(f"[auth] Unexpected auth error: {e}")
        raise HTTPException(status_code=401, detail=f"Auth error: {e}")

    user_id = claims.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="No sub claim in token")

    email = claims.get("email", "")
    name = (
        f"{claims.get('given_name', '')} {claims.get('family_name', '')}".strip()
        or claims.get("name", "")
        or email
    )

    user = _upsert_user(db, user_id, email, name)
    return user
