# Splitora 1.0.0 — Android build 23

Status: **prepared; publication and production deployment await approval**. The production stable link still serves the prior build until rollout.

- Source: `54b2c7eebee1e9a36b7ddb99a6d70119da864c8d`
- EAS build: [29f121b3-e48f-4ada-ab85-62b3deedca46](https://expo.dev/accounts/jyotirmay03/projects/frontend/builds/29f121b3-e48f-4ada-ab85-62b3deedca46)
- APK: `splitora-android-1.0.0-build-23.apk`
- App label: **Splitora**
- Package: `com.tripsplitter.app`; version 1.0.0; version code 23
- Size: 131,181,884 bytes
- SHA-256: `66d2bab153ef617b985b2f42c0348df0de1051e2352e23147ff2a45eee9a7a9f`
- Signing certificate SHA-256: `fd894bfbeae599d7345c40dae91380cfc15dae6d4d58b5189d681881fa4fd91c` (matches the previous release)

## Verification

Validation: 1,252 frontend tests, 70 affected QA tests, 1,086 offline backend tests, both type checks, lint, frozen dependencies, all 17 Expo Doctor checks, and production web export passed. APK package/name/signature and 16 KB ZIP alignment passed. Isolated Android 15 emulator: upgrade from build 22 with app-data marker retention, fresh install, cold launch/restart, light/dark/320dp login, and legacy-scheme registration navigation passed.

No physical phone, real Google/password sign-in, or authenticated offline-queue upgrade was exercised. Existing external store/OAuth/provider console branding remains unverified.

## Rollout order

Publish the verified draft release and confirm its APK downloads anonymously. Then merge [PR #73](https://github.com/Jyotirmay-Singh/tripPlanner_basic/pull/73), which deploys the backend/web rename and the temporary download redirect together. Verify the stable download checksum, homepage title, invitation privacy headers/app links, backend health, and API documentation title.

Planned asset: https://github.com/Jyotirmay-Singh/tripPlanner_basic/releases/download/android-v1.0.0-build.23/splitora-android-1.0.0-build-23.apk
Stable endpoint: https://tripsplitter-web.vercel.app/download/android

Automatic approval review rejected a direct push to main because it can trigger production deployment. No production changes are claimed.
