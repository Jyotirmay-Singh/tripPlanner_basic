"""Explicit-target tool; dry-run is the default. Never inherits backend/.env database settings."""
import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--connection-env", required=True, help="Explicit environment-variable name holding the target URI")
    parser.add_argument("--database", required=True)
    parser.add_argument("--trip-id", required=True)
    parser.add_argument("--authorized-production-read", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--authorized-migration", action="store_true")
    parser.add_argument("--install-indexes", action="store_true")
    parser.add_argument("--authorized-index-changes", action="store_true")
    parser.add_argument("--activate", action="store_true")
    parser.add_argument("--authorized-activation", action="store_true")
    parser.add_argument("--accepted-plan-hash")
    parser.add_argument("--actor-user-id")
    parser.add_argument("--reason")
    args = parser.parse_args()
    if args.connection_env in {"MONGO_URL", "DATABASE_URL"}:
        parser.error("Use a task-specific target variable; shared ambient database variables are forbidden")
    uri = os.environ.get(args.connection_env)
    if not uri:
        parser.error("The explicit target variable is missing")
    if urlparse(uri).hostname not in {"localhost", "127.0.0.1", "::1"} and not args.authorized_production_read:
        parser.error("Non-loopback reads require separate production-read authorization")
    if args.install_indexes and not args.authorized_index_changes:
        parser.error("Index changes require separate authorization")
    if args.activate and (not args.apply or not args.authorized_activation):
        parser.error("Activation requires migration application and separate activation authorization")
    if args.apply and not (args.authorized_migration and args.accepted_plan_hash and args.actor_user_id and args.reason):
        parser.error("Application requires authorization, reviewed hash, current actor and reason")
    # Set safe import configuration explicitly before backend imports; dotenv cannot override it.
    os.environ["MONGO_URL"], os.environ["DB_NAME"] = uri, args.database
    os.environ.setdefault("JWT_SECRET", "offline-reconciliation-tool-unused-key")
    from motor.motor_asyncio import AsyncIOMotorClient
    from services.financial_corrections import ensure_indexes, index_prerequisites, inspect_index_data
    from services.historical_reconciliation import load_review_report, stage_and_apply
    client = AsyncIOMotorClient(uri, serverSelectionTimeoutMS=2000)
    database = client[args.database]
    try:
        if args.install_indexes:
            # Additive only; incompatible existing names/duplicates fail without destructive replacement.
            await ensure_indexes(database)
        if args.apply:
            result = await stage_and_apply(database, client, args.trip_id, args.accepted_plan_hash,
                                          args.actor_user_id, args.reason, activate=args.activate)
        else:
            from pymongo.read_concern import ReadConcern
            async with await client.start_session() as session:
                async def read(current):
                    report = await load_review_report(args.trip_id, database, session=current,
                        prerequisites=await index_prerequisites(database))
                    report["index_data_issues"] = await inspect_index_data(database)
                    report["activation_blocked"] |= bool(report["index_data_issues"])
                    return report
                result = await session.with_transaction(read, read_concern=ReadConcern("snapshot"))
        print(json.dumps(result, indent=2, default=str))
    finally:
        client.close()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        # Connection exceptions may contain credentials; only expose the typed diagnostic code.
        print(json.dumps({"error": getattr(exc, "code", None) or type(exc).__name__}), file=sys.stderr)
        sys.exit(1)
