import io
from typing import Optional

from fastapi import APIRouter, HTTPException, Depends, Header, UploadFile, File
from fastapi.responses import StreamingResponse

from database import db
from utils.deps import get_current_user, _trip_or_404, _expense_or_404, _expense_modify_or_403
from utils.security import decode_token
from services.receipts import (
    validate_receipt_upload,
    store_receipt,
    read_receipt,
    delete_receipts_for_expense,
    decode_data_uri,
)

router = APIRouter()

_CACHE_HEADERS = {"Cache-Control": "private, max-age=86400"}


# ---------- Receipts (bill images) ----------
async def _resolve_user_id(token: Optional[str], authorization: Optional[str]) -> str:
    """Resolve the requesting user from a Bearer header OR a ``?token=`` query param.

    Mirrors the ``report.xlsx`` pattern so a React Native ``<Image>`` (which can't easily set
    headers) and a plain browser link can both fetch a receipt.
    """
    raw = None
    if authorization and authorization.startswith("Bearer "):
        raw = authorization[7:]
    elif token:
        raw = token
    if not raw:
        raise HTTPException(401, "Not authenticated")
    payload = decode_token(raw)
    user = await db.users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user:
        raise HTTPException(401, "User not found")
    return user["id"]


@router.post("/trips/{trip_id}/expenses/{expense_id}/receipt")
async def upload_receipt(trip_id: str, expense_id: str, file: UploadFile = File(...),
                         user=Depends(get_current_user)):
    # RBAC (Step 10): only the expense creator or a trip admin may attach/replace.
    await _expense_modify_or_403(trip_id, expense_id, user["id"])
    data = await file.read()
    validate_receipt_upload(file.content_type, len(data))
    # Replace semantics: drop any previous GridFS receipt for this expense first.
    await delete_receipts_for_expense(expense_id)
    receipt_id = await store_receipt(
        expense_id=expense_id, trip_id=trip_id, user_id=user["id"],
        filename=file.filename, content_type=file.content_type, data=data,
    )
    # Point the expense at the new receipt and drop any legacy inline blob.
    await db.expenses.update_one(
        {"id": expense_id, "trip_id": trip_id},
        {"$set": {"receipt_id": receipt_id}, "$unset": {"receipt_base64": ""}},
    )
    return {"receipt_id": receipt_id}


@router.get("/trips/{trip_id}/expenses/{expense_id}/receipt")
async def get_receipt(trip_id: str, expense_id: str, token: Optional[str] = None,
                      authorization: Optional[str] = Header(None)):
    # Any trip member may view; auth accepted via header or ?token= query.
    user_id = await _resolve_user_id(token, authorization)
    await _trip_or_404(trip_id, user_id)
    expense = await _expense_or_404(trip_id, expense_id)

    receipt_id = expense.get("receipt_id")
    if receipt_id:
        result = await read_receipt(receipt_id)
        if result:
            data, content_type = result
            return StreamingResponse(io.BytesIO(data), media_type=content_type, headers=_CACHE_HEADERS)

    # Legacy fallback: stream a pre-Step-22 inline base64 receipt.
    legacy = decode_data_uri(expense.get("receipt_base64"))
    if legacy:
        data, content_type = legacy
        return StreamingResponse(io.BytesIO(data), media_type=content_type, headers=_CACHE_HEADERS)

    raise HTTPException(404, "No receipt for this expense")


@router.delete("/trips/{trip_id}/expenses/{expense_id}/receipt")
async def remove_receipt(trip_id: str, expense_id: str, user=Depends(get_current_user)):
    # RBAC (Step 10): only the expense creator or a trip admin may remove. Idempotent.
    await _expense_modify_or_403(trip_id, expense_id, user["id"])
    await delete_receipts_for_expense(expense_id)
    await db.expenses.update_one(
        {"id": expense_id, "trip_id": trip_id},
        {"$unset": {"receipt_id": "", "receipt_base64": ""}},
    )
    return {"ok": True}
