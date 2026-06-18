# Trip Expense Splitter

A mobile app for tracking trip expenses, splitting costs between individuals and
families, settling balances, and exporting reports.

- **Frontend:** Expo SDK 54 / React Native (file-based routing via `expo-router`)
- **Backend:** FastAPI + MongoDB (async access via Motor)
- **Auth:** bcrypt-hashed password + 4-digit PIN, JWT bearer tokens, optional Google Sign-In

See [`USER_GUIDE.md`](USER_GUIDE.md) for full feature documentation and
[`memory/PRD.md`](memory/PRD.md) for the product spec.

## Features

- Create trips and invite members via a join code (as an individual, into an
  existing family, or by starting a new family).
- Split expenses two ways: **per person** (divide by total people) or **per family**
  (divide by entity), selectable per transaction.
- Greedy minimum-transaction settle-up that shows who owes whom.
- Role-based access: trip admins manage members/families; expenses are editable by
  their creator or a trip admin.
- Retroactive rebalancing when a family's size changes.
- Receipt photo capture and save-to-gallery.
- XLSX report export.

> This project is **Gmail-only**: every email accepted (register, login, forgot-PIN,
> linked member emails, Google sign-in) must end in `@gmail.com`, enforced server-side
> by `backend/utils/email_rules.py` and client-side by `frontend/src/validation.ts`.

## Prerequisites

- Python 3.11+
- Node.js + Yarn (Classic)
- A MongoDB instance (local `mongodb://localhost:27017` or hosted)

## Backend

```bash
cd backend
python -m venv .venv
source .venv/Scripts/activate   # Windows (Git Bash); use .venv/bin/activate on macOS/Linux
pip install -r requirements.txt

uvicorn server:app --reload     # serves the API on http://localhost:8000
```

### Tests

```bash
cd backend
pytest                                  # full suite (integration tests need a running server)
pytest tests/test_calculator.py         # unit tests run without a server
```

Unit tests (`test_calculator`, `test_per_capita`, `test_per_family`,
`test_report_builder`, `test_reallocation`) import the services directly and need no
server. The remaining integration tests issue HTTP requests against
`EXPO_PUBLIC_BACKEND_URL` (default `http://localhost:8000`) and **skip** if the server
or admin login is unavailable.

### Backend environment (`backend/.env`)

| Variable | Purpose |
|----------|---------|
| `MONGO_URL` | MongoDB connection string (required) |
| `DB_NAME` | Database name (required) |
| `JWT_SECRET` | HS256 signing key for auth tokens (required) |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_PIN` | Seed superuser, created on startup if missing (email must be `@gmail.com`) |
| `RESEND_API_KEY`, `SENDER_EMAIL`, `APP_URL` | Transactional email (forgot-PIN). If `RESEND_API_KEY` is unset, the reset token is logged instead of emailed |
| `GOOGLE_CLIENT_ID` | OAuth client ID used to verify Google ID tokens for `POST /api/auth/google` |

## Frontend

```bash
cd frontend
yarn install
yarn start        # Expo dev server — scan the QR code with Expo Go
# or: yarn web / yarn android / yarn ios
yarn lint
```

### Frontend environment (`frontend/.env`)

| Variable | Purpose |
|----------|---------|
| `EXPO_PUBLIC_BACKEND_URL` | API base URL (default `http://localhost:8000`) |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`, `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` | OAuth client IDs for "Sign in with Google" |

> **Running on a physical device or Android emulator:** `http://localhost:8000` resolves
> to the device itself, not your dev machine. Set `EXPO_PUBLIC_BACKEND_URL` to your
> machine's LAN IP (e.g. `http://192.168.1.50:8000`) or an HTTPS tunnel. Web and the iOS
> simulator can use `localhost` directly.
