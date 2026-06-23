# Email Setup — Resend Sender Modes & Enabling Real Delivery

This app sends two kinds of transactional email: the **verify-your-email** link on registration and
the **reset-your-password** link. Both go through Resend (`backend/utils/emailer.py`). This doc
explains why test emails often don't arrive, how the app decides whether to actually send, and the
exact **USER ACTION** steps to enable real delivery to any Gmail address.

> No code change is required to switch to real delivery — it's all environment variables.

---

## 1. Why your test emails don't arrive

By default `SENDER_EMAIL` is **`onboarding@resend.dev`**, Resend's shared test sender. Resend only
delivers messages from that test address to **the inbox of the Resend account owner** (the email you
signed up to Resend with). Every **other** recipient gets nothing in their inbox — instead the app
logs the link so the flow still works for testing.

So if you register/reset with an address that isn't your Resend account owner, **this is expected, not
a bug.** Look in the backend log for a line like:

```
2026-06-23 17:44:11 INFO [EMAIL] to=someone@gmail.com subject='Verify your Trip Splitter email' link=https://.../verify-email?token=...
```

Open that `link=` URL directly and the flow completes normally.

---

## 2. How the app decides: send vs. log

On startup the backend logs **one secret-free line** stating the active mode (it never prints the API
key or any token). You'll see exactly one of:

| Startup log line | What's happening | Driven by |
|---|---|---|
| `EMAIL: no RESEND_API_KEY configured — verification/reset links are only LOGGED …` | Nothing is emailed at all; links only appear in the log. | `RESEND_API_KEY` empty/unset |
| `EMAIL: Resend test sender (onboarding@resend.dev) — delivers ONLY to the Resend account owner's inbox; all other recipients fall back to logged links` | Real send is attempted, but only the account owner actually receives it. | key set **and** `SENDER_EMAIL=onboarding@resend.dev` |
| `EMAIL: live sender <addr> — delivering to all recipients` | Real delivery to everyone. | key set **and** a verified-domain `SENDER_EMAIL` |

The relevant env vars (`backend/config.py`): `RESEND_API_KEY`, `SENDER_EMAIL` (default
`onboarding@resend.dev`), `APP_URL` (base for the emailed link). In every mode the link is **also**
logged as `[EMAIL] … link=…`, so flows are always testable. (Lower the log level to `DEBUG` to also see
a per-send line showing whether each message dispatched or only logged.)

---

## 3. USER ACTION — enable real delivery to any Gmail

Do this once to move from the test sender to live delivery. **No code change needed.**

1. **Add a domain in Resend.** Go to <https://resend.com/domains> → **Add Domain** and enter a domain
   you own (e.g. `tripsplitter.com`). You must own/control the domain's DNS — you can't verify
   `gmail.com` or `resend.dev`.
2. **Add the DNS records Resend shows you** at your domain registrar / DNS host (Cloudflare,
   Namecheap, GoDaddy, etc.):
   - **SPF** (a `TXT` record) and **DKIM** (one or more `TXT`/`CNAME` records) — required.
   - **DMARC** (a `TXT` record at `_dmarc`) — recommended for deliverability.
   Copy the host/value pairs exactly as Resend displays them.
3. **Wait for verification.** DNS can take minutes to a few hours to propagate. Refresh the Resend
   domains page until the domain status flips to **Verified**.
4. **Point the app at the verified domain.** Set `SENDER_EMAIL` to an address **on that domain**
   (e.g. `no-reply@tripsplitter.com`) and make sure `RESEND_API_KEY` is set, in **both** places:
   - **Render** (production): Service → **Environment** → add/update `SENDER_EMAIL` and
     `RESEND_API_KEY`. Also confirm `APP_URL` points at your web origin
     (e.g. `https://tripsplitter-web.vercel.app`) so the emailed links resolve.
   - **Local** (`backend/.env`): set the same `SENDER_EMAIL` / `RESEND_API_KEY` for local testing.
5. **Redeploy / restart and confirm.** After Render redeploys (or you restart `uvicorn` locally),
   check the startup log reads:
   ```
   EMAIL: live sender no-reply@tripsplitter.com — delivering to all recipients
   ```
   Then trigger a registration or password reset to a normal Gmail and confirm it lands in the inbox.

---

## 4. Free-tier limits

Resend's free plan allows roughly **100 emails/day** and **3,000 emails/month**, with **one** verified
custom domain. That's ample for testing and light production. See <https://resend.com/pricing> for
current limits.

---

## 5. Troubleshooting

- **Domain stuck "Not Started" / "Pending" in Resend** — DNS hasn't propagated or a record is wrong.
  Re-check that each host/value matches Resend exactly (watch for a trailing-dot or an auto-appended
  domain suffix your DNS host adds to the host field). Give it more time, then refresh.
- **Startup still logs `test sender` after you set a domain** — `SENDER_EMAIL` is still
  `onboarding@resend.dev` (or wasn't picked up). Confirm the env var is set in the environment that's
  actually running (Render service vs. local shell vs. `backend/.env`) and restart.
- **Startup logs `no RESEND_API_KEY configured`** — the key isn't set in the running environment. Set
  `RESEND_API_KEY` and restart.
- **Send fails after going live** — the app logs `Resend send failed: <reason>` (WARNING) and never
  crashes the request; the link is still logged. Common causes: sending from an address not on the
  verified domain, or hitting the daily/monthly quota.
- **Links point to the wrong host** — set `APP_URL` to your web origin; otherwise the emailer falls
  back to emitting the bare token instead of a full URL.
