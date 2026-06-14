from fastapi import APIRouter

from config import CATEGORIES

router = APIRouter()


# ---------- Meta ----------
@router.get("/meta/categories")
async def get_categories():
    return CATEGORIES
