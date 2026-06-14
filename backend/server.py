import os

import config  # noqa: F401  (loads .env and initializes logging/resend before anything else)
from fastapi import FastAPI, APIRouter
from starlette.middleware.cors import CORSMiddleware

from config import logger
from database import client, db
from utils.common import gen_id, now_utc
from utils.security import hash_secret
from routes import auth, trips, members, expenses, balances, reports, meta

app = FastAPI(title="Trip Splitter")
api = APIRouter(prefix="/api")

for module in (auth, trips, members, expenses, balances, reports, meta):
    api.include_router(module.router)


# ---------- Startup ----------
@app.on_event("startup")
async def startup():
    await db.users.create_index("email", unique=True)
    await db.trips.create_index("code", unique=True)
    await db.expenses.create_index([("trip_id", 1), ("created_at", -1)])
    # seed admin
    admin_email = os.environ.get("ADMIN_EMAIL", "admin@trip.app")
    admin_password = os.environ.get("ADMIN_PASSWORD", "admin123")
    admin_pin = os.environ.get("ADMIN_PIN", "1234")
    existing = await db.users.find_one({"email": admin_email})
    if not existing:
        await db.users.insert_one({
            "id": gen_id(), "email": admin_email, "name": "Admin",
            "password_hash": hash_secret(admin_password),
            "pin_hash": hash_secret(admin_pin),
            "role": "admin", "created_at": now_utc().isoformat(),
        })
        logger.info("Seeded admin user")


@app.on_event("shutdown")
async def shutdown():
    client.close()


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
