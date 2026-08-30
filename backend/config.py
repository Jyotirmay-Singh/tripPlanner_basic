from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import logging

import resend

# ---------- Setup ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger("trip-splitter")

MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
SENDER_EMAIL = os.environ.get("SENDER_EMAIL", "onboarding@resend.dev")
APP_URL = os.environ.get("APP_URL", "")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")

# Android push notifications are deliberately opt-in at runtime. Deploy the backend and client
# first, configure Expo enhanced push security + FCM v1 in EAS, then flip this switch in Render.
# Keeping the default off prevents an unconfigured deployment from accumulating stale outbox jobs.
PUSH_NOTIFICATIONS_ENABLED = os.environ.get("PUSH_NOTIFICATIONS_ENABLED", "false").strip().lower() in (
    "true", "1", "yes", "on",
)
EXPO_PUSH_ACCESS_TOKEN = os.environ.get("EXPO_PUSH_ACCESS_TOKEN", "").strip()

# Master switch for the Phase-9 email flows (email verification + forgot-PASSWORD). Default ON.
# Set EMAIL_FEATURES_ENABLED=false to "ghost" them until a deliverable sender domain exists:
# new signups are marked verified up-front (no nag banner), no verification/reset emails are sent
# (so nothing bounces), and the app hides the banner + "Forgot password?" link via GET /api/meta/config.
# Re-enable later by setting it back to true (or removing it) and redeploying — no frontend rebuild.
# Signed-in password changes remain available regardless of this email-delivery flag.
EMAIL_FEATURES_ENABLED = os.environ.get("EMAIL_FEATURES_ENABLED", "true").strip().lower() not in (
    "false", "0", "no", "off",
)

if RESEND_API_KEY:
    resend.api_key = RESEND_API_KEY

CATEGORIES = ["Travel", "Accommodation", "Local Transportation",
              "Local Sightseeing", "Food", "Shopping", "Other"]
