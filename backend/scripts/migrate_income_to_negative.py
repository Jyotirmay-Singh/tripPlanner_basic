"""One-time migration: convert legacy ``kind:"income"`` rows into negative-amount expenses.

Income used to be EXCLUDED from balances; in the signed-amount model an income row becomes a normal
expense with ``amount = -abs(amount)`` (money coming back to the group). That DOES change historical
balances for income-containing trips, so this script is deliberately staged:

  python -m scripts.migrate_income_to_negative                  # dry-run (READ-ONLY) — the sign-off report
  python -m scripts.migrate_income_to_negative --apply          # writes a JSON backup, then migrates
  python -m scripts.migrate_income_to_negative --revert FILE    # restore from a backup file

Run it from the ``backend/`` directory (so ``database``/``services`` import and the same MONGO_URL /
DB_NAME from ``.env`` are used). It never touches positive expense rows, the app, or any other
collection. Idempotent: ``--apply`` re-run finds nothing left to migrate.
"""

import argparse
import asyncio
import json
import os
import sys
from datetime import datetime, timezone

# Allow running as a loose script (python scripts/migrate_income_to_negative.py) too.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from database import db, client  # noqa: E402
from services.income_migration import simulate_trip, to_negative_expense  # noqa: E402


async def _affected_trip_ids() -> list:
    return await db.expenses.distinct("trip_id", {"kind": "income"})


async def _load_trip_context(trip_id: str):
    trip = await db.trips.find_one({"id": trip_id}, {"_id": 0})
    expenses = await db.expenses.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    settlements = await db.settlements.find({"trip_id": trip_id}, {"_id": 0}).to_list(5000)
    return trip, expenses, settlements


def _fmt_money(v) -> str:
    return f"{v:,.2f}"


async def dry_run() -> int:
    trip_ids = await _affected_trip_ids()
    print("=" * 78)
    print("INCOME -> NEGATIVE EXPENSE MIGRATION — DRY RUN (read-only, no writes)")
    print("=" * 78)
    if not trip_ids:
        print("\nNo `kind:\"income\"` rows found. Nothing to migrate. Balances are unchanged.\n")
        return 0

    total_income_rows = 0
    flips = 0
    for tid in trip_ids:
        trip, expenses, settlements = await _load_trip_context(tid)
        if not trip:
            print(f"\n! Orphan income rows for missing trip {tid} (will still be migrated).")
            continue
        members = trip.get("members", [])
        name_by_id = {m["id"]: m.get("name", m["id"]) for m in members}
        sim = simulate_trip(members, expenses, settlements)
        total_income_rows += len(sim["income_rows"])

        print(f"\nTrip: {trip.get('name','?')}   (id {tid})")
        print(f"  Income rows -> negative expenses: {len(sim['income_rows'])}")
        for e in sim["income_rows"]:
            payer = name_by_id.get(e.get("paid_by_member_id"), "?")
            print(f"    - {e.get('date','?')}  {e.get('category','?'):<14} "
                  f"{_fmt_money(e['amount'])} (received by {payer}) "
                  f"-> stored as {_fmt_money(-abs(e['amount']))}")
        if sim["deltas"]:
            print("  Balance changes (member: before -> after):")
            for mid, d in sim["deltas"].items():
                print(f"    - {name_by_id.get(mid, mid):<18} "
                      f"{_fmt_money(d['before'])} -> {_fmt_money(d['after'])}")
        else:
            print("  Balance changes: none (income nets to zero against participants).")
        if sim["settled_flips"]:
            flips += 1
            was = "settled" if sim["settled_before"] else "unsettled"
            now = "settled" if sim["settled_after"] else "unsettled"
            print(f"  ** Settled status FLIPS: {was} -> {now} **")

    print("\n" + "-" * 78)
    print(f"Summary: {len(trip_ids)} trip(s) affected, {total_income_rows} income row(s), "
          f"{flips} settled-status flip(s).")
    print("Review the above. To apply: python -m scripts.migrate_income_to_negative --apply")
    print("-" * 78 + "\n")
    return 0


async def apply() -> int:
    income_rows = await db.expenses.find({"kind": "income"}, {"_id": 0}).to_list(100000)
    if not income_rows:
        print("Nothing to migrate (no `kind:\"income\"` rows). Already migrated or none existed.")
        return 0

    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = os.path.abspath(f"income_migration_backup_{ts}.json")
    backup = [{"id": e["id"], "kind": e["kind"], "amount": e["amount"]} for e in income_rows]
    with open(backup_path, "w", encoding="utf-8") as f:
        json.dump(backup, f, indent=2)
    print(f"Wrote reversible backup: {backup_path}  ({len(backup)} rows)")

    migrated = 0
    for e in income_rows:
        res = await db.expenses.update_one(
            {"id": e["id"]},
            {"$set": {"amount": to_negative_expense(e)["amount"]}, "$unset": {"kind": ""}},
        )
        migrated += res.modified_count
    print(f"Migrated {migrated} income row(s) to negative expenses (kind field dropped).")
    print(f"To revert: python -m scripts.migrate_income_to_negative --revert {backup_path}")
    return 0


async def revert(backup_path: str) -> int:
    with open(backup_path, "r", encoding="utf-8") as f:
        backup = json.load(f)
    restored = 0
    for row in backup:
        res = await db.expenses.update_one(
            {"id": row["id"]},
            {"$set": {"kind": row["kind"], "amount": row["amount"]}},
        )
        restored += res.modified_count
    print(f"Reverted {restored} row(s) from {backup_path} (restored kind + original amount).")
    return 0


async def _main_async(args) -> int:
    try:
        if args.revert:
            return await revert(args.revert)
        if args.apply:
            return await apply()
        return await dry_run()
    finally:
        client.close()


def main() -> int:
    p = argparse.ArgumentParser(description="Migrate income rows to negative expenses (reversible).")
    g = p.add_mutually_exclusive_group()
    g.add_argument("--apply", action="store_true", help="Write a backup, then migrate (mutating).")
    g.add_argument("--revert", metavar="BACKUP.json", help="Restore income rows from a backup file.")
    args = p.parse_args()
    return asyncio.run(_main_async(args))


if __name__ == "__main__":
    raise SystemExit(main())
