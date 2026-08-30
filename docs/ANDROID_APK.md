# Android APK — Build & Install Guide

A standalone, side-loadable Android `.apk` of Trip Splitter, built with **EAS Build** and
pointed at the production backend (`https://tripsplitter-api.onrender.com`). This is an
additive artifact — it does not affect the Vercel web deploy or the Render backend.

App: **Trip Splitter** · package `com.tripsplitter.app` · version `1.0.0`
(the `versionCode` is auto-incremented by EAS — `eas.json` `appVersionSource: "remote"`).

---

## 1. How the APK is built (for maintainers)

Prereqs (already satisfied in this repo):
- `eas` CLI installed and logged in as an account with access to owner **`jyotirmay03`**
  (`eas whoami`).
- EAS profile **`preview`** in `frontend/eas.json` → `buildType: "apk"`,
  `distribution: "internal"`, with the prod backend URL + Google Web/iOS client IDs
  in its `env` block. (The `production` profile builds an `.aab` app bundle — do not use it
  for a side-loadable APK.)

Build:

```bash
cd frontend
eas build --platform android --profile preview
```

- First build prompts **"Generate a new Android Keystore?" → Yes** (EAS-managed release
  keystore; nothing is stored in the repo).
- The build queues on EAS Build, then prints a build page URL. Download the `.apk` from that
  page, or later via `eas build:list` → open the latest → **Download**.

### Google Sign-In on the release APK (one-time per signing certificate)

Android uses Credential Manager through `react-native-nitro-google-signin`. The app passes the
**Web application OAuth client ID** as `webClientId`, receives a Web-audience ID token, and sends
only that token to `POST /api/auth/google`. Separately, Google authorizes the installed APK through
an **Android OAuth client** matching both:

- Package: `com.tripsplitter.app`
- SHA-1: the certificate that signed the APK actually installed on the device

There is **no Android OAuth redirect URI** to register. Do not add
`com.tripsplitter.app:/oauthredirect`, a wildcard redirect, or a client secret.

For the EAS preview APK, obtain/confirm the signing fingerprint with:

```bash
cd frontend
eas credentials -p android   # Android → Keystore → show SHA-1 fingerprint
```

Then, in the same Google Cloud project as the Web client, create or verify an **Android** OAuth
client for the exact package/SHA-1 pair. Google Cloud represents each package/certificate pair as
its own Android client entry; do not replace the Web client or use the Android client ID as
`webClientId`. Allow a few minutes for propagation.

Also verify the production Render service's `GOOGLE_CLIENT_ID` accepted-audience list includes the
same Web client ID used by `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`. It may also retain the iOS audience
and a legacy Android audience during rollout. No client secret belongs in Render or the APK.

**Release signing SHA-1 (EAS-managed keystore `S8Y4Kot8TG`; a signing fingerprint is public,
not a secret):**

```
SHA-1:   B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B
SHA-256: FD:89:4B:FB:EA:E5:99:D7:34:5C:40:DA:E9:13:80:CF:C1:5D:AE:6D:4D:58:B5:18:9D:68:18:81:FA:4F:D9:1C
```

This is the SHA-1 for APKs signed directly with the current EAS-managed key. It stays constant
while that keystore is reused. It is **not** automatically the debug certificate, a different CI
release certificate, or Google Play's app-signing certificate.

For a local native build, generate Android files only in a disposable checkout/directory, then run:

```bash
npx expo prebuild --platform android
cd android
./gradlew signingReport       # macOS/Linux
# .\gradlew signingReport    # Windows PowerShell
```

Register the `debug` SHA-1 for debug APKs and the relevant `release` SHA-1 for locally/CI-signed
release APKs as separate Android OAuth client entries. For Play-installed builds, follow
`docs/PLAY_INTERNAL_TESTING.md`: the Play App Signing SHA-1 is authoritative, not the upload-key
SHA-1.

---

## 2. How to install (for testers)

1. On your Android phone, open the stable download link:
   - `https://tripsplitter-web.vercel.app/download/android`

   This temporary redirect is refreshed after each verified EAS build, so testers do not need a
   new URL when an Expo artifact changes or expires. The redirected `.apk` downloads anonymously.
2. When the browser/Files app asks, **allow "Install from unknown sources"** for that app
   (Settings → Apps → Special access → Install unknown apps → enable for your browser/Files).
3. Tap the downloaded `.apk` → **Install** → **Open**.
4. Register with a `@gmail.com` address and password, or use Google sign-in and complete password setup.

> The app talks to the live production backend, so your data syncs across devices and with the
> web app at the Vercel URL.

---

## 3. Smoke-test checklist (per build)

- [ ] App launches; icon + splash correct; dark-mode toggle (Profile) works.
- [ ] Register a new Gmail → email-verification link; password login; logout.
- [ ] Google sign-in account selection completes (exact package/SHA registered and backend accepts
      the Web audience); first-time Google user must complete password setup.
- [ ] Create a trip; add expenses in **Per Person / Per Family / Exact** split modes.
- [ ] On Trip Summary, tap a donut slice and a legend row; both open the category breakdown with payer bars, refunds, and transactions.
- [ ] Receipt capture (camera) + upload from gallery; view receipt.
- [ ] Settle-up + record a partial payment; badges/progress update.
- [ ] XLSX and PDF report download open correctly.
