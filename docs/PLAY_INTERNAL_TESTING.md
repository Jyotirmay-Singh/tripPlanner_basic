# Splitora: Google Play internal testing

Updated 14 November 2026. The shared release and owner register is
[PLAY_STORE_LAUNCH.md](PLAY_STORE_LAUNCH.md). **Play Console work is deferred** until
the account holder supplies access. No account has been supplied or verified in this task.
Use this guide when that milestone resumes; do not upload the historical bundle below.

## Release and account decisions

- Launch scope: India, free, ad-free, ages 13+ with group chat and teen safeguards.
- Support: teamsplitora@gmail.com.
- Android package: `com.tripsplitter.app`. Build from `frontend/` using the canonical
  `production` profile, dynamic `app.config.js` and `app.base.json`.
- Approved source: `main` at `ed26aee5dbb69f94f004d13242e2102ca546e5df`, the reviewed
  local group-deletion confirmation fix, then reviewed launch-readiness changes.
- The saved GPay-style branch `codex/gpay-ui-saved-20261014` was deleted locally.
  Exclude its code from the release.
- Start with manual Console upload. EAS Submit and its service account are optional later.

## 1. Confirm the publisher before creating or reusing an app

Owner: account holder. Record account type, exact creation date, identity/contact/device
verification and the app-specific production-access state. Record an existing app's
name, URL and package if one exists. Reuse its registration only after checking ownership
and signing continuity. An EAS project or a historical AAB does not prove that a Play app exists.

Choose personal versus organization using the actual publisher and Google rules.
Expense management and external UPI handoff require financial-feature assessment; do not
automatically choose a personal account. Some financial-service categories require an
organization account. Resolve applicability with the account holder and Play support where needed.
Enrollment has a one-time US$25 fee; follow the current Console verification steps.

For a **personal account created after 13 November 2023**, production access requires a
closed test with **at least 12 testers continuously opted in for the preceding 14 days**,
followed by an application for production access. Internal testing is a separate track
supporting up to 100 testers and does not satisfy that closed-test requirement.
Confirm eligibility in the actual app dashboard. Account verification and production access
are different gates.

[Account types](https://support.google.com/googleplay/android-developer/answer/13634885?hl=en)
· [Testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)

## 2. Prepare a fresh, signed release bundle

Owner: release engineer, after independent readiness and signing gates pass.

1. Confirm the approved source, local-change disposition and current-brand UI. Record the
   exact commit and clean release build input.
2. Check all Play/EAS used or reserved version codes. The next code must exceed all of them;
   a cancelled build may have reserved a code. EAS remote auto-increment alone is not evidence
   that the code exceeds every Console upload.
3. Build from `frontend/` with `eas build --platform android --profile production` when authorized.
   Verify the production API and public OAuth identifiers without copying secret values into logs.
4. Record the EAS build ID, source revision, artifact checksum/size, package, version code,
   target API, permissions, signing certificates and 16 KB compatibility evidence.
5. Validate API 36 targeting and native 16 KB support in the actual AAB and its generated APKs.
   Include a 16 KB runtime check in device acceptance. An old APK's checks do not validate new code.
   Receipt attachment is gallery-only. Verify that camera, microphone and broad media-read
   permissions are absent, and that attaching an image opens the system picker directly.

Historical evidence, retained for traceability:

| Artifact | Historical record | Use |
| --- | --- | --- |
| Public APK 24 | Source `4e964ba37a6911bc2f966b068b48c208bb3e9a88`; EAS `15988520-f034-48ad-b5cb-43089e529c5d` | Previous direct-download release |
| Build 25 | Cancelled; source `f821a4f91c2c56c8dcc280e70575c1892696f73a` | Check whether its code was reserved |
| AAB 20 | Source `dd7590c98e5ccf3c9c625d39b726b882049cb14d`; EAS `1e2db35f-94a3-486b-9014-92e22d4ae912` | Historical bundle, **not the launch candidate** |

Historical AAB file: `.release-tmp/android-release-20261005/trip-splitter-android-1.0.0-build-20.aab`;
94,135,799 bytes; SHA-256
`d37a2369ff95551465a0ddc3ad7a60f106550de3393c2c162d7be1a21147d5ec`.
Its recorded bundletool, signature, production configuration and native-alignment checks
remain historical evidence. Current source/device acceptance is recorded in the shared handoff.

## 3. Establish signing and installed-app continuity

Owner: account holder + release engineer. Complete before choosing Play's app-signing key.

- Compare the existing direct APK certificate, EAS upload certificate and any existing Play
  app-signing certificate. An unrelated Google-generated key can prevent an existing APK
  installation from upgrading to the Play version. Choose the signing approach deliberately;
  document any reinstall/export/recovery consequence before rollout.
- Play App Signing is required for new apps. The upload key signs the submitted bundle;
  the app-signing key signs the APKs users install. They can be different.
- Register an Android Google OAuth client for the exact package and **Play app-signing SHA-1**
  in the intended Google Cloud project. Retain the direct APK's certificate registration as needed.
  Android uses Credential Manager and the configured Web client as ID-token audience.
- Keep that Web client in the backend's accepted `GOOGLE_CLIENT_ID` audiences. Do not embed
  an OAuth client secret or use an Android client ID as `webClientId`.
- Register the **Play app-signing SHA-256** in the site's Android App Links association file.
  Test HTTPS invitations on a real Play-installed build.

Previously recorded EAS upload-key SHA-1, to be reverified:
`B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B`.

[Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
· [Expo Android submission](https://docs.expo.dev/submit/android/)

## 4. Complete applicable app-content declarations

Owner: account holder + product owner. Follow the requirements shown for the chosen track;
closed/production release needs the full applicable declarations.

| Item | Required assessment |
| --- | --- |
| Public privacy policy | Public HTTPS `/privacy`, accessible without login; identify the operator and contact and describe actual collection, processing, sharing, security, retention and deletion |
| Account deletion | In-app deletion plus public `/account-deletion` request pathway usable after uninstall; explain retained shared financial records, names, receipts and chat |
| App access | Reusable reviewer credentials and instructions that satisfy terms/age gates, email verification and any guardian checks; synthetic groups/data; no inaccessible OTP or expired links |
| Ads and pricing | No ads, free; verify final SDKs and configuration |
| Audience | Intended age groups 13–15, 16–17 and 18+; apply local child definitions, consent, social-feature safeguards and applicable Families requirements |
| Content rating | Complete IARC honestly, including chat/user interaction; do not assume an Everyone rating |
| Data safety | Inventory accounts/contact data, financial records, photos, messages, device/push IDs, safety/guardian records and diagnostics; verify provider processing and collected/shared definitions |
| Financial features | Assess expense management under **Other** and UPI handoff under **Payments/transfers**, against Google's current definitions; resolve any organization-account implication |
| Government apps | Answer independently using the actual operator and service; do not combine this with financial answers |
| Countries | India for the approved launch; confirm testing-track country behavior and final production distribution separately |

All developers must answer the financial-features declaration for applicable published tracks;
“the app does not hold money” is insufficient grounds to answer no financial features.
**Internal-only apps have a Data safety form exemption**; that does not remove privacy, security
or later closed/production obligations. Keep the draft inventory ready and complete the form
before a track requiring it. The public policy routes exist in source; verify their live HTTPS
URLs after a separately authorized deployment.

[Financial features](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en)
· [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
· [Account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
· [UGC safeguards](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)
· [Audience](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en)

## 5. Upload and exercise internal testing

Owner: account holder + tester coordinator, after access is supplied.

1. Open Testing → Internal testing → Create release. Upload the newly verified AAB and
   provide accurate release notes. Resolve the Console's applicable requirements.
2. Configure an email list or Google Group, up to 100 testers. Splitora itself requires Gmail
   identities even though Play tester eligibility uses Google accounts.
3. Save the tester configuration and obtain the opt-in URL. Share it only through an
   authorized communication step. Testers opt in and install using the same Google account.
4. Allow for processing, availability propagation and any applicable review. **Do not promise
   instant availability or no review delay**, particularly for an app's first release.
5. Verify the actual Play-installed package: Google/password sign-in, account recovery,
   invitations, push, upgrade recovery, core financial flows, receipts/permissions, exports,
   community terms, teen controls, report/block/moderation, deletion and offline account isolation.
6. Record build/version, device/Android version, steps, results and feedback. Resolve all
   release-blocking issues before qualifying closed testing or production submission.

[Testing tracks](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)

## 6. Resume production milestones

Run the qualifying closed test where required, collect engagement and feedback evidence,
apply for and obtain production access, secure release review, publish to India and complete
72 hours of support/moderation/vitals observation. Use milestone scheduling; neither a 14-day
test nor internal-track availability guarantees a publication date. Recovery releases need
higher version codes. Record all owners and evidence in the shared handoff.
