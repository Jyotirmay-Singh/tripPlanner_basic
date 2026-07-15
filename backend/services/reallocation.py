"""Step 8 — Retroactive Family Re-allocation Routine.

When a family's size changes (its `family_members` list grows or shrinks), this service decides what
happens to the trip's *past* PER_CAPITA expenses, driven by the `reweight_past` toggle:

- ``reweight_past=False`` (freeze the past): pin the member's OLD per-capita weight onto qualifying
  past expenses that are not already pinned, so their split stays at the pre-mutation value.
- ``reweight_past=True``  (recalculate the past, default): remove the member's *size-freeze* pins so
  those expenses float back to the new live weight.

``weight_snapshots`` (read by ``services.calculator.resolve_weights`` during PER_CAPITA math) is
dual-purpose: it also stores intentional per-expense *partial-family overrides* set at expense
creation (e.g. "only 2 of a family of 4 attended this dinner"). To avoid a retroactive recalc
silently erasing those overrides, every size-freeze pin is also recorded in a backend-managed
``weight_frozen`` array on the expense. Retroactive recalc only clears a pin when the member is in
``weight_frozen``; partial-family overrides (never in ``weight_frozen``) are preserved.

``plan_reallocation`` is pure (plain dicts/lists, no I/O) so it is unit-testable exactly like
``calculator.py``. The async helpers apply the plan to Mongo, atomically with the member-document
mutation when the deployment supports transactions (with a safe sequential fallback for standalone
MongoDB; all writes are idempotent absolute ``$set``s, so the fallback can never double-apply).
"""

from pymongo import UpdateOne
from pymongo.errors import OperationFailure, PyMongoError

# NOTE: `database` (and its `config` env requirements) is imported lazily inside the async helpers
# so that `plan_reallocation` stays a pure, server-free import for unit tests.


def plan_reallocation(member_id: str, old_weight: int, new_weight: int,
                      reweight_past: bool, expenses: list) -> dict:
    """Decide the per-expense weight_snapshots / weight_frozen changes for a family size change.

    member_id: the family member whose size changed.
    old_weight / new_weight: the member's per-capita weight before/after the change
        (from `utils.balances._weight_of_member`).
    reweight_past: False => freeze the past; True (default) => recalculate the past.
    expenses: plain dicts with at least `id`, `split_mode`, `split_member_ids`, `weight_snapshots`,
        and optionally `weight_frozen` (missing/None treated as {} / []).

    Returns:
        {"updates": [{"expense_id", "weight_snapshots": <new full map|None>,
                      "weight_frozen": <new full list|None>, "op": "set"|"unset"}],
         "set_count": int, "unset_count": int}

    The applier writes whole `weight_snapshots`/`weight_frozen` fields (computed here) rather than
    dotted-key `$set`/`$unset`, which would error when `weight_snapshots` is None. Empty map/list
    normalize to None to match the expense-creation convention. PER_FAMILY expenses, non-participant
    expenses, and no-op (old == new) changes never appear in `updates`.
    """
    if old_weight == new_weight:
        return {"updates": [], "set_count": 0, "unset_count": 0}

    updates: list = []
    set_count = 0
    unset_count = 0

    for e in expenses:
        # PER_FAMILY is size-independent (Section 5B); missing/None split_mode defaults to PER_CAPITA.
        if (e.get("split_mode") or "PER_CAPITA") != "PER_CAPITA":
            continue
        split_ids = e.get("split_member_ids") or []
        # Empty split_member_ids == "split among all" -> the member participates.
        if split_ids and member_id not in split_ids:
            continue

        snaps = dict(e.get("weight_snapshots") or {})
        frozen = list(e.get("weight_frozen") or [])

        if reweight_past is False:
            # Freeze the past: pin the OLD weight, but never overwrite an existing pin
            # (a partial-family override OR a prior freeze) — first pin wins.
            if member_id not in snaps:
                snaps[member_id] = int(old_weight)
                if member_id not in frozen:
                    frozen.append(member_id)
                updates.append({
                    "expense_id": e["id"],
                    "weight_snapshots": snaps or None,
                    "weight_frozen": frozen or None,
                    "op": "set",
                })
                set_count += 1
        else:
            # Recalculate the past: drop ONLY size-freeze pins (member in weight_frozen),
            # so partial-family overrides survive. Defensive: also clean a dangling frozen marker.
            if member_id in frozen:
                snaps.pop(member_id, None)
                frozen = [f for f in frozen if f != member_id]
                updates.append({
                    "expense_id": e["id"],
                    "weight_snapshots": snaps or None,
                    "weight_frozen": frozen or None,
                    "op": "unset",
                })
                unset_count += 1

    return {"updates": updates, "set_count": set_count, "unset_count": unset_count}


def _build_ops(trip_id: str, plan: dict) -> list:
    """Translate a plan into idempotent UpdateOne ops writing whole snapshot/frozen fields."""
    return [
        UpdateOne(
            {"id": u["expense_id"], "trip_id": trip_id},
            {"$set": {"weight_snapshots": u["weight_snapshots"],
                      "weight_frozen": u["weight_frozen"]}},
        )
        for u in plan["updates"]
    ]


async def _load_candidate_expenses(trip_id: str, member_id: str) -> list:
    """PER_CAPITA expenses where the member participates (explicitly, or via split-among-all)."""
    from database import db
    cur = db.expenses.find(
        {"trip_id": trip_id,
         "split_mode": {"$ne": "PER_FAMILY"},  # PER_CAPITA or legacy (missing) — never PER_FAMILY
         "$or": [{"split_member_ids": member_id}, {"split_member_ids": []}]},
        {"_id": 0},
    )
    return await cur.to_list(5000)


async def apply_reallocation(trip_id: str, plan: dict, session=None) -> dict:
    """Apply a reallocation plan to db.expenses in one bulk_write. Empty plan -> no DB call."""
    from database import db
    ops = _build_ops(trip_id, plan)
    modified = 0
    if ops:
        res = await db.expenses.bulk_write(ops, session=session)
        modified = res.modified_count
    return {"set_count": plan["set_count"], "unset_count": plan["unset_count"], "modified": modified}


async def reallocate_on_member_change(trip_id: str, member_id: str, old_weight: int,
                                      new_weight: int, reweight_past: bool, session=None) -> dict:
    """Load candidate expenses, plan the reallocation, and apply it (no member-doc mutation)."""
    if old_weight == new_weight:
        return {"set_count": 0, "unset_count": 0, "modified": 0}
    expenses = await _load_candidate_expenses(trip_id, member_id)
    plan = plan_reallocation(member_id, old_weight, new_weight, reweight_past, expenses)
    return await apply_reallocation(trip_id, plan, session=session)


_supports_txn = None  # cached capability probe (None = not yet checked)


async def _transactions_supported() -> bool:
    """True iff the MongoDB deployment supports multi-document transactions (replica set / mongos)."""
    global _supports_txn
    if _supports_txn is None:
        from database import client
        try:
            info = await client.admin.command("hello")
            _supports_txn = bool(info.get("setName") or info.get("msg") == "isdbgrid")
        except Exception:
            _supports_txn = False
    return _supports_txn


async def run_member_update_with_reallocation(trip_id: str, member_id: str, member_updates: dict,
                                              old_weight: int, new_weight: int,
                                              reweight_past: bool) -> dict:
    """Atomically apply the member-document update AND the past-expense reallocation.

    Uses a MongoDB transaction when supported; otherwise (standalone Mongo) falls back to sequential
    writes without a session. All writes are idempotent absolute `$set`s, so the fallback after an
    aborted transaction can never double-apply. Returns the reallocation summary.
    """
    from database import db, client
    if old_weight != new_weight:
        expenses = await _load_candidate_expenses(trip_id, member_id)
        plan = plan_reallocation(member_id, old_weight, new_weight, reweight_past, expenses)
    else:
        plan = {"updates": [], "set_count": 0, "unset_count": 0}
    ops = _build_ops(trip_id, plan)

    async def _do(session):
        if member_updates:
            await db.trips.update_one(
                {"id": trip_id, "members.id": member_id},
                {"$set": member_updates}, session=session,
            )
        if ops:
            await db.expenses.bulk_write(ops, session=session)

    if await _transactions_supported():
        try:
            async with await client.start_session() as s:
                async with s.start_transaction():
                    await _do(s)
            return {"set_count": plan["set_count"], "unset_count": plan["unset_count"]}
        except (OperationFailure, PyMongoError):
            # Transaction failed (e.g. deployment changed) — retry sequentially (idempotent).
            pass

    await _do(None)
    return {"set_count": plan["set_count"], "unset_count": plan["unset_count"]}


async def freeze_and_remove_member(trip_id: str, member_id: str, weight: int,
                                   user_ids: list = None, verify=None) -> dict:
    """Remove an entity (individual OR whole family) while keeping every other balance identical.

    Removing a member id from the trip's ``members`` while its id is still referenced by past
    expenses is only balance-neutral when the member's per-capita *weight* survives the removal.
    ``resolve_weights`` defaults an unknown id to 1, so:
      - weight == 1 (individual / family of one): the default already equals the real weight -> no
        expense writes are needed; we simply ``$pull`` the member.
      - weight  > 1 (family of N): we first PIN ``weight`` onto the member's past PER_CAPITA
        expenses (the exact Step-8 freeze, ``reweight_past=False``) so H is preserved, then ``$pull``.

    ``user_ids`` (P2 + Phase 25): the app users linked to the removed member — the entity's own
    ``user_id`` AND any per-member linked sub-members (a family can hold several) — are evicted from
    the trip's ``user_ids`` (revokes access) and ``admin_ids`` (revokes admin rights) in the SAME
    atomic ``$pull``, so none are left as a ghost with lingering access; ``join_trip`` lets them rejoin.

    ``verify`` (P5): an optional async callable run as the FIRST step inside the write (before any
    freeze pin is written). It recomputes the settlement gate against the freshest committed state and
    raises ``HTTPException(409)`` if a concurrent expense un-settled the target between the upfront
    check and the write — aborting the transaction with nothing written (closes the TOCTOU window).

    This reuses the Step-8 pins, which are balance-neutral by construction (they reproduce the
    weights ``_compute_balances`` already used). PER_FAMILY expenses are size-independent and never
    touched. The freeze + ``$pull`` are applied atomically (transaction with a sequential idempotent
    fallback), mirroring ``run_member_update_with_reallocation``.
    """
    from database import db, client

    if weight > 1:
        expenses = await _load_candidate_expenses(trip_id, member_id)
        # new_weight=0 is a sentinel that only forces old != new; reweight_past=False uses old_weight.
        plan = plan_reallocation(member_id, weight, 0, reweight_past=False, expenses=expenses)
    else:
        plan = {"updates": [], "set_count": 0, "unset_count": 0}
    ops = _build_ops(trip_id, plan)

    pull: dict = {"members": {"id": member_id}}
    uids = [u for u in (user_ids or []) if u]
    if uids:
        # P2 + Phase 25: evict every app user linked to this member (entity + per-member) in one write.
        pull["user_ids"] = {"$in": uids}
        pull["admin_ids"] = {"$in": uids}

    async def _do(session):
        if verify is not None:
            # P5: re-assert the settlement gate at write time; raises 409 to roll back on a race.
            await verify()
        if ops:
            await db.expenses.bulk_write(ops, session=session)
        await db.trips.update_one(
            {"id": trip_id}, {"$pull": pull}, session=session,
        )

    if await _transactions_supported():
        try:
            async with await client.start_session() as s:
                async with s.start_transaction():
                    await _do(s)
            return {"set_count": plan["set_count"], "unset_count": plan["unset_count"]}
        except (OperationFailure, PyMongoError):
            pass

    await _do(None)
    return {"set_count": plan["set_count"], "unset_count": plan["unset_count"]}
