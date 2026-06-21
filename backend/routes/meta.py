from fastapi import APIRouter

from config import CATEGORIES

router = APIRouter()


# ---------- Meta ----------
@router.get("/meta/categories")
async def get_categories():
    return CATEGORIES


@router.get("/health")
async def health():
    # Liveness probe for the hosting platform's health check (Render healthCheckPath=/api/health).
    # Deliberately does NOT touch the DB so a transient Mongo hiccup can't trigger a restart loop.
    return {"status": "ok"}
