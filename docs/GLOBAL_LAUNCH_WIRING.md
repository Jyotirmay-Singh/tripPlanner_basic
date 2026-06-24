# Global Launch Wiring — Render · Vercel · MongoDB Atlas · Google OAuth

Runbook for the **dashboard-side** wiring that makes the hosted app fully functional globally.
None of this is in the repo — it's all environment variables and OAuth console settings on services
you control. The code is already deployed and auto-builds from `main`:

| Service | URL | Deploy trigger |
|---|---|---|
| Backend (FastAPI) | `https://tripsplitter-api.onrender.com` | Render Blueprint (`render.yaml`), auto-deploy from `main` |
| Web (Expo export) | `https://tripsplitter-web.vercel.app` | Vercel, auto-deploy from `main` |
| Database | MongoDB Atlas M0 (AWS Singapore) | n/a (managed) |

> Related: `docs/EMAIL_SETUP.md` (Resend real-delivery), `render.yaml`, `backend/.env.example`,
> and `CLAUDE.md` Phase 8–9 / Step 37 (this runbook is the actionable version of Step 37).

---

## 0. Quick live health check

```bash
# Backend up?
curl -s https://tripsplitter-api.onrender.com/api/health        # -> {"status":"ok"}

# Web up?
curl -s -o /dev/null -w "%{http_code}\n" https://tripsplitter-web.vercel.app/   # -> 200

# CORS allows the web origin?  (expect: access-control-allow-origin: *)
curl -s -D - -o /dev/null -X OPTIONS https://tripsplitter-api.onrender.com/api/auth/login \
  -H "Origin: https://tripsplitter-web.vercel.app" \
  -H "Access-Control-Request-Method: POST" | grep -i access-control-allow-origin
```

Render free tier sleeps after inactivity — the first request after idle can take ~30–60s (cold start).

To confirm whether the **web Google client ID** is currently inlined in the live build:

```bash
BUNDLE=$(curl -s https://tripsplitter-web.vercel.app/ | grep -oE '/_expo/static/js/web/[A-Za-z0-9._-]+\.js' | head -1)
curl -s "https://tripsplitter-web.vercel.app$BUNDLE" | grep -c "307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt"
# 0 = Google button hidden on web (env not set);  >0 = wired
```

---

## 1. Render — `APP_URL` (emailed verify/reset links)

If `APP_URL` is blank, the verify-email / reset-password emails carry a **bare token** instead of a
clickable link. Email+PIN login still works regardless, so this is polish — but required for the
self-serve password-reset / email-verification flows to be usable.

1. Render dashboard → **tripsplitter-api** → **Environment**.
2. Set:
   - **Key:** `APP_URL`
   - **Value:** `https://tripsplitter-web.vercel.app`  ← **no trailing slash**
3. **Save Changes** → Render auto-redeploys.
4. **Verify:** trigger "Forgot password?" for a known account. The emailed (or Render-logged, if using
   the Resend test sender) link must read `https://tripsplitter-web.vercel.app/reset-password?token=…`.

*Why it works:* the backend builds links as `{APP_URL}/verify-email?token=` and
`{APP_URL}/reset-password?token=`, and the web app has matching routes
(`frontend/app/verify-email.tsx`, `frontend/app/reset-password.tsx`).

---

## 2. Google sign-in on web

Three changes must **all** be done — they span Google Cloud, Vercel, and Render. Skip any one and web
Google login fails.

### Reference: the OAuth client IDs (public, not secrets)

| Platform | Client ID |
|---|---|
| Web | `307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt.apps.googleusercontent.com` |
| Android | `307368957277-cc4k3o7or765v1g6tfi767stk23296nk.apps.googleusercontent.com` |
| iOS | `307368957277-19ho7nrl2drsdvkahh7nkqpi6f2tag9h.apps.googleusercontent.com` |

### 2a. Google Cloud Console — authorize the Vercel origin

1. [console.cloud.google.com](https://console.cloud.google.com) → **APIs & Services → Credentials**.
2. Open the **OAuth 2.0 Client ID** of type **Web application** (`…-58jdf9opq70e195gm5n1pcf4ucfd7rlt…`).
3. **Authorized JavaScript origins** → add:
   - `https://tripsplitter-web.vercel.app`
   - `http://localhost:8081`  (local `expo start --web`)
4. **Authorized redirect URIs** → add the same two:
   - `https://tripsplitter-web.vercel.app`
   - `http://localhost:8081`
5. **Save** (propagation can take a few minutes).

> If sign-in errors with **`redirect_uri_mismatch`**, the Google error page shows the *exact* URI it
> received. Copy it verbatim into Authorized redirect URIs — expo-auth-session derives the web redirect
> from the page URL, so this is the reliable way to capture any path it appends.

### 2b. Vercel — set the public web client ID

`EXPO_PUBLIC_*` vars are inlined at **build time**, so adding the var requires a **redeploy**.

1. Vercel → **tripsplitter-web** → **Settings → Environment Variables**.
2. Add:
   - **Name:** `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`
   - **Value:** `307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt.apps.googleusercontent.com`
   - **Environments:** ✅ Production ✅ Preview
3. **Redeploy:** Deployments → latest Production → ⋯ → **Redeploy** (or push any commit to `main`).
4. **Verify:** reload `/login` — the "Continue with Google" button now appears. (When the var is unset,
   `GoogleSignInButton` renders `null` — `frontend/src/GoogleSignInButton.tsx:83`.)

CLI alternative (run from `frontend/`):
```bash
echo "307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt.apps.googleusercontent.com" \
  | vercel env add EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID production
# repeat for: ... preview     then redeploy:  vercel --prod
```
> Gotcha: set env values via a tool that doesn't prepend a BOM. A PowerShell pipe once injected a
> UTF-8 BOM that corrupted the inlined URL (caused 405s). Use Git Bash `printf`/`echo` or the dashboard.

### 2c. Render — accept the web client ID as a token audience

The web id_token's `aud` equals the **web** client ID, and the backend only accepts audiences listed
in `GOOGLE_CLIENT_ID` (comma-split — `backend/routes/auth.py:188`). So the web ID **must** be present.

1. Render → **tripsplitter-api** → **Environment** → `GOOGLE_CLIENT_ID`.
2. Set to (web + android):
   ```
   307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt.apps.googleusercontent.com,307368957277-cc4k3o7or765v1g6tfi767stk23296nk.apps.googleusercontent.com
   ```
   Append the iOS ID too if you want native iOS Google login.
3. **Save** → redeploys.

*Symptom if missing:* web Google login 401s with "Could not verify Google token."

### End-to-end check

On the web site → **Continue with Google** → consent → you land on the dashboard (returning user) or
`/set-credentials` (first-time Google user, who then sets a real 4-digit PIN + password).

---

## 3. MongoDB Atlas — no change needed

For `APP_URL` and web Google sign-in, Atlas requires **nothing**:

- Cluster provisioned (M0, AWS Singapore); `MONGO_URL` (SRV) + `DB_NAME=tripsplitter` set on Render.
- **Network Access** allows `0.0.0.0/0` (Render egress IPs aren't static on free tier).
- The `auth_tokens` collection's unique `token_hash` index and TTL index auto-create on backend boot.

Only revisit Atlas if you rotate the DB password (re-URL-encode it in `MONGO_URL`) or lock down network
access to specific egress IPs.

---

## 4. Optional: real email delivery (not in current scope)

Verification/reset emails only reach the **Resend account owner** while `SENDER_EMAIL` is the shared
`onboarding@resend.dev` test sender; everyone else gets a logged link. To deliver to any Gmail address,
verify a sending domain in Resend and point `SENDER_EMAIL` at it. Full steps: **`docs/EMAIL_SETUP.md`**.

---

## 5. Environment variable summary

### Render (`tripsplitter-api` → Environment)

| Key | Value / note |
|---|---|
| `MONGO_URL` | Atlas SRV string (URL-encoded password) — secret |
| `DB_NAME` | `tripsplitter` |
| `JWT_SECRET` | long random string — secret |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_PIN` | seed admin (`@gmail.com`) — secret |
| `APP_URL` | `https://tripsplitter-web.vercel.app` — **§1** |
| `GOOGLE_CLIENT_ID` | comma-separated audiences incl. **web** ID — **§2c** |
| `RESEND_API_KEY` / `SENDER_EMAIL` | email delivery — optional, see §4 |

### Vercel (`tripsplitter-web` → Settings → Environment Variables, Production + Preview)

| Key | Value |
|---|---|
| `EXPO_PUBLIC_BACKEND_URL` | `https://tripsplitter-api.onrender.com` (already set) |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | web client ID — **§2b** |

> Remember: changing any Vercel `EXPO_PUBLIC_*` var requires a **redeploy** (build-time inlining).
