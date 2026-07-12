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
  `distribution: "internal"`, with the prod backend URL + Google web/android client IDs
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

### Google Sign-In on the release APK (one-time)

`expo-auth-session` validates Android sign-in by **package name + signing-cert SHA-1**, so the
EAS release keystore's SHA-1 must be registered:

```bash
eas credentials         # → Android → Keystore → show SHA-1 fingerprint
```

Then in **Google Cloud Console → APIs & Services → Credentials → the Android OAuth client**
(package `com.tripsplitter.app`) add that SHA-1. Allow a few minutes for propagation. Until
this is done, the "Continue with Google" button appears but sign-in fails; **email + PIN
login works regardless**.

**Release signing SHA-1 (EAS-managed keystore `S8Y4Kot8TG`; a signing fingerprint is public,
not a secret):**

```
SHA-1:   B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B
SHA-256: FD:89:4B:FB:EA:E5:99:D7:34:5C:40:DA:E9:13:80:CF:C1:5D:AE:6D:4D:58:B5:18:9D:68:18:81:FA:4F:D9:1C
```

This is the value to enter in the Android OAuth client. It stays constant across future
`preview` builds as long as the same EAS keystore is used, so this step is one-time.

---

## 2. How to install (for testers)

1. On your Android phone, open the **install page** (QR + Install button) or the **direct
   `.apk`** link:
   <!-- Latest build: 2026-07-13, profile `preview`, com.tripsplitter.app, v1.0.0 (versionCode 1) -->
   - Install page: `https://expo.dev/accounts/jyotirmay03/projects/frontend/builds/aa22fda8-b4ea-45a7-8fc3-6fd8e6d9dca8`
   - Direct APK: `https://expo.dev/artifacts/eas/nleiz_H81CvsMrxLpwXibQyymaKtiieGeZ9VM9h4wPo.apk`
2. When the browser/Files app asks, **allow "Install from unknown sources"** for that app
   (Settings → Apps → Special access → Install unknown apps → enable for your browser/Files).
3. Tap the downloaded `.apk` → **Install** → **Open**.
4. Register with a `@gmail.com` address (or use Google sign-in), set your PIN, and go.

> The app talks to the live production backend, so your data syncs across devices and with the
> web app at the Vercel URL.

---

## 3. Smoke-test checklist (per build)

- [ ] App launches; icon + splash correct; dark-mode toggle (Profile) works.
- [ ] Register a new gmail → email-verification link; PIN login; logout.
- [ ] Google sign-in (needs SHA-1 registered); first-time Google user lands on set-credentials.
- [ ] Create a trip; add expenses in **Per Person / Per Family / Exact** split modes.
- [ ] Receipt capture (camera) + upload from gallery; view receipt.
- [ ] Settle-up + record a partial payment; badges/progress update.
- [ ] XLSX and PDF report download open correctly.
