# Splitora 1.0.0 — Android build 24

Source: `4e964ba37a6911bc2f966b068b48c208bb3e9a88` on `codex/android-apk-invite-20261104`.
The saved GPay-style UI branch is separate and is not included.

- Latest APK: <https://tripsplitter-web.vercel.app/download/android>
- Durable APK asset: <https://github.com/Jyotirmay-Singh/tripPlanner_basic/releases/download/android-v1.0.0-build.24/splitora-android-1.0.0-build-24.apk>
- EAS build: [15988520-f034-48ad-b5cb-43089e529c5d](https://expo.dev/accounts/jyotirmay03/projects/frontend/builds/15988520-f034-48ad-b5cb-43089e529c5d)
- Expo artifact: <https://expo.dev/artifacts/eas/KBvrqdTbKBtBqcnnF8U15K4NJLQqVtnBuh4PVNam3cU.apk>
- App: **Splitora**; package `com.tripsplitter.app`; version 1.0.0; version code 24
- Android minimum API 24; target API 36; Expo SDK 54
- Size: 132,270,264 bytes
- SHA-256: `039332ef1229df83e0371cac439c0393c50609badd842c7a8f68876d36e56f4b`
- Signing certificate SHA-256: `fd894bfbeae599d7345c40dae91380cfc15dae6d4d58b5189d681881fa4fd91c` (matches the existing release)

## Invitation sharing

Group invitation messages and group-code fallbacks include the stable latest-APK link.
The invitation landing page also offers **Download latest Android APK**. The temporary
download redirect uses `Cache-Control: public, max-age=0, must-revalidate`, so new releases can update
the destination for both new and previously shared invitations.

## Verification

1,269 frontend tests passed across 143 suites;
18 service-dependent frontend tests were skipped. 1,085
offline backend tests passed. TypeScript, tracked-source ESLint, frozen dependencies,
Expo dependency compatibility, all 16 Expo Doctor checks, the production web export,
and the backend dependency compatibility check passed. The public homepage and Render
health endpoint returned HTTP 200 before release.

The APK was downloaded anonymously, its package/version/app label were checked, its
signature matched the existing release key, and 16 KB ZIP alignment passed.
The isolated Android 15 emulator passed an update from build 22 with app-data
marker retention, fresh installation, cold launch, restart, light/dark/320dp sign-in screens,
registration navigation, and HTTPS invitation routing. No native application crash was found.

## Limits

No physical phone, real Google/password sign-in, authenticated trip navigation, or
authenticated offline-queue upgrade was exercised. Vercel account-level environment/log
inspection was unavailable; publication uses the existing Git integration and public HTTP verification.
