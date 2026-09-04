# Android trip invitation links

Trip Splitter invitations use one HTTPS URL on web and Android:

```text
https://tripsplitter-web.vercel.app/invite/<opaque-token>
```

The backend stores only the token's SHA-256 hash. Links are reusable for seven days, may be created
or revoked only by a trip owner/admin, and retain secret-free audit metadata for 90 days. Manual
six-character codes remain backward compatible.

## User flow

1. An owner/admin taps the trip code or **Members → Invite links → Create and share link**.
2. Android verifies the host through `/.well-known/assetlinks.json`.
3. If the app is installed, the link opens `/invite/<token>` in package `com.tripsplitter.app`, then
   routes an authenticated user directly to the existing identity-aware Join wizard.
4. If the app is absent or the link opens in an embedded browser, the same URL renders the invite
   landing page. It offers **Open Trip Splitter**, the stable `/download/android` APK, and web join.
5. A raw APK cannot restore an install referrer. After installation, the user returns to the invite
   page and taps **Open Trip Splitter**; the token remains in the original link.

## Rollout order

1. Deploy the backward-compatible backend, web route, and Digital Asset Links document while
   `INVITE_LINKS_ENABLED=false`.
2. Build and verify a new EAS `preview` APK signed with the certificate listed in
   `frontend/public/.well-known/assetlinks.json`.
3. Point `/download/android` at that artifact and verify anonymous download.
4. Set `INVITE_BASE_URL=https://tripsplitter-web.vercel.app`, enable invite links, and verify the
   end-to-end flow before announcing it.

The flag doubles as a kill switch. Disabling it stops token creation/resolution without affecting
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
Vercel host working until all seven-day links plus a grace period have elapsed.
