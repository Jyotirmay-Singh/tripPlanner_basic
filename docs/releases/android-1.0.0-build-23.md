# Splitora 1.0.0 — Android build 23

Status: **verified historical candidate; superseded by the S/T logo revision**. This APK contains
the earlier T/S symbol. Preserve its verification record and artifact, and build a new APK for
the current logo before publication. The production stable link continues to serve the prior release.

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

Rebuild and verify an APK from the updated S/T logo source before publishing the latest design.
Publish that replacement artifact and verify its anonymous download, then update the stable
redirect and promote [PR #73](https://github.com/Jyotirmay-Singh/tripPlanner_basic/pull/73).
Build 23 must not be published as the current-logo release.

Superseded draft asset: `splitora-android-1.0.0-build-23.apk`
Stable endpoint: https://tripsplitter-web.vercel.app/download/android

Automatic approval review rejected a direct push to main because it can trigger production deployment. No production changes are claimed.
