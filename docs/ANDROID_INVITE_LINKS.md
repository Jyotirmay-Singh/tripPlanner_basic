# Android trip invitation links

Trip Splitter invitations use one HTTPS URL on web and Android:

```text
https://tripsplitter-web.vercel.app/invite/<opaque-token>
```

The backend derives one URL-safe, HMAC-signed token from the trip id and its invite generation, so
the raw bearer token is never stored. Every linked member receives the same link. Owners/admins can
reset it by advancing the generation, which invalidates the previous link immediately. Manual
six-character codes remain backward compatible, and retired invite records remain internal until
their existing 90-day audit window ends.

## User flow

1. A trip member taps the trip code to share, or uses **Members → Trip invite link** to copy or share
   the same link.
2. Android verifies the host through `/.well-known/assetlinks.json`.
3. If the app is installed, the link opens `/invite/<token>` in package `com.tripsplitter.app`, then
   routes an authenticated user directly to the existing identity-aware Join wizard.
4. If the app is absent or the link opens in an embedded browser, the same URL renders the invite
   landing page. Android browsers stay there with **Open Trip Splitter**, **Download Android APK**,
   and **Continue on web** controls; no APK download starts automatically. Signed-in desktop and iOS
   web users proceed directly to the join preview, while signed-out users return there after auth.
5. A raw APK has no Play Store install-referrer/deferred-deep-link handoff. After installation, the
   user returns to WhatsApp and taps the original invitation again; the HTTPS App Link carries the
   token into the joining page.
6. The join preview sends an existing member to `/trip/<id>` Summary and shows the existing Join Trip
   identity flow to a non-member. Invalid, reset, disabled, and offline links retain dedicated
   handling.

The share message includes the private URL, permanent trip code, Android-only download link, and a
note that a trip admin can reset the private link at any time.

## Rollout order

1. Publish the already-verified build 8 APK as durable GitHub release
   `android-v1.0.0-build.8`; do not rebuild it for this rollout.
2. Point the temporary `/download/android` redirect at that durable release asset and verify the
   anonymous download, package/version, checksum, and signing certificate.
3. Deploy this web flow and verify the invite landing page plus Digital Asset Links document.
4. Confirm `INVITE_BASE_URL=https://tripsplitter-web.vercel.app`, set
   `INVITE_LINKS_ENABLED=true`, and verify `/api/meta/config` plus member/non-member flows.

The flag doubles as a kill switch. Disabling it stops link retrieval/resolution without affecting
manual codes or already-joined members.

## Verification

```powershell
adb shell pm get-app-links com.tripsplitter.app
adb shell am start -W -a android.intent.action.VIEW -d "https://tripsplitter-web.vercel.app/invite/<test-token>" com.tripsplitter.app
```

Also verify that `/.well-known/assetlinks.json` returns JSON without a redirect, its fingerprint
matches the certificate on the final APK, an absent app reaches the landing page, and
`/download/android` returns a temporary redirect to the verified APK.

## Branded-domain migration

Add the future company-controlled host to the Android intent filters, publish matching
`assetlinks.json` on both hosts, and release that APK before changing `INVITE_BASE_URL`. Keep the
Vercel host working until all active app versions support the new host.
