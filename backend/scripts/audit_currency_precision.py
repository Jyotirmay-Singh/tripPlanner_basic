"""Audit persisted money values before enabling multi-currency expenses.

Run from the backend directory with:

    python -m scripts.audit_currency_precision --dry-run

This command is strictly read-only. It exits 1 when a violation is present and never
rounds, migrates, or updates a document.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from collections.abc import Sequence

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services.currency_precision_audit import audit_database  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only audit of persisted amounts against each trip or expense currency's "
            "ISO precision. No document is ever changed."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Explicitly request read-only mode (the default and only mode); useful in rollout "
            "runbooks."
        ),
    )
    return parser


async def _run() -> int:
    from database import client, db

    try:
        violations = await audit_database(db)
    finally:
        client.close()

    print(json.dumps({
        "ok": not violations,
        "violation_count": len(violations),
        "violations": violations,
    }, indent=2))
    return 1 if violations else 0


def main(argv: Sequence[str] | None = None) -> int:
    # Parse before importing database in _run so --help never initializes a MongoDB client.
    build_parser().parse_args(argv)
    return asyncio.run(_run())


if __name__ == "__main__":
    raise SystemExit(main())
