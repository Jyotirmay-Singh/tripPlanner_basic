# Splitora: Google Play internal testing

Later direct-APK update: [build 28](releases/android-2026-11-20.md) is published with the
existing HTTPS backend and current main-based flow. Its binary/public-download checks do
not complete the future safety/provider, device or Play gates described below. The earlier
documentation-only scope statements refer to the preceding handoff milestone.

Updated 20 November 2026. The shared release and owner register is
[PLAY_STORE_LAUNCH.md](PLAY_STORE_LAUNCH.md). **Play Console work is deferred** until
the account holder supplies access. The owner reconfirmed that no developer account exists.
The current milestone prepares documentation only; no app tests, QA setup, builds, uploads,
deployments or provider changes are requested. The sequence below is for future publication.
Use the [submission pack](PLAY_STORE_SUBMISSION_PACK.md) for listing/declaration drafts and
private reviewer-access preparation. Do not upload the historical bundle below.

## Release and account decisions

- Launch scope: India, free, ad-free, ages 13+ with group chat and teen safeguards.
- Support: teamsplitora@gmail.com.
- Android package: `com.tripsplitter.app`. Build from `frontend/` using the canonical
  `production` profile, dynamic `app.config.js` and `app.base.json`.
- Approved baseline: `main` at `ab97b5a5430650674700d55e5c95f205b93849d8`, including the
  reviewed group-deletion restriction. The reviewed case-insensitive confirmation and
  gallery-only readiness source is `a350d52555f3064aa5366e7aabc49de88b001a5c` on
  `codex/splitora-launch-preview`; existing documentation/download commit is `4ec0a02`.
- The saved GPay-style branch `codex/gpay-ui-saved-20261014` was deleted locally.
  Exclude its code from the release.
- Start with manual Console upload. EAS Submit and its service account are optional later.

At the 20 November inspection, production backend `ef2b25047745` had no Community safety
paths, and production web was at `ab97b5a`. Policies and safety exist in the reviewed source;
their production deployment and operator acceptance remain pending. QA build 27 is a different
package with a loopback backend and cannot be substituted for a production Play bundle.

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

## 2. Approve operations, signing and providers

Owner: account holder + product owner + release engineer. Complete before the first upload.

- Name primary/backup support and moderation coverage, approve the retained shared-record
  deletion/redaction process and accept the [community operating procedure](COMMUNITY_OPERATIONS.md).
  For the approved ages-13+ audience, record the qualified India review and approved adult/
  guardian verification, consent/withdrawal and restricted evidence-handling process.
- Compare the existing direct APK certificate, EAS upload certificate and the chosen Play
  app-signing certificate. Preserve existing-install upgrade continuity; document recovery
  consequences before accepting an unrelated key. Review the current Console defaults,
  including quantum-ready/hybrid signing, before the first bundle upload. Do not automatically
  accept Google-generated replacement identities or promise that an upload certificate is
  the certificate installed by Play.
- Play App Signing is required for new apps. The upload key signs the submitted bundle;
  the app-signing key signs installed APKs. Resolve the supported existing-key/import choice
  with the owner before upload and keep all private signing material outside Git and chat.
- Register the exact `com.tripsplitter.app` / **Play app-signing SHA-1** Android OAuth pair
  in the intended Google Cloud project. Retain the direct APK certificate registration as
  needed. Android Credential Manager uses the configured Web client as ID-token audience;
  keep that audience in backend `GOOGLE_CLIENT_ID`. No Android redirect URI or client secret
  belongs in this flow.
- Register the **Play app-signing SHA-256** for Android App Links. Follow the
  [hosting runbook](GLOBAL_LAUNCH_WIRING.md) for the production Firebase Android app,
  `GOOGLE_SERVICES_JSON` EAS file variable, matching FCM v1 credential and Expo security
  configuration. Configuration is separate from provider acceptance, which remains open.

Previously recorded direct EAS signing SHA-1, to reconcile against the final artifact:
`B2:31:10:17:07:88:61:8B:0E:E7:15:32:81:D6:33:4E:62:53:7C:8B`.
This is not the build-27 QA signer and is not yet a verified Play app-signing certificate.

[Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
· [Expo Android submission](https://docs.expo.dev/submit/android/)

## 3. Coordinate the production release and prepare a fresh bundle

Owner: release engineer, after independent readiness and signing gates pass.

1. Prepare the reviewed main integration and coordinated backend/web/native delivery. Main
   is linked to production: do not merge or push readiness code as a documentation side effect.
   Have working public policy, terms-review and app-update routes for existing APK-24 users
   before mandatory review enforcement; avoid a backend-only lockout. Retain compatible
   previous revisions and database recovery records in the private release handoff.
2. Confirm the approved source, excluded-commit ancestry, unrelated-change disposition and
   current-brand UI. Record the exact clean source, required checks and committed/pushed
   remote revision. Existing 14 November results do not become a new final-source run.
3. Check all Play/EAS used or reserved version codes. The next code must exceed all of them;
   a cancelled build may have reserved a code. EAS remote auto-increment alone is not evidence
   that the code exceeds every Console upload. QA remote counter 27 was observed on 20 November;
   re-read the production counter and Console state rather than hard-coding a code here.
4. Resolve the canonical production configuration from `frontend/`: production HTTPS API,
   package `com.tripsplitter.app`, SDK 54, app-bundle profile, remote auto-increment and correct
   Google/Firebase configuration. `EXPO_PUBLIC_OFFLINE_QA` must be unset/false. Build with the
   pinned CLI only when release execution is authorized; monitor one build to `FINISHED` and
   reject mismatched source, project, profile, package or version.
5. Record the EAS build ID, source revision, artifact checksum/size, package, version code,
   target API, permissions, signing certificates and 16 KB compatibility evidence.
6. Validate API 36 targeting and native 16 KB support in the actual AAB and its generated APKs.
   Include a 16 KB runtime check in device acceptance. An old APK's checks do not validate new code.
   Preserve direct system-gallery attachment and [all eight permission exclusions](ANDROID_APK.md#gallery-only-receipt-contract),
   including external-storage write. Save to folder applies to Android 7–12 and Save to gallery
   to Android 13+. No new runtime checks are scheduled by this documentation milestone.

Future command, from `frontend/`, using the existing pinned EAS CLI 21.4.0 installation:

```powershell
& 'C:\Users\JYOTIRMAY\.headroom\bin\rtk.exe' proxy node C:\Users\JYOTIRMAY\AppData\Roaming\npm\node_modules\eas-cli\bin\run build --platform android --profile production --non-interactive --wait --json
```

Historical evidence, retained for traceability:

| Artifact | Historical record | Use |
| --- | --- | --- |
| Public APK 24 | Source `4e964ba37a6911bc2f966b068b48c208bb3e9a88`; EAS `15988520-f034-48ad-b5cb-43089e529c5d` | Previous direct-download release |
| Local QA APK 27 | Source `a350d52555f3064aa5366e7aabc49de88b001a5c`; EAS `24f5e47a-27b6-486d-b616-eaf9c010e362` | Dedicated QA package and USB/loopback backend; not a Play launch candidate |
| Build 25 | Cancelled; source `f821a4f91c2c56c8dcc280e70575c1892696f73a` | Check whether its code was reserved |
| AAB 20 | Source `dd7590c98e5ccf3c9c625d39b726b882049cb14d`; EAS `1e2db35f-94a3-486b-9014-92e22d4ae912` | Historical bundle, **not the launch candidate** |

Historical AAB file: `.release-tmp/android-release-20261005/trip-splitter-android-1.0.0-build-20.aab`;
94,135,799 bytes; SHA-256
`d37a2369ff95551465a0ddc3ad7a60f106550de3393c2c162d7be1a21147d5ec`.
Its recorded bundletool, signature, production configuration and native-alignment checks
remain historical evidence. Current source/device acceptance is recorded in the shared handoff.

## 4. Complete applicable app-content declarations

Owner: account holder + product owner. Follow the requirements shown for the chosen track;
closed/production release needs the full applicable declarations.

Use the [submission pack](PLAY_STORE_SUBMISSION_PACK.md) for editable listing/release-note
drafts, the Data safety worksheet, owner decisions and private reviewer-access preparation.

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
These are future track requirements; no tester recruitment, app tests or upload is scheduled
by the documentation milestone. Only one physical phone is currently available; two-device
notification and other unverified provider/device results remain pending in the launch register.

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

For a failed rollout, use the [recovery procedure](GLOBAL_LAUNCH_WIRING.md#6-recovery-and-release-record)
and named operator. Preserve database/backups, signing identity, working download targets and
unresolved device actions. Do not treat a lower-version APK or database wipe as rollback.
