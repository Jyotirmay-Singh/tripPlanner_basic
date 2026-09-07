"""Per-entity GROSS spend aggregation — read-only insight, ledger-neutral (Phase 12).

Pure helper (plain dicts/lists, no DB import — mirrors ``services/expense_shares.py``) that ranks
how much each entity (a standalone individual OR a whole family) PAID on a trip. "Spent" here is
deliberately simple and split/settlement-INDEPENDENT::

    paid(entity) = Σ amount  over expenses where amount > 0 AND paid_by_member_id == entity.id

It answers "who fronted the most money", so it ignores HOW an expense was split
(``split_mode`` / ``split_member_ids`` / ``weight_snapshots``), ignores settlements entirely, and
excludes refunds (negative-amount rows — the signed-amount "money back" mirror). The payer
``paid_by_member_id`` is ALREADY the entity id (an individual or a family), so no roll-up beyond
mapping the payer to its member is needed. Nothing here touches ``_compute_balances``, the
settlement engine, or any persisted document.
"""

from decimal import Decimal

from utils.currency_rules import decimal_amount, quantize_currency


def aggregate_spend(members: list, expenses: list, currency: str = "INR") -> dict:
    """Gross paid per entity, for the spend-ranking chart.

    Shape::

        {
          "total": <Σ of the rounded entity paids — equals the sum of the rendered bars>,
          "count": <number of entities that spent anything (paid > 0)>,
          "entities": [
            {"entity_id", "entity_type": "individual"|"family", "name", "paid", "expense_count"}
            for every member, in roster order (zero-spend entities included with paid 0.0)
          ],
        }

    Only positive amounts count (refunds / zero excluded — gross, not net). An expense whose
    ``paid_by_member_id`` is not a current member is skipped (defensive — e.g. a removed payer).
    Per-entity ``paid`` is rounded to the trip currency's legal precision and ``total`` sums those
    rendered values so the header figure equals the sum of the bars.
    """
    paid = {m["id"]: Decimal(0) for m in members}
    counts = {m["id"]: 0 for m in members}
    for e in expenses:
        try:
            amount = decimal_amount(e.get("amount", 0), label="Expense amount")
        except ValueError:
            continue
        if amount <= 0:
            continue  # gross positive spend only — refunds and zero rows do not count
        pid = e.get("paid_by_member_id")
        if pid not in paid:
            continue  # payer is no longer a member of this trip (defensive)
        paid[pid] += amount
        counts[pid] += 1
    entities = [
        {
            "entity_id": m["id"],
            "entity_type": m.get("kind", "individual"),
            "name": m.get("name", ""),
            "paid": float(quantize_currency(paid[m["id"]], currency)),
            "expense_count": counts[m["id"]],
        }
        for m in members
    ]
    total = float(quantize_currency(
        sum((Decimal(str(ent["paid"])) for ent in entities), Decimal(0)), currency
    ))
    count = sum(1 for ent in entities if ent["paid"] > 0)
    return {"total": total, "count": count, "entities": entities}
