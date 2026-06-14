from datetime import datetime, timezone, timedelta

import bcrypt
import jwt
from fastapi import HTTPException

from config import JWT_SECRET, JWT_ALGORITHM


def hash_secret(v: str) -> str:
    return bcrypt.hashpw(v.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_secret(v: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(v.encode("utf-8"), hashed.encode("utf-8"))
    except Exception:
        return False


def create_token(user_id: str, email: str) -> str:
    payload = {
        "sub": user_id, "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=30),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
