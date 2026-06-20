"""Receipt (bill image) storage backed by MongoDB GridFS.

Step 22 moves receipt images off the inline ``expense.receipt_base64`` blob and into a dedicated
GridFS bucket (``receipts``). Each stored file uses a ``gen_id()`` UUID string as its ``_id``
(honoring the project's "UUID strings, not ObjectIds" rule) and carries ``metadata`` linking it back
to its trip/expense. Legacy ``receipt_base64`` data URIs are still readable via ``decode_data_uri``.
"""

import base64
import io
from typing import Optional, Tuple

from fastapi import HTTPException
from gridfs.errors import NoFile
from motor.motor_asyncio import AsyncIOMotorGridFSBucket

from database import db
from utils.common import gen_id, now_utc

MAX_RECEIPT_BYTES = 5 * 1024 * 1024  # 5 MB
ALLOWED_TYPES = {"image/jpeg", "image/png", "image/webp"}
_EXT_BY_TYPE = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

_bucket_instance: Optional[AsyncIOMotorGridFSBucket] = None


def _bucket() -> AsyncIOMotorGridFSBucket:
    # Lazily created so importing this module never touches the event loop / DB.
    global _bucket_instance
    if _bucket_instance is None:
        _bucket_instance = AsyncIOMotorGridFSBucket(db, bucket_name="receipts")
    return _bucket_instance


def _normalize_type(content_type: Optional[str]) -> str:
    # "image/jpeg; charset=..." -> "image/jpeg"
    return (content_type or "").split(";")[0].strip().lower()


def validate_receipt_upload(content_type: Optional[str], size: int) -> None:
    """Pure guard (no DB): reject non-image types and oversized payloads with 400."""
    ct = _normalize_type(content_type)
    if ct not in ALLOWED_TYPES:
        raise HTTPException(400, f"Unsupported receipt type '{content_type or 'unknown'}'. Allowed: JPEG, PNG, WebP.")
    if size <= 0:
        raise HTTPException(400, "Empty receipt file.")
    if size > MAX_RECEIPT_BYTES:
        raise HTTPException(400, f"Receipt too large ({size} bytes). Maximum is {MAX_RECEIPT_BYTES} bytes (5 MB).")


async def store_receipt(*, expense_id: str, trip_id: str, user_id: str,
                        filename: Optional[str], content_type: str, data: bytes) -> str:
    """Write ``data`` into the receipts bucket and return the new UUID receipt id."""
    receipt_id = gen_id()
    ct = _normalize_type(content_type)
    name = filename or f"receipt-{receipt_id}.{_EXT_BY_TYPE.get(ct, 'jpg')}"
    await _bucket().upload_from_stream_with_id(
        receipt_id,
        name,
        io.BytesIO(data),
        metadata={
            "trip_id": trip_id,
            "expense_id": expense_id,
            "content_type": ct,
            "uploaded_by": user_id,
            "uploaded_at": now_utc().isoformat(),
        },
    )
    return receipt_id


async def read_receipt(receipt_id: str) -> Optional[Tuple[bytes, str]]:
    """Return ``(bytes, content_type)`` for a stored receipt, or ``None`` if it is missing."""
    try:
        grid_out = await _bucket().open_download_stream(receipt_id)
    except NoFile:
        return None
    data = await grid_out.read()
    meta = grid_out.metadata or {}
    return data, (meta.get("content_type") or "application/octet-stream")


async def delete_receipt(receipt_id: str) -> None:
    """Best-effort delete of a single GridFS receipt (ignores a missing file)."""
    try:
        await _bucket().delete(receipt_id)
    except NoFile:
        pass


async def delete_receipts_for_expense(expense_id: str) -> None:
    """Delete every GridFS receipt linked to an expense (replace/cleanup, no orphans)."""
    cursor = db["receipts.files"].find({"metadata.expense_id": expense_id}, {"_id": 1})
    async for f in cursor:
        await delete_receipt(f["_id"])


def decode_data_uri(uri: Optional[str]) -> Optional[Tuple[bytes, str]]:
    """Decode a legacy ``data:<mime>;base64,<payload>`` receipt into ``(bytes, content_type)``."""
    if not uri or not isinstance(uri, str) or not uri.startswith("data:"):
        return None
    try:
        header, b64 = uri.split(",", 1)
    except ValueError:
        return None
    content_type = header[len("data:"):].split(";")[0].strip() or "application/octet-stream"
    try:
        data = base64.b64decode(b64)
    except Exception:
        return None
    if not data:
        return None
    return data, content_type
