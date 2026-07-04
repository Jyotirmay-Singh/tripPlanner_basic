import os
from contextlib import asynccontextmanager

import config  # noqa: F401  (loads .env and initializes logging/resend before anything else)
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware

from config import logger
from database import client, db
from utils.common import gen_id, now_utc
from utils.date_rules import legacy_to_iso
from utils.email_rules import is_allowed_email
from utils.security import hash_secret
from utils.emailer import sender_mode_summary
from routes import auth, trips, members, expenses, balances, reports, meta, receipts, spend, payments


# ---------- Startup / Shutdown ----------
# Lifespan handler (the modern replacement for the deprecated @app.on_event hooks):
# everything before `yield` runs on startup, everything after runs on shutdown.
@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.users.create_index("email", unique=True)
    await db.trips.create_index("code", unique=True)
    await db.expenses.create_index([("trip_id", 1), ("created_at", -1)])
    # Phase 10: settlement history list (newest-first) per trip.
    await db.settlements.create_index([("trip_id", 1), ("created_at", -1)])
    # Phase 20: recorded (partial) payments list (newest-first) per trip.
    await db.payments.create_index([("trip_id", 1), ("created_at", -1)])
    # Step 22: index GridFS receipt lookup/cleanup by the owning expense.
    await db["receipts.files"].create_index("metadata.expense_id")
    # Phase 9: hashed/typed email tokens (verify-email + reset-password). Unique by hash;
    # TTL index purges expired rows (expireAfterSeconds=0 => delete once expires_at passes).
    await db.auth_tokens.create_index("token_hash", unique=True)
    await db.auth_tokens.create_index("expires_at", expireAfterSeconds=0)
    # Phase 9: grandfather every pre-existing user (incl. the seeded admin) as already
    # verified and credential-complete so the new email-verification / set-credentials flows
    # never lock anyone out. Idempotent: only touches docs missing the field.
    await db.users.update_many({"email_verified": {"$exists": False}}, {"$set": {"email_verified": True}})
    await db.users.update_many({"credentials_set": {"$exists": False}}, {"$set": {"credentials_set": True}})
    # backfill admin_ids for legacy trips (root admin = owner)
    await db.trips.update_many(
        {"$or": [{"admin_ids": {"$exists": False}}, {"admin_ids": None}, {"admin_ids": []}]},
        [{"$set": {"admin_ids": ["$owner_id"]}}],
    )
    # Phase 10: legacy settlements (from the old offset-always /settle) carry no `status`.
    # Stamp them paid (paid_at = created_at) so they keep offsetting and render in history.
    # Idempotent — only touches rows missing the field.
    await db.settlements.update_many(
        {"status": {"$exists": False}},
        [{"$set": {"status": "paid", "paid_at": "$created_at"}}],
    )
    # backfill start_date/end_date for legacy single-date trips: parse the old DD-MM-YY
    # travel_date into YYYY-MM-DD and set both endpoints to it (idempotent — only un-migrated
    # trips). Done in Python since DD-MM-YY parsing is awkward in an aggregation pipeline.
    async for t in db.trips.find({"start_date": {"$exists": False}}, {"id": 1, "travel_date": 1}):
        iso_date = legacy_to_iso(t.get("travel_date"))
        if iso_date:
            await db.trips.update_one(
                {"id": t["id"]},
                {"$set": {"start_date": iso_date, "end_date": iso_date}},
            )
    # Intra-family per-member ids: backfill stable ids parallel to each family's family_members so
    # per-expense member participation survives roster edits. Idempotent — a trip is rewritten only
    # when a family member is missing ids or the parallel array length drifted.
    async for t in db.trips.find({"members.kind": "family"}, {"id": 1, "members": 1}):
        members_list = t.get("members", [])
        changed = False
        for m in members_list:
            if m.get("kind") != "family":
                continue
            names = m.get("family_members", []) or []
            ids = m.get("family_member_ids") or []
            if len(ids) != len(names):
                m["family_member_ids"] = [
                    ids[i] if i < len(ids) and ids[i] else gen_id() for i in range(len(names))
                ]
                changed = True
        if changed:
            await db.trips.update_one({"id": t["id"]}, {"$set": {"members": members_list}})

    # seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@gmail.com").lower().strip()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    admin_pin = os.environ.get("ADMIN_PIN", "1234")
    if not is_allowed_email(admin_email):
        logger.warning(f"ADMIN_EMAIL '{admin_email}' is not a @gmail.com address")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": gen_id(), "email": admin_email, "name": "Admin",
            "password_hash": hash_secret(admin_password),
            "pin_hash": hash_secret(admin_pin),
            "role": "admin", "created_at": now_utc().isoformat(),
            "email_verified": True, "credentials_set": True,
        })
        logger.info("Seeded admin user")

    # one-time, secret-free summary of how outbound email behaves in this process
    logger.info(sender_mode_summary())

    yield

    client.close()


app = FastAPI(title="Trip Splitter", lifespan=lifespan)
api = APIRouter(prefix="/api")

for module in (auth, trips, members, expenses, balances, reports, meta, receipts, spend, payments):
    api.include_router(module.router)


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
