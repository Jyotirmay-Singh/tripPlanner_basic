import os
from contextlib import asynccontextmanager

import config  # noqa: F401  (loads .env and initializes logging/resend before anything else)
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware

from config import logger
from database import client, db
from utils.common import gen_id, now_utc
from utils.date_rules import legacy_to_iso
from utils.members import demote_family_entity_email
from utils.email_rules import is_allowed_email
from utils.security import hash_secret
from utils.emailer import sender_mode_summary
from routes import auth, trips, members, expenses, balances, reports, meta, receipts, spend, payments, chat, push
from services.push_notifications import start_push_dispatcher, stop_push_dispatcher


# ---------- Startup / Shutdown ----------
# Lifespan handler (the modern replacement for the deprecated @app.on_event hooks):
# everything before `yield` runs on startup, everything after runs on shutdown.
async def _remove_retired_pin_data() -> None:
    """Idempotently remove the retired credential and its legacy raw reset-token store."""
    await db.users.update_many({"pin_hash": {"$exists": True}}, {"$unset": {"pin_hash": ""}})
    await db.drop_collection("password_reset_tokens")


@asynccontextmanager
async def lifespan(app: FastAPI):
    await db.users.create_index("email", unique=True)
    await db.trips.create_index("code", unique=True)
    await db.expenses.create_index([("trip_id", 1), ("created_at", -1)])
    # Phase 10: settlement history list (newest-first) per trip.
    await db.settlements.create_index([("trip_id", 1), ("created_at", -1)])
    # Phase 20: recorded (partial) payments list (newest-first) per trip.
    await db.payments.create_index([("trip_id", 1), ("created_at", -1)])
    # Android push registrations and durable outbox. A token may exist in old inactive rows, but
    # exactly one active installation can own it at a time.
    await db.push_devices.create_index("installation_id", unique=True)
    await db.push_devices.create_index(
        "token", unique=True, partialFilterExpression={"active": True},
    )
    await db.push_devices.create_index([("user_id", 1), ("active", 1)])
    await db.notification_outbox.create_index("event_key", unique=True)
    await db.notification_outbox.create_index([("status", 1), ("next_attempt_at", 1)])
    # Retain a month of delivery diagnostics without letting the free Mongo tier grow forever.
    # Mongo's TTL monitor ignores active rows where completed_at is null.
    await db.notification_outbox.create_index("completed_at", expireAfterSeconds=30 * 24 * 60 * 60)
    # Per-trip chat history, idempotent client retries, stable sequence pagination, and read state.
    await db.chat_messages.create_index([("trip_id", 1), ("sequence", -1)], unique=True)
    await db.chat_messages.create_index(
        [("trip_id", 1), ("sender_user_id", 1), ("client_message_id", 1)], unique=True
    )
    await db.chat_reads.create_index([("trip_id", 1), ("user_id", 1)], unique=True)
    await db.chat_counters.create_index("trip_id", unique=True)
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
    # Password-only auth migration. Removing obsolete hashes and raw PIN-reset tokens is
    # idempotent and ensures the retired credential cannot be used or recovered after cutover.
    await _remove_retired_pin_data()
    # backfill admin_ids for legacy trips (root admin = owner)
    await db.trips.update_many(
        {"$or": [{"admin_ids": {"$exists": False}}, {"admin_ids": None}, {"admin_ids": []}]},
        [{"$set": {"admin_ids": ["$owner_id"]}}],
    )
    # Phase 20 concurrency guard: every trip carries a `version` int that the optimistic
    # payment-write guard filters on ({"version": current} + $inc). Backfill legacy trips so the
    # guard can match them. Idempotent — only touches rows missing the field.
    await db.trips.update_many({"version": {"$exists": False}}, {"$set": {"version": 0}})
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
    # Every expense now records the currency it was entered in. Legacy rows predate that field and
    # were always interpreted as their trip's single currency, so stamp that code explicitly. The
    # migration is idempotent and preserves any already-recorded expense currency.
    async for t in db.trips.find({}, {"id": 1, "currency": 1}):
        await db.expenses.update_many(
            {
                "trip_id": t["id"],
                "$or": [{"currency": {"$exists": False}}, {"currency": None}],
            },
            {"$set": {"currency": t.get("currency") or "INR"}},
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

    # Phase 26: an email now identifies a PERSON, never a family. Migrate any family still carrying an
    # ENTITY-level email or linked account down onto a member slot (first slot whose email + account
    # are both free), preserving the linked account's trip access. Idempotent — demote_family_entity_email
    # returns None once a family is clean, so each family is rewritten at most once.
    async for t in db.trips.find({"members.kind": "family"}, {"id": 1, "members": 1}):
        members_list = t.get("members", [])
        changed = False
        for i, m in enumerate(members_list):
            if m.get("kind") != "family":
                continue
            demoted = demote_family_entity_email(m)
            if demoted is not None:
                members_list[i] = demoted
                changed = True
            elif m.get("email") or m.get("user_id"):
                logger.warning(
                    "Phase 26 migration: family '%s' in trip %s carries a leftover entity "
                    "email/account but has no free member slot; left unchanged.",
                    m.get("name"), t["id"],
                )
        if changed:
            await db.trips.update_one({"id": t["id"]}, {"$set": {"members": members_list}})

    # seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@gmail.com").lower().strip()
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    if not is_allowed_email(admin_email):
        logger.warning(f"ADMIN_EMAIL '{admin_email}' is not a @gmail.com address")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": gen_id(), "email": admin_email, "name": "Admin",
            "password_hash": hash_secret(admin_password),
            "role": "admin", "created_at": now_utc().isoformat(),
            "email_verified": True, "credentials_set": True,
        })
        logger.info("Seeded admin user")

    # one-time, secret-free summary of how outbound email behaves in this process
    logger.info(sender_mode_summary())

    await start_push_dispatcher()
    try:
        yield
    finally:
        await stop_push_dispatcher()
        client.close()


app = FastAPI(title="Trip Splitter", lifespan=lifespan)
api = APIRouter(prefix="/api")

for module in (auth, trips, members, expenses, balances, reports, meta, receipts, spend, payments, chat, push):
    api.include_router(module.router)


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
