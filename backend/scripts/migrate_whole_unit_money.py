"""Plan, apply, or revert the whole_unit_v1 ledger migration.

Examples (run from backend):
  python scripts/migrate_whole_unit_money.py dry-run
  python scripts/migrate_whole_unit_money.py apply --trip-id TRIP_ID
  python scripts/migrate_whole_unit_money.py revert --trip-id TRIP_ID
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from database import client, db  # noqa: E402
from services.whole_unit_migration import (  # noqa: E402
    WholeUnitMigrationError,
    apply_trip_migration,
    plan_trip_migration,
    revert_trip_migration,
    _load_trip_rows,
)


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Migrate active ledger money to whole units")
    parser.add_argument("mode", choices=("dry-run", "apply", "revert"))
    parser.add_argument("--trip-id", action="append", dest="trip_ids")
    return parser.parse_args()


async def _trip_ids(selected: list[str] | None) -> list[str]:
    if selected:
        return list(dict.fromkeys(selected))
    rows = await db.trips.find({}, {"_id": 0, "id": 1}).sort("id", 1).to_list(None)
    return [str(row["id"]) for row in rows]


async def _run() -> int:
    args = _arguments()
    results: list[dict] = []
    failed = False
    for trip_id in await _trip_ids(args.trip_ids):
        try:
            if args.mode == "dry-run":
                trip, expenses, settlements, payments, attempts = await _load_trip_rows(trip_id)
                result = plan_trip_migration(
                    trip,
                    expenses,
                    settlements,
                    payments,
                    active_attempts=attempts,
                ).public()
            elif args.mode == "apply":
                result = await apply_trip_migration(trip_id)
            else:
                result = await revert_trip_migration(trip_id)
            if result.get("status") == "blocked":
                failed = True
            results.append(result)
        except WholeUnitMigrationError as exc:
            failed = True
            results.append({
                "trip_id": trip_id,
                "status": "failed",
                "code": exc.code,
                "reason": str(exc),
            })
    print(json.dumps({"mode": args.mode, "results": results}, indent=2, default=str))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(_run()))
    finally:
        client.close()
