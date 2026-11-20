# Android APK — Build & Install Guide

Updated 20 November 2026. The current public standalone APK is **Splitora 1.0.0, build 28**,
package `com.tripsplitter.app`. It preserves the main-based application flow, approved
gallery-only receipt fixes and existing hosted HTTPS backend. No USB connection is needed.
See the [build-28 release report](releases/android-2026-11-20.md) and [shareable message](releases/ANDROID_APK_SHARE_MESSAGE.md).
Play Console work remains deferred; this APK is separate from the future Play AAB.

## Artifact and configuration boundaries

| Purpose | Package / profile | Backend / status |
| --- | --- | --- |
| Public direct-install APK | `com.tripsplitter.app` / `preview` | Production HTTPS API; published APK 28; current verification linked above |
| Retained local QA APK | `com.tripsplitter.app.qa` / `qaLocal` | `http://127.0.0.1:8000`; APK 27 requires workstation USB/ADB forwarding |
| Future Play submission | `com.tripsplitter.app` / `production` | Production HTTPS API; a fresh `.aab` is pending account, signing and release gates |

All profiles belong to **`frontend/`**, using dynamic `app.config.js` over `app.base.json`
and `frontend/eas.json`. The root Expo/EAS files are obsolete for releases. Keep the current
UI, financial behavior and gallery-only receipt flow; do not enable the QA variant for Play.
`EXPO_PUBLIC_OFFLINE_QA` must be unset/false in production.

The retained launch-preview artifact is **Splitora QA 1.0.0 build 27**, package
`com.tripsplitter.app.qa`. It requires the isolated QA workstation and USB/ADB forwarding.
Its download, exact source/EAS identifiers, checksum, private-account handoff and installed
device results are in the [human-testing release handoff](PLAY_STORE_LAUNCH.md#human-testing-apk-release).
[Download the QA APK](https://tripsplitter-web.vercel.app/download/android-qa).

The QA download was revalidated on 20 November: 307/no-store, 132,316,964 bytes, SHA-256
`30d14421120480ce49077e2d95961bdc4820ce0e49aa105a881801b245394632`.
This APK and historical AAB 20 must not be uploaded as the fresh Play launch bundle.

## Current public APK — build 28

- App: **Splitora 1.0.0, build 28**, `com.tripsplitter.app`.
- Source: `e049db14bf07d2584ed91b3c5df074412b4ba3a2`, branch `codex/android-apk-20261120`; reviewed main baseline `ab97b5a5430650674700d55e5c95f205b93849d8`.
- Stable download: <https://tripsplitter-web.vercel.app/download/android>
- Durable asset: <https://github.com/Jyotirmay-Singh/tripPlanner_basic/releases/download/android-v1.0.0-build.28/splitora-android-1.0.0-build-28.apk>
- EAS build: [`6dcc40a0-19a7-4e7e-9521-4c78b5cf4c80`](https://expo.dev/accounts/jyotirmay03/projects/frontend/builds/6dcc40a0-19a7-4e7e-9521-4c78b5cf4c80), FINISHED.
- Size: 132,271,116 bytes; SHA-256: `2c8678423f4431258db43a7ae45b67b4bd56cc3cc5092ae2b804bd6b3a662d5a`.
- Actual binary checks: package/version/signing continuity, eight permission exclusions, release/HTTPS configuration and 54 ARM64/x86_64 libraries at 16 KB alignment passed.
- Source checks: Expo compatibility, Doctor 17/17, lint, TypeScript, pip check and 44-route web export passed.
- Anonymous full download through the stable 307/no-store link matched size and checksum.
- No new application tests or phone installation were performed. Google sign-in, notifications, external UPI and physical/Android-version acceptance remain unverified.

The older [build-24 report](releases/android-1.0.0-build-24.md) is historical. Its install/upgrade
results do not establish runtime acceptance for build 28. QA build 27 remains separate and
requires USB forwarding. Neither direct APK is a Play submission bundle.

Group invitations and group-code fallbacks include the stable latest-APK link. The redirect
is temporary and revalidated on each request; update it after every verified APK release so previously shared
messages continue to reach the newest public build.

Build 24 previously passed installation/upgrade and navigation on an Android 15 emulator.
Those dated results are retained in its report; they were not repeated for build 28.

---

## 1. How the APK is built (for maintainers)

Use these steps for future releases. Build 28 execution and exact results are recorded above.

- Confirm the clean, reviewed source and its pushed remote revision. The approved readiness
  preview source is `a350d52`, based on main `ab97b5a`; its documentation/download commit is `4ec0a02`.
  The selected current-flow build-28 source is `e049db1`, also based on `ab97b5a`.
  Preserve the reviewed deletion fix and keep `7bbee46` outside the release ancestry.
- EAS owner `jyotirmay03` and pinned CLI **21.4.0** were accessible on 20 November. Recheck
  access, credential ownership, quota and active builds before starting a release. Do not
  start a duplicate build or buy an upgrade as an automatic recovery step.
- `preview` is an internal APK; `production` is an app bundle. Both use remote app versioning
  and auto-increment. Check the final resolved configuration, provider files, HTTPS backend
  and all used/reserved version codes before building. Build 28 incremented the production-package counter from 27 to 28 after checking history.
  Recheck remote and all Console-reserved codes for every subsequent release.
- Complete the required source/dependency/Doctor/type/lint/regression/export checks for the
  final source when release execution is authorized. The launch register's 14 November
  results remain historical; no new check result is claimed here.
- Review the EAS archive: exclude environment files, private handoffs, local native overrides,
  signing material, dependencies and temporary APK/evidence files. Commit and push only the
  reviewed release source before building.

From `frontend/`, using the existing pinned CLI installation and the absolute RTK path:

```powershell
& 'C:\Users\JYOTIRMAY\.headroom\bin\rtk.exe' proxy node C:\Users\JYOTIRMAY\AppData\Roaming\npm\node_modules\eas-cli\bin\run build --platform android --profile preview --non-interactive --wait --json
```

- Reuse the established EAS-managed signing identity. Do not answer a missing-keystore prompt
  by generating/replacing a key without resolving installed-app continuity with the owner.
- Monitor the single EAS build to a terminal state. Accept only `FINISHED` for the expected
  project `0a3b5a1c-5cbd-4eac-bff7-5b53ee4b6948`, source, profile, package, SDK and increased
  version code. After a failure, inspect that build's logs before deciding on another build.
- Download the artifact anonymously and inspect its actual package/version, signing
  certificate, embedded HTTPS address, release/debug state, manifest/inferred permissions,
  ABIs and 16 KB ELF/ZIP alignment. Record checksum and size. Final runtime/provider acceptance
  stays separate from these binary checks.
- Publish a verified direct APK to a durable GitHub release asset, then update only the
  matching temporary download redirect and its source configuration. Verify anonymous full
  download/checksum and homepage availability; preserve the other download path. Play AAB
  upload follows [the Console guide](PLAY_INTERNAL_TESTING.md), not this APK command.

### Gallery-only receipt contract

Attach image opens the system image picker directly in Add/Edit Transaction; keep cancellation,
populated form preservation, crop/upload/view and authorized receipt retrieval behavior.
Android 7–12/API 24–32 uses **Save to folder** through the scoped system folder picker.
Android 13+/API 33+ uses **Save to gallery** through MediaStore. Do not restore the removed
camera/source sheet or API-28 legacy write plugin.

The final manifest and AAPT inferred-permission report must exclude all eight permissions:
`CAMERA`, `RECORD_AUDIO`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`,
`READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` and
`READ_MEDIA_VISUAL_USER_SELECTED` (all under `android.permission`). Build 27 has this binary
evidence and API-35 emulator receipt acceptance. Supported-version native checks remain open.

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

```powershell
& 'C:\Users\JYOTIRMAY\.headroom\bin\rtk.exe' proxy node C:\Users\JYOTIRMAY\AppData\Roaming\npm\node_modules\eas-cli\bin\run credentials -p android
```

Run from `frontend/` and inspect the existing keystore fingerprint; do not generate or replace it.

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

Any local native generation belongs in a disposable checkout. Register its actual debug/release
certificate as a separate Android OAuth entry if needed. For Play-installed builds, follow
[the Console guide](PLAY_INTERNAL_TESTING.md): the Play app-signing SHA-1 is authoritative,
not an assumed upload-key or QA fingerprint. The exact Web audience and production Firebase/EAS
file/credential prerequisites are in [the hosting runbook](GLOBAL_LAUNCH_WIRING.md).

---

## 2. How to install (for testers)

Direct-install instructions for the public standalone APK. No phone installation was performed during this release.
Preserve unresolved local actions and compare package/signing identity before an update.
Never uninstall the production app or clear storage to resolve a QA/signature mismatch.

1. On your Android phone, open the stable download link:
   - `https://tripsplitter-web.vercel.app/download/android`

   This remains a temporary redirect, but its destination is the durable GitHub release asset rather
   than an expiring EAS artifact. Testers keep one URL and the redirected `.apk` downloads anonymously.
2. When the browser/Files app asks, **allow "Install from unknown sources"** for that app
   (Settings → Apps → Special access → Install unknown apps → enable for your browser/Files).
3. Tap the downloaded `.apk` → **Install** → **Open**.
4. Register with a `@gmail.com` address and password, or use Google sign-in and complete password setup.

> The app talks to the live production backend, so your data syncs across devices and with the
> web app at the Vercel URL.

---

## 3. Smoke-test checklist (per build)

Retained acceptance reference, not a new testing assignment. No boxes are completed by the
documentation update. Google/provider, physical-device and remaining Android-version evidence
stays open in the launch register; mandatory Console testing is account-dependent.

- [ ] App launches; icon + splash correct; dark-mode toggle (Profile) works.
- [ ] Register a new Gmail → email-verification link; password login; logout.
- [ ] Google sign-in account selection completes (exact package/SHA registered and backend accepts
      the Web audience); first-time Google user must complete password setup.
- [ ] Create a trip; add expenses in **Per Person / Per Family / Exact** split modes.
- [ ] On Trip Summary, tap a donut slice and a legend row; both open the category breakdown with payer bars, refunds, and transactions.
- [ ] Receipt attachment opens the system gallery directly. Cancel, then select/crop/upload,
      view and save a receipt. Android 7–12 uses Save to folder, Android 13+ uses Save to gallery.
- [ ] Settle-up + record a partial payment; badges/progress update.
- [ ] XLSX and PDF report download open correctly.
