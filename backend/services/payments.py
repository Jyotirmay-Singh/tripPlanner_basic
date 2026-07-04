"""Pure per-pair roll-up of recorded partial payments (Phase 20) — DISPLAY-only.

Payments are directed money movements overlaid onto ``net`` in ``_compute_balances`` exactly like a
non-pending settlement, so the greedy ``minimize_transfers`` already re-derives the residual pairs and
this module never touches the ledger. It only groups payment records by their ``(from -> to)``
direction so the UI/report can show, per suggested pair, the current payable (the greedy amount, which
is already net of payments), what has been paid along that direction, and a derived status.

Pure (plain dicts/lists, no DB/IO), mirroring ``frontend/src/payments.ts`` and the other pure service
helpers (``services/spend_summary.py`` etc.). Reused by reconciliation tests.
"""

_EPS = 0.01


def _dir(row: dict) -> tuple:
    return (row.get("from_member_id"), row.get("to_member_id"))


def payment_status(current_payable: float, paid: float) -> str:
    """Derived state for a pair: 'paid' (fully settled with payments), 'partial' (some paid, some
    left), or 'open' (nothing recorded). Mirrors ``paymentStatus`` in ``frontend/src/payments.ts``."""
    if paid <= _EPS:
        return "open"
    return "paid" if current_payable <= _EPS else "partial"


def pair_blocks(transfers: list, payments: list) -> list:
    """Roll payment records up per debtor->creditor direction.

    ``transfers``: the current greedy suggestions (``[{from_member_id,to_member_id,amount}]``) — each
    ``amount`` is already the RESIDUAL after payments (they were overlaid into ``net`` upstream).
    ``payments``: every payment record for the trip (``{from_member_id,to_member_id,amount,created_at}``).

    Returns one block per current suggested pair (in suggestion order), followed by a block for every
    payment direction that no longer appears as a suggestion (fully settled, ``current_payable`` 0),
    ordered by most-recent payment. Each block::

        {from_member_id, to_member_id, current_payable, paid, original_payable, status, payments}

    where ``payments`` is that direction's records newest-first and
    ``original_payable = current_payable + paid``. ``sum(block.paid)`` equals ``sum(payment.amount)``.
    """
    by_dir: dict = {}
    for p in payments:
        by_dir.setdefault(_dir(p), []).append(p)
    for lst in by_dir.values():
        lst.sort(key=lambda p: p.get("created_at") or "", reverse=True)  # newest-first

    blocks = []
    seen = set()
    for t in transfers:
        d = _dir(t)
        seen.add(d)
        recs = by_dir.get(d, [])
        paid = round(sum(r["amount"] for r in recs), 2)
        current = round(t.get("amount", 0.0), 2)
        blocks.append({
            "from_member_id": d[0], "to_member_id": d[1],
            "current_payable": current, "paid": paid,
            "original_payable": round(current + paid, 2),
            "status": payment_status(current, paid),
            "payments": recs,
        })

    # Settled-only directions: payments exist but the pair is no longer suggested (residual 0).
    leftovers = [d for d in by_dir if d not in seen]
    leftovers.sort(key=lambda d: (by_dir[d][0].get("created_at") or ""), reverse=True)
    for d in leftovers:
        recs = by_dir[d]
        paid = round(sum(r["amount"] for r in recs), 2)
        blocks.append({
            "from_member_id": d[0], "to_member_id": d[1],
            "current_payable": 0.0, "paid": paid,
            "original_payable": paid,
            "status": payment_status(0.0, paid),
            "payments": recs,
        })
    return blocks
