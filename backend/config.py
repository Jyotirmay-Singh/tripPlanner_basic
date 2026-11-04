from dotenv import load_dotenv
from pathlib import Path

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

import os
import logging

# ---------- Setup ----------
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
logger = logging.getLogger("splitora")

MONGO_URL = os.environ['MONGO_URL']
DB_NAME = os.environ['DB_NAME']
JWT_SECRET = os.environ['JWT_SECRET']
JWT_ALGORITHM = "HS256"
APP_NAME = os.environ.get("APP_NAME", "Splitora").strip() or "Splitora"
APP_URL = os.environ.get("APP_URL", "").strip().rstrip("/")
EMAILJS_SERVICE_ID = os.environ.get("EMAILJS_SERVICE_ID", "").strip()
EMAILJS_PUBLIC_KEY = os.environ.get("EMAILJS_PUBLIC_KEY", "").strip()
EMAILJS_PRIVATE_KEY = os.environ.get("EMAILJS_PRIVATE_KEY", "").strip()
EMAILJS_VERIFICATION_TEMPLATE_ID = os.environ.get("EMAILJS_VERIFICATION_TEMPLATE_ID", "").strip()
EMAILJS_RESET_TEMPLATE_ID = os.environ.get("EMAILJS_RESET_TEMPLATE_ID", "").strip()
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")

# The application-wide operator account is intentionally fixed in server code.  Per-trip admins
# live in each trip's ``admin_ids`` array; this identity is the only account allowed to bypass
# trip membership/ownership checks for professional application maintenance.
SUPER_ADMIN_EMAIL = "jyotirmaysingh03@gmail.com"

# Secure trip-invite links are rollout-gated independently from the legacy six-character code.
# The public URL is deliberately configurable so links can move to a branded domain without a
# backend code change; both hosts remain supported by the Android binary during migration.
INVITE_LINKS_ENABLED = os.environ.get("INVITE_LINKS_ENABLED", "false").strip().lower() in (
    "true", "1", "yes", "on",
)
INVITE_BASE_URL = os.environ.get(
    "INVITE_BASE_URL", "https://tripsplitter-web.vercel.app",
).strip().rstrip("/")

# Android push notifications are deliberately opt-in at runtime. Deploy the backend and client
# first, configure Expo enhanced push security + FCM v1 in EAS, then flip this switch in Render.
# Keeping the default off prevents an unconfigured deployment from accumulating stale outbox jobs.
PUSH_NOTIFICATIONS_ENABLED = os.environ.get("PUSH_NOTIFICATIONS_ENABLED", "false").strip().lower() in (
    "true", "1", "yes", "on",
)
EXPO_PUSH_ACCESS_TOKEN = os.environ.get("EXPO_PUSH_ACCESS_TOKEN", "").strip()

# Multi-currency expense conversion is deliberately rollout-gated. The backend can be deployed
# first (including its read compatibility and cache indexes), followed by the client, before this
# switch is enabled. Frankfurter v2 needs no API key.
MULTI_CURRENCY_EXPENSES_ENABLED = os.environ.get(
    "MULTI_CURRENCY_EXPENSES_ENABLED", "false"
).strip().lower() in ("true", "1", "yes", "on")

# Session 2 supplies a read protocol and internal journal only. No group activation is automatic.
EXPENSE_SETTLEMENT_ENABLED = os.environ.get(
    "EXPENSE_SETTLEMENT_ENABLED", "false"
).strip().lower() in ("true", "1", "yes", "on")

# Operator-controlled delivery rollout; see docs/EMAIL_SETUP.md for the accepted provider limitation.
# Disabling delivery never establishes email ownership or changes account access.
EMAIL_FEATURES_ENABLED = os.environ.get("EMAIL_FEATURES_ENABLED", "false").strip().lower() not in (
    "false", "0", "no", "off",
)

from category_names import CATEGORIES
