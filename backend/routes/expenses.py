from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, BackgroundTasks, HTTPException, Depends

from config import CATEGORIES, MULTI_CURRENCY_EXPENSES_ENABLED
from database import db
from models.expense import ExpenseIn, ExpenseUpdate
from models.exchange_rate import ConversionRequest, ReconvertIn
from utils.common import gen_id, now_utc
from utils.deps import get_current_user, _trip_or_404, _expense_modify_or_403
from services.receipts import delete_receipts_for_expense
from services.expense_shares import expense_share_breakdown
from services.push_notifications import enqueue_financial_event
from services.exchange_rates import ExchangeRateError, decimal_value, error_detail, money
from services.expense_conversion import (
    convert_create_body,
    convert_expense,
    locked_exact_reallocation_update,
    serialize_bson,
    stored_original_amount,
    stored_original_currency,
    stored_original_custom_amounts,
)

router = APIRouter()


def _conversion_http_error(exc: Exception):
    if isinstance(exc, ExchangeRateError):
        raise HTTPException(exc.status_code, error_detail(exc))
    raise HTTPException(422, {
        "code": "invalid_conversion", "message": str(exc), "retryable": False,
    })


def _foreign_disabled():
    raise HTTPException(409, {
        "code": "multi_currency_disabled",
        "message": "Exchange rate support is required to use a currency other than the trip's official currency",
        "retryable": False,
    })


def _confirmation_required(message: str):
    raise HTTPException(428, {
        "code": "conversion_confirmation_required",
        "message": message,
        "retryable": False,
    })


def _conversion_conflict():
    raise HTTPException(409, {
        "code": "conversion_conflict",
        "message": "This expense's conversion changed on another device. Reload it and try again.",
        "retryable": False,
    })


def _same_money(left, right) -> bool:
    try:
        return money(left) == money(right)
    except (TypeError, ValueError):
        return False


def _same_amount_map(left, right) -> bool:
    left = left or {}
    right = right or {}
    if set(left) != set(right):
        return False
    try:
        return all(
            decimal_value(left[key]).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            == decimal_value(right[key]).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            for key in left
        )
    except Exception:
        return False


def _conversion_write_filter(trip_id: str, expense_id: str, expense: dict,
                             current_version: int) -> dict:
    query = {"id": expense_id, "trip_id": trip_id}
    if "conversion_version" in expense:
        query["conversion_version"] = current_version
    else:
        query["$or"] = [
            {"conversion_version": {"$exists": False}},
            {"conversion_version": 0},
        ]
    return query


async def _trip_spend(trip_id: str, *, excluding_expense_id: str | None = None) -> float:
    match = {"trip_id": trip_id}
    if excluding_expense_id:
        match["id"] = {"$ne": excluding_expense_id}
    rows = await db.expenses.aggregate([
        {"$match": match},
        {"$group": {"_id": None, "sum": {"$sum": "$amount"}}},
    ]).to_list(1)
    return float(rows[0]["sum"]) if rows else 0.0


def _budget_warning(trip: dict, current: float, candidate: float) -> str | None:
    budget = trip.get("budget")
    if budget is None or current + candidate <= budget:
        return None
    over = (current + candidate) - budget
    return f"This expense puts you {over:.2f} {trip.get('currency', 'INR')} over the trip budget."


def _clean_family_participants(raw, split_mode, split_ids, members):
    """Normalize the incoming family_participants map to genuine intra-family restrictions.

    Keeps an entry only when: a known split mode (PER_CAPITA or PER_FAMILY), the family is in the
    split, and the recorded participant ids are a proper, non-empty subset of that family's current
    roster ids. Anything else (all members, unknown families/ids) collapses to None => all participate
    (back-compat). In both modes only the family's INTERNAL per-member display split is affected; the
    family's entity total and every other entity are untouched.
    """
    if not raw or split_mode not in ("PER_CAPITA", "PER_FAMILY"):
        return None
    member_by_id = {m["id"]: m for m in members}
    split_set = set(split_ids)
    clean = {}
    for fam_id, pids in raw.items():
        if fam_id not in split_set:
            continue
        fam = member_by_id.get(fam_id)
        if not fam or fam.get("kind") != "family":
            continue
        roster = [str(x) for x in (fam.get("family_member_ids") or [])]
        roster_set = set(roster)
        kept = [p for p in (pids or []) if p in roster_set]
        if kept and len(kept) < len(roster):  # only a real (proper, non-empty) restriction
            clean[fam_id] = kept
    return clean or None


# ---------- Expenses ----------
@router.post("/trips/{trip_id}/expenses")
async def add_expense(trip_id: str, body: ExpenseIn, background_tasks: BackgroundTasks,
                      force: bool = False,
                      user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    trip_currency = trip.get("currency", "INR")
    source_currency = body.original_currency or body.currency or trip_currency
    if source_currency != trip_currency and not MULTI_CURRENCY_EXPENSES_ENABLED:
        _foreign_disabled()
    if body.category not in CATEGORIES:
        raise HTTPException(400, "Invalid category")
    member_ids = {m["id"] for m in trip["members"]}
    if body.paid_by_member_id not in member_ids:
        raise HTTPException(400, "paid_by_member_id invalid")
    split_ids = body.split_member_ids or [m["id"] for m in trip["members"]]
    for sid in split_ids:
        if sid not in member_ids:
            raise HTTPException(400, f"split member {sid} invalid")

    # Intra-family participation (PER_CAPITA and PER_FAMILY): keep only genuine restrictions — a family
    # that is in the split, and a proper non-empty subset of its current roster ids. Everything else
    # collapses to None (=> all members participate), preserving exact back-compat.
    family_participants = _clean_family_participants(body.family_participants, body.split_mode,
                                                     split_ids, trip["members"])

    # Phase 22 — EXACT: the per-person amounts MUST sum to the total (422 otherwise). Persist the
    # normalized (cent-snapped) amounts so the ledger/breakdown/report always foot exactly.
    try:
        converted = await convert_create_body(body, trip, user["id"])
    except (ExchangeRateError, ValueError) as exc:
        _conversion_http_error(exc)
    custom_amounts = converted["custom_amounts"]

    # budget over-check (net spend vs budget). Sums ALL rows; a negative amount (money back) nets the
    # running total down and never trips the warning.
    current = await _trip_spend(trip_id) if trip.get("budget") is not None else 0.0
    warning = _budget_warning(trip, current, converted["amount"])
    if warning and not force:
        return {"requires_confirmation": True, "warning": warning}

    eid = gen_id()
    doc = {
        "id": eid, "trip_id": trip_id,
        "amount": converted["amount"], "currency": trip_currency, "category": body.category,
        "description": body.description or "",
        "date": body.date,
        "time": body.time,  # optional wall-clock "HH:MM" (24h); None = no time
        "paid_by_member_id": body.paid_by_member_id,
        "split_member_ids": split_ids,
        "split_mode": body.split_mode,
        "weight_snapshots": body.weight_snapshots or None,
        "family_participants": family_participants,
        "custom_amounts": custom_amounts,  # Phase 22 — EXACT only; None otherwise
        # Step 22: receipts are no longer stored inline; the client uploads the bill image to
        # POST /trips/{id}/expenses/{eid}/receipt after the expense is created, which sets receipt_id.
        "created_by": user["id"], "created_at": now_utc().isoformat(),
    }
    doc.update(converted["metadata"])
    doc["conversion_history"] = [converted["history"]]
    await db.expenses.insert_one(doc)
    doc.pop("_id", None)
    await enqueue_financial_event(
        event_key=f"expense.created:{eid}",
        event_type="expense.created",
        source_id=eid,
        trip_id=trip_id,
        actor_user_id=user["id"],
        target="trip_expenses",
        background_tasks=background_tasks,
    )
    return {"expense": serialize_bson(doc), "warning": warning}


@router.get("/trips/{trip_id}/expenses")
async def list_expenses(trip_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    # Step 22: never return the heavy receipt bytes in the list. Expose a lightweight
    # `has_receipt` flag (true for a GridFS receipt_id OR a legacy inline blob) so the client
    # can render a thumbnail via the streamed GET endpoint without downloading bytes here.
    cur = db.expenses.aggregate([
        {"$match": {"trip_id": trip_id}},
        {"$sort": {"created_at": -1}},
        {"$addFields": {"has_receipt": {"$or": [
            {"$ifNull": ["$receipt_id", False]},
            {"$ifNull": ["$receipt_base64", False]},
        ]}}},
        {"$project": {"_id": 0, "receipt_base64": 0, "conversion_history": 0}},
    ])
    expenses = await cur.to_list(1000)
    for e in expenses:
        e["currency"] = e.get("currency") or trip.get("currency", "INR")
        e["split_mode"] = e.get("split_mode", "PER_CAPITA")
        e["has_receipt"] = bool(e.get("has_receipt"))
        # Additive, DISPLAY-only: per-expense participant share breakdown, re-derived from the SAME
        # calculator the ledger uses (services.expense_shares). Read-time only — never persisted,
        # never feeds balances/settle-up. No existing field is removed or changed.
        e["shares"] = expense_share_breakdown(e, trip["members"])
    return serialize_bson(expenses)


@router.get("/trips/{trip_id}/expenses/{expense_id}")
async def get_expense(trip_id: str, expense_id: str, user=Depends(get_current_user)):
    trip = await _trip_or_404(trip_id, user["id"])
    expense = await db.expenses.find_one(
        {"id": expense_id, "trip_id": trip_id}, {"_id": 0}
    )
    if not expense:
        raise HTTPException(404, "Expense not found")
    expense["currency"] = expense.get("currency") or trip.get("currency", "INR")
    expense["split_mode"] = expense.get("split_mode", "PER_CAPITA")
    expense["has_receipt"] = bool(expense.get("receipt_id") or expense.get("receipt_base64"))
    expense.pop("receipt_base64", None)
    expense["shares"] = expense_share_breakdown(expense, trip["members"])
    return serialize_bson(expense)


@router.patch("/trips/{trip_id}/expenses/{expense_id}")
async def update_expense(trip_id: str, expense_id: str, body: ExpenseUpdate,
                         user=Depends(get_current_user)):
    trip, expense = await _expense_modify_or_403(trip_id, expense_id, user["id"])
    raw = body.model_dump(exclude_unset=True)
    force = bool(raw.pop("force", False))
    if not raw:
        return serialize_bson(expense)

    trip_currency = trip.get("currency", "INR")
    stored_source_amount = stored_original_amount(expense)
    stored_source_currency = stored_original_currency(expense, trip_currency)
    stored_original_custom = stored_original_custom_amounts(expense)
    has_conversion = expense.get("conversion_version") is not None
    current_version = int(expense.get("conversion_version") or 0)
    field_names = set(body.model_fields_set)

    # amount/currency are backend-managed canonical fields for converted foreign expenses. Old
    # clients may echo unchanged values; changed values cannot be trusted as conversion inputs.
    canonical_amount_changed = "amount" in field_names and not _same_money(
        body.amount, expense.get("amount")
    )
    if "currency" in field_names and body.currency != trip_currency:
        if not MULTI_CURRENCY_EXPENSES_ENABLED:
            _foreign_disabled()
        _confirmation_required(
            "Use original_currency and approve a conversion quote; the ledger currency is fixed"
        )
    if stored_source_currency != trip_currency and canonical_amount_changed:
        _confirmation_required(
            "A converted expense's canonical amount cannot be edited directly; change the original "
            "amount and approve a new quote"
        )

    if "original_amount" in field_names and body.original_amount is None:
        raise HTTPException(422, {
            "code": "invalid_conversion", "message": "original_amount cannot be cleared",
            "retryable": False,
        })
    if "original_currency" in field_names and body.original_currency is None:
        raise HTTPException(422, {
            "code": "invalid_conversion", "message": "original_currency cannot be cleared",
            "retryable": False,
        })

    effective_source_amount = body.original_amount \
        if "original_amount" in field_names else stored_source_amount
    legacy_amount_change = (
        canonical_amount_changed
        and stored_source_currency == trip_currency
        and "original_amount" not in field_names
    )
    if legacy_amount_change:
        effective_source_amount = body.amount
    effective_source_currency = body.original_currency \
        if "original_currency" in field_names else stored_source_currency
    effective_date = body.date if "date" in field_names else expense.get("date")
    if not effective_date:
        raise HTTPException(422, {
            "code": "invalid_conversion", "message": "Expense date is required",
            "retryable": False,
        })

    original_amount_changed = not _same_money(effective_source_amount, stored_source_amount)
    original_currency_changed = effective_source_currency != stored_source_currency
    date_changed = effective_date != expense.get("date")
    explicit_reconversion = "conversion" in field_names and body.conversion is not None
    conversion_inputs_changed = (
        original_amount_changed or original_currency_changed or date_changed
        or explicit_reconversion or legacy_amount_change
    )

    effective_mode = body.split_mode \
        if "split_mode" in field_names else expense.get("split_mode", "PER_CAPITA")
    canonical_custom_sent = "custom_amounts" in field_names
    original_custom_sent = "original_custom_amounts" in field_names
    if canonical_custom_sent and stored_source_currency != trip_currency:
        if not _same_amount_map(body.custom_amounts, expense.get("custom_amounts")):
            _confirmation_required(
                "Enter EXACT allocations in the original currency; canonical allocations are locked"
            )
        canonical_custom_sent = False

    effective_original_custom = stored_original_custom
    if original_custom_sent:
        effective_original_custom = body.original_custom_amounts
    elif canonical_custom_sent:
        # Backward-compatible same-currency edit. Refund UIs may echo signed canonical shares;
        # original allocation inputs are stored as positive magnitudes.
        effective_original_custom = {}
        for member_id, value in (body.custom_amounts or {}).items():
            parsed = decimal_value(value)
            if decimal_value(effective_source_amount) < 0 and parsed < 0:
                parsed = -parsed
            effective_original_custom[member_id] = parsed

    allocation_changed = not _same_amount_map(
        effective_original_custom, stored_original_custom
    )
    entering_exact = effective_mode == "EXACT" and expense.get("split_mode") != "EXACT"
    allocation_write = effective_mode == "EXACT" and (allocation_changed or entering_exact)
    conversion_write = conversion_inputs_changed or allocation_write

    if conversion_write and effective_source_currency != trip_currency \
            and not MULTI_CURRENCY_EXPENSES_ENABLED:
        _foreign_disabled()

    new_contract_write = bool({
        "original_amount", "original_currency", "conversion", "original_custom_amounts",
    } & field_names)
    if conversion_write:
        expected = body.expected_conversion_version
        requires_expected = has_conversion and (
            stored_source_currency != trip_currency or new_contract_write
        )
        if (expected is not None and expected != current_version) \
                or (expected is None and requires_expected):
            _conversion_conflict()

    managed_fields = {
        "amount", "currency", "original_amount", "original_currency", "conversion",
        "expected_conversion_version", "custom_amounts", "original_custom_amounts",
    }
    updates = {key: value for key, value in raw.items() if key not in managed_fields}

    if "category" in updates and updates["category"] not in CATEGORIES:
        raise HTTPException(400, "Invalid category")
    member_ids = {member["id"] for member in trip["members"]}
    payer_id = updates.get("paid_by_member_id", expense.get("paid_by_member_id"))
    if payer_id not in member_ids:
        raise HTTPException(400, "paid_by_member_id invalid")
    if "split_member_ids" in updates:
        split_ids = updates["split_member_ids"] or [member["id"] for member in trip["members"]]
        for split_id in split_ids:
            if split_id not in member_ids:
                raise HTTPException(400, f"split member {split_id} invalid")
        updates["split_member_ids"] = split_ids
    else:
        split_ids = expense.get("split_member_ids") or [member["id"] for member in trip["members"]]

    if {"family_participants", "split_mode", "split_member_ids"} & field_names:
        raw_family = body.family_participants \
            if "family_participants" in field_names else expense.get("family_participants")
        updates["family_participants"] = _clean_family_participants(
            raw_family, effective_mode, split_ids, trip["members"]
        )

    # Preserve backend-managed size-freeze pins across client edits.
    if "weight_snapshots" in updates:
        frozen = expense.get("weight_frozen") or []
        old_snaps = expense.get("weight_snapshots") or {}
        new_snaps = dict(updates["weight_snapshots"] or {})
        for frozen_id in frozen:
            if frozen_id in old_snaps and frozen_id not in new_snaps:
                new_snaps[frozen_id] = old_snaps[frozen_id]
        updates["weight_snapshots"] = new_snaps or None

    history = None
    next_version = current_version + 1
    try:
        if conversion_inputs_changed:
            converted = await convert_expense(
                user_id=user["id"], trip_currency=trip_currency, date=effective_date,
                split_mode=effective_mode, members=trip["members"],
                original_amount=effective_source_amount,
                original_currency=effective_source_currency,
                original_custom_amounts=effective_original_custom,
                conversion=body.conversion, version=next_version, reason="inputs_changed",
            )
            updates.update({
                "amount": converted["amount"], "currency": trip_currency,
                "custom_amounts": converted["custom_amounts"], **converted["metadata"],
            })
            history = converted["history"]
        elif allocation_write:
            if has_conversion:
                reallocated = locked_exact_reallocation_update(
                    expense=expense,
                    original_custom_amounts=effective_original_custom or {},
                    members=trip["members"], user_id=user["id"], version=next_version,
                )
                updates.update({
                    "custom_amounts": reallocated["custom_amounts"],
                    **reallocated["metadata"],
                })
                history = reallocated["history"]
            else:
                # Lazily upgrade a legacy same-currency EXACT expense to precise metadata.
                converted = await convert_expense(
                    user_id=user["id"], trip_currency=trip_currency, date=effective_date,
                    split_mode=effective_mode, members=trip["members"],
                    original_amount=effective_source_amount,
                    original_currency=effective_source_currency,
                    original_custom_amounts=effective_original_custom,
                    conversion=None, version=1, reason="legacy_exact_upgraded",
                )
                updates.update({
                    "amount": converted["amount"], "currency": trip_currency,
                    "custom_amounts": converted["custom_amounts"], **converted["metadata"],
                })
                history = converted["history"]
        elif "split_mode" in updates and effective_mode != "EXACT":
            updates["custom_amounts"] = None
            updates["original_custom_amounts"] = None
    except (ExchangeRateError, ValueError) as exc:
        _conversion_http_error(exc)

    warning = None
    if conversion_write and trip.get("budget") is not None:
        canonical_candidate = float(updates.get("amount", expense.get("amount")))
        current = await _trip_spend(trip_id, excluding_expense_id=expense_id)
        warning = _budget_warning(trip, current, canonical_candidate)
        if warning and not force:
            return {"requires_confirmation": True, "warning": warning}

    if not updates and history is None:
        return serialize_bson(expense)
    query = _conversion_write_filter(
        trip_id, expense_id, expense, current_version
    ) if conversion_write else {"id": expense_id, "trip_id": trip_id}
    mutation = {"$set": updates}
    if history is not None:
        mutation["$push"] = {"conversion_history": history}
    result = await db.expenses.update_one(query, mutation)
    if conversion_write and getattr(result, "matched_count", 1) == 0:
        _conversion_conflict()
    saved = await db.expenses.find_one(
        {"id": expense_id, "trip_id": trip_id}, {"_id": 0}
    )
    return serialize_bson(saved)


@router.post("/trips/{trip_id}/expenses/{expense_id}/reconvert")
async def reconvert_expense(trip_id: str, expense_id: str, body: ReconvertIn,
                            user=Depends(get_current_user)):
    trip, expense = await _expense_modify_or_403(trip_id, expense_id, user["id"])
    if not MULTI_CURRENCY_EXPENSES_ENABLED:
        _foreign_disabled()
    current_version = int(expense.get("conversion_version") or 0)
    if body.expected_conversion_version != current_version:
        _conversion_conflict()
    trip_currency = trip.get("currency", "INR")
    source_currency = stored_original_currency(expense, trip_currency)
    if source_currency == trip_currency:
        raise HTTPException(422, {
            "code": "invalid_conversion",
            "message": "Same-currency expenses always use rate 1 and do not need reconversion",
            "retryable": False,
        })
    try:
        converted = await convert_expense(
            user_id=user["id"], trip_currency=trip_currency, date=expense.get("date"),
            split_mode=expense.get("split_mode", "PER_CAPITA"), members=trip["members"],
            original_amount=stored_original_amount(expense),
            original_currency=source_currency,
            original_custom_amounts=stored_original_custom_amounts(expense),
            conversion=ConversionRequest(
                mode="automatic", quote_id=body.quote_id, approved=body.approved,
                allow_stale=body.allow_stale,
            ),
            version=current_version + 1,
            reason="explicit_reconversion",
        )
    except (ExchangeRateError, ValueError) as exc:
        _conversion_http_error(exc)

    current = await _trip_spend(trip_id, excluding_expense_id=expense_id) \
        if trip.get("budget") is not None else 0.0
    warning = _budget_warning(trip, current, converted["amount"])
    if warning and not body.force:
        return {"requires_confirmation": True, "warning": warning}
    updates = {
        "amount": converted["amount"], "currency": trip_currency,
        "custom_amounts": converted["custom_amounts"], **converted["metadata"],
    }
    result = await db.expenses.update_one(
        _conversion_write_filter(trip_id, expense_id, expense, current_version),
        {"$set": updates, "$push": {"conversion_history": converted["history"]}},
    )
    if getattr(result, "matched_count", 1) == 0:
        _conversion_conflict()
    saved = await db.expenses.find_one(
        {"id": expense_id, "trip_id": trip_id}, {"_id": 0}
    )
    return {"expense": serialize_bson(saved), "warning": warning}


@router.delete("/trips/{trip_id}/expenses/{expense_id}")
async def delete_expense(trip_id: str, expense_id: str, user=Depends(get_current_user)):
    # Step 10: only the expense creator or a trip admin may delete (404 if missing, 403 otherwise).
    await _expense_modify_or_403(trip_id, expense_id, user["id"])
    # Step 22: clean up any GridFS receipt so we never leave orphaned receipts.files/.chunks.
    await delete_receipts_for_expense(expense_id)
    await db.expenses.delete_one({"id": expense_id, "trip_id": trip_id})
    return {"ok": True}
