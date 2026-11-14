# Splitora Google Play launch handoff

Updated 14 November 2026. This is the shared source, readiness and owner-action register.

## Approved release brief

| Item | Approved value |
| --- | --- |
| Product | Splitora |
| Initial distribution | India |
| Pricing and advertising | Free, ad-free |
| Intended audience | Ages 13–15, 16–17 and 18+ |
| Community | Group chat retained, with terms, reporting, blocking and moderation |
| Public support/privacy contact | teamsplitora@gmail.com |
| Source baseline | `main` at `ab97b5a5430650674700d55e5c95f205b93849d8`, including the reviewed group-deletion restriction |
| Approved existing local work | Case-insensitive group-deletion confirmation and its regression test |
| Android identity | `com.tripsplitter.app`, version `1.0.0`, Expo SDK 54 |
| EAS project | Owner `jyotirmay03`, project `0a3b5a1c-5cbd-4eac-bff7-5b53ee4b6948` |
| Build entry point | `frontend/`, dynamic `app.config.js` over `app.base.json`, production EAS profile |
| Submission default | Manual Play Console AAB upload |
| Schedule | Readiness milestones, followed by account-dependent eligibility and review |

The saved GPay-style branch `codex/gpay-ui-saved-20261014` at `7bbee46c6a37f800507b68ce4d10a8798c058270` was deleted locally on 13 November 2026. The approved release excludes its code. Review the release diff against the pinned baseline and record the origin of each readiness change. Check that the saved commit is absent from the release ancestry.

The owner confirms that no Google Play developer account exists yet. Account enrollment,
Console app creation and every account-dependent action are deferred until the owner
provides the intended account later. No existing Play app URL or Console app has been
identified; `com.tripsplitter.app` is the configured package, not evidence of a Play listing.
Account type, creation date, identity/contact/device verification and production eligibility
are not yet established. No deadline is assumed.

The testing release uses `codex/splitora-launch-preview`, created from the refreshed
`main` baseline above, with the approved case-insensitive confirmation, launch-readiness
patch and gallery-only correction. The earlier readiness review started at `ed26aee`.
`git merge-base --is-ancestor 7bbee46c6a37f800507b68ce4d10a8798c058270 HEAD`
returns 1 on this branch. The deleted saved UI branch remains absent.

## Human-testing APK release

The testing build uses `frontend/eas.json` profile `qaLocal`, internal APK distribution,
remote auto-increment and the canonical dynamic Expo configuration. Its dedicated package
is `com.tripsplitter.app.qa`, displayed as **Splitora QA**, version `1.0.0`. The QA remote
counter was initialized at 25 so the next build receives code 26. ARM64 and x86_64 support,
embedded JavaScript, signing and final permissions require inspection of the finished APK.

The selected backend is the updated local QA API at `http://127.0.0.1:8000`, backed by
loopback replica set `splitoraLaunchQA` on port 27029 and fresh database
`splitora_launch_preview_20261114`. Email and push delivery are disabled in this QA process.
The production EmailJS authorization decision remains recorded below and in the email guide.

Testers need this workstation running and an authorized USB-debugging connection. From
the repository root, use RTK and the Android platform tools already installed here.

```powershell
rtk proxy adb devices -l
rtk proxy adb -s DEVICE_SERIAL reverse tcp:8000 tcp:8000
rtk proxy adb -s DEVICE_SERIAL install -r PATH_TO_QA_APK
```

Replace `DEVICE_SERIAL` and `PATH_TO_QA_APK` with the selected phone and downloaded file.
Keep USB connected during online testing. Reapply forwarding after a reboot/reconnection.
Remove the mapping before an offline test, then restore it for recovery.

```powershell
rtk proxy adb -s DEVICE_SERIAL reverse --remove tcp:8000
rtk proxy adb -s DEVICE_SERIAL reverse tcp:8000 tcp:8000
```

Local QA service launchers, credentials and evidence are retained privately under
`.release-tmp/splitora-launch-preview-20261114/`. `start-services.ps1` accepts `mongo` or
`api`; the API launcher retains the same private signing secret across restarts. The
synthetic accounts and their passwords are in `QA_ACCOUNTS.md` in that directory.
Alex Mehta completes the age/terms review in the installed app. Choose **18 or over**,
review the linked policies, accept the current terms, then continue to groups. Sam Rao
already has adult terms accepted. Both can access **Splitora QA weekend**, containing
two sample expenses, a receipt, a family and a message for report/block testing.

Additional adult testers can register a Gmail/password account against this QA backend,
complete the same review and create a group or join the sample using its locally recorded
code. Email delivery is disabled, and these QA accounts use synthetic identities. Keep
credentials in the private handoff. Use synthetic receipts and expenses during testing.

The artifact, exact source commit, download verification and final device results are
recorded here after the build completes. Google Play Console milestones remain deferred.

### Testing-release source checks

| Check | Actual result on 14 November 2026 |
| --- | --- |
| Frontend Jest | 146 suites and 1,312 tests passed; one suite and 18 tests skipped |
| Isolated backend | 1,684 passed, two skipped and 320 live-API cases deselected |
| TypeScript and ESLint | Both passed; lint produced no warnings |
| Expo dependency check | Passed within SDK 54; existing keyboard-controller exclusion retained |
| Expo Doctor | 17/17 passed; existing native-directory synchronization check remains disabled |
| Backend dependencies | `pip check` passed |
| Production web export | 49 routes exported successfully |
| Public service observations | Production API health, public web homepage and isolated QA API each returned HTTP 200 |
| Source and archive review | 91 release files reviewed, including eight listing images and new safety/policy code; secret-pattern scan and final archive exclusion checks passed |

The refreshed main-based group-deletion callback needed its matching financial-writer
inventory entry. That entry was added before the passing full backend run. One intermediate
run hit the existing slow-UPI client test's timing race; the subsequent complete run passed.
The first web export encountered Windows access denial while creating a generated route
directory. Its retry completed successfully. Private logs retain these attempts.

The reviewed QA profile explicitly enables the existing Android offline-write feature.
Both EAS ignore files now exclude nested `.release-tmp` directories, following discovery
of a temporary backend test report in the first archive inspection. The final archive
contains the canonical configuration and safety/receipt code, with no local native Android
project, environment files, signing material, dependencies, APKs or temporary evidence.

### Patch provenance for review

| Area | Origin and review evidence |
| --- | --- |
| Group-deletion confirmation | Approved pre-existing local fix in `frontend/app/trip/[id]/index.tsx` and `trip-detail-header-budget.test.tsx`; case-insensitive spelling with whitespace trimming remains covered |
| Public policies/deletion links | New readiness work: `frontend/app/privacy.tsx`, `terms.tsx`, `account-deletion.tsx`, `src/LegalPage.tsx`, `LegalLinks.tsx` and public auth routing |
| Community/guardian safeguards | New readiness work: `backend/models/community.py`, `routes/community.py`, `services/community_safety.py`; matching `frontend/app/community-settings.tsx`, `moderation.tsx`, `src/CommunityProvider.tsx` and reporting controls |
| Receipt permissions and inspection | New readiness work: canonical `frontend/app.base.json`, `plugins/withReceiptPermissions.js`, receipt forms/viewer and report-specific backend receipt retrieval |
| Regression and operations | New readiness fixtures/tests, isolated test runner, feature/user guides, operating procedure, corrected Play guide and synthetic listing assets; no financial arithmetic redesign |

All entries are changes from the pinned main baseline. No saved GPay branch merge or
cherry-pick was used. Review the current diff and new files before assigning a release commit.

## Release and runtime evidence

| Evidence | Recorded state |
| --- | --- |
| Public APK | Build 24, source `4e964ba37a6911bc2f966b068b48c208bb3e9a88`, EAS build `15988520-f034-48ad-b5cb-43089e529c5d` |
| APK verification | Historical Android 15 emulator install/update/launch and invitation checks, target API 36 and 16 KB ZIP alignment recorded in the build-24 report |
| Build 25 | Cancelled, source `f821a4f91c2c56c8dcc280e70575c1892696f73a` |
| Historical AAB | Build 20, source `dd7590c98e5ccf3c9c625d39b726b882049cb14d`, EAS build `1e2db35f-94a3-486b-9014-92e22d4ae912` |
| Checkout at inspection | `main` and locally recorded `origin/main` at `ed26aee`, 15 commits after build-24 source |
| Public backend observation, 12 November | Health HTTP 200, revision `ef2b25047745`, chat protocol 1 |
| Public feature observation, 12 November | Email, invitations and multi-currency enabled, expense/payment create protocols 1, expense-settlement activation disabled |

Build 24 and AAB 20 precede this readiness work. Fresh source, build and device evidence must identify their exact revision and artifact. The local QA environment uses disposable data and isolated ports. Its fixture data and credentials belong under ignored `.release-tmp` paths.

The EmailJS authorization limitation remains governed by the owner's interim rollout decision of 4 November. Preserve that decision and the recorded inbox evidence when reviewing launch operations. The provider's 200-message monthly free allowance, plain-text MIME verification and current delivery capacity remain operational checks. [Email record](EMAIL_SETUP.md)

## Implemented interfaces and behaviour

### Public information and deletion

The `/privacy`, `/terms` and `/account-deletion` routes work through the public authentication-route allowlist. Authentication screens and Profile link to the policies and support. The deletion page provides a support-email request pathway usable after uninstalling the app, alongside the existing signed-in impact review.

Account deletion removes credentials, direct account contacts, devices and tokens and invokes local account cleanup. Shared names, financial records, receipts and de-identified chat follow the existing shared-record retention behaviour. The public policy describes these retained categories and a support pathway for personal-data review/redaction. The owner must approve the stated reconciliation, fraud-prevention and dispute-resolution purposes and operating retention process before publication.

### Community and teen controls

The initial community terms version is `2026-11-13`. Existing accounts and new accounts complete an age-group and terms review. Protected account APIs enforce eligibility. Ages 13–17 require guardian consent and adult-verification review before group access. Chat, receipt and contact-sharing grants are independent guardian controls. Under-13 declarations lead to support/deletion access.

`GET /auth/me/safety` returns current permissions, guardian status, the account's blocks and its guardian controls. `POST /auth/me/safety/terms` accepts the displayed version and age band. Age corrections go through support. Android's sanitized cached identity retains the last server-confirmed permission summary for an already verified offline session. Server checks govern synchronization and current online access.

The guardian request uses a private, random code with a seven-day validity period. Only its hash is stored. The intended guardian signs into a verified adult account and explicitly consents. The application administrator completes adult identity/relationship verification through the approved process and records a case reference before enabling access. The guardian can change permissions later. Passwords, identity-document images and verification credentials stay outside the moderation record.

The initial moderation owner is the existing application administrator. `/moderation` exposes content reports and pending guardian reviews through super-admin-protected APIs. Reporting supports messages, receipt images and group users. Client UUIDs make a report retry idempotent. Blocking filters message history, unread counts, WebSocket delivery and chat push delivery. Moderation removes message text, hides a reported receipt revision or suspends community posting. Report resolution records the reason and operator. Resolved cases expire after 90 days. Support receives appeals.

Receipt inspection uses a report-specific endpoint. It returns the reported revision or
an explicit unavailable result after replacement/deletion, including a fingerprint check
for legacy inline images. It never substitutes the current receipt. Moderation state and
pending requests reset on account changes. Restored sessions wait for their own safety
result before deciding whether to redirect to terms review. A transient transport failure
retains a same-account verified policy while authentication applies its cached-session
deadline; explicit server denials clear eligibility.

Password/Google sign-in, registration, profile updates and password setup return the same
current age, accepted terms and permission summary as `/auth/me`. These identity
replacements preserve the server-confirmed safety metadata needed for an eligible
Android session to restart offline. A fresh password sign-in and standalone offline
cold start verify this path; changing only the live safety response would leave the
cached identity incomplete.

The [operating procedure](COMMUNITY_OPERATIONS.md) defines guardian review, report handling,
appeals, deletion requests, retention and deployment rehearsal. It is a concrete draft for
owner acceptance. The Indian rule commencement and lawful identity/relationship verification
method still need qualified review; manual case-reference entry does not prove legal compliance.

### Receipt permissions

The owner confirmed on 14 November that receipt attachment is gallery-only. **Attach image**
opens the system image picker directly in Add/Edit Transaction. Camera acquisition and the
source-selection sheet have been removed. Android camera, microphone and broad media-read
permissions are blocked. The image-picker camera/microphone options are disabled and the
iOS camera usage description is removed. Legacy gallery-write access is limited to API 28
and below. Android 10+ saves to the gallery through MediaStore. iOS gallery permission is
requested when the user chooses to attach an image.

## Phase 1 owner and acceptance register

| ID | Priority | Owner | Dependency | Acceptance | Status |
| --- | --- | --- | --- | --- | --- |
| SOURCE | P0 | Engineer | Approved baseline | Saved branch deleted, main-based provenance verified, local fix included | Local branch absence and ancestry verified; approved fix preserved; release commit still to be recorded |
| POLICIES | P0 | Engineer + product owner | Data/retention inventory | Public routes accessible signed out and signed in, support deletion pathway usable, retained fields documented | Seven browser journeys and authenticated deletion/cleanup scenarios pass locally; public deployment and inbox rehearsal pending |
| SAFETY | P0 | Engineer + application administrator | Terms and age declaration | New/existing users, guardian review/revocation, reporting, blocking and moderation pass API/UI checks | Ten database/authenticated safety scenarios pass; UI rehearsal and operator acceptance recorded separately below |
| INDIA | P0 | Product owner + verification operator | Ages 13+ and Indian child-data rules | Approve adult/guardian verification procedure, consent records, retention and support process | Owner operating-process acceptance pending |
| MEDIA | P1 | Android engineer | Native generated configuration | Merged manifest excludes camera/microphone/broad reads. Gallery selection, cancellation, save and denial pass | Gallery-only source and permission checks recorded below. Rebuilt APK device acceptance remains pending |
| REGRESSION | P1 | Engineer | Readiness source | Dependencies, Doctor, TypeScript, lint, frontend tests, isolated backend tests and web export pass | Backend 1,647 pass; full frontend 1,298 pass plus focused new tests; Doctor 17/17; final checks below |
| DEVICE | P1 | Engineer + testers | Development/QA build | Install/upgrade, auth/recovery, groups, calculations, FX, UPI handoff/confirmation, reports, notifications, deletion and offline isolation/retry pass | QA build/install, password sign-in, receipts, single-write offline sync, account isolation/deletion and standalone offline restart pass; remaining device matrix below |
| LISTING | P1 | Product owner + engineer | Tested primary UI | Listing copy, current icon/feature graphic and six representative screenshots reviewed | Copy, two brand assets and six reviewed synthetic web drafts prepared; final Android captures and owner approval pending |

Each acceptance result must cite its command or user journey, source revision/patch, environment, result and evidence path. Keep skipped cases visible. Record production deployment as a separate action with backend-first compatibility checks.

## Draft store listing and declarations

### Listing copy

**App name** Splitora

**Short description** Split group expenses, track balances and settle up with friends and families.

**Full description**

Splitora helps friends and families organize shared expenses in private groups.

Create a group, invite people and track who paid. Split each expense per person, per family or by exact amounts. Record refunds, review balances and keep a clear payment history.

Choose your group's currency and record foreign-currency expenses with reviewed conversion details. Attach receipt photos and export PDF and Excel reports for the group.

Use group chat to coordinate. In-app reporting, blocking and guardian controls support community safety. Teen accounts require parent or guardian consent and verification review.

On Android, previously saved groups and same-currency expense/manual-payment entries support offline use and server-confirmed synchronization. UPI handoff opens your selected payment application, with payment reporting and recipient confirmation inside Splitora.

Splitora uses Gmail accounts. The initial launch is free and ad-free for people aged 13 and over in India. Support and privacy requests can be sent to teamsplitora@gmail.com.

### Data safety working inventory

| Data | Purpose and sharing context |
| --- | --- |
| Name, Gmail, user ID, password hash, verification/session information | Authentication, account security, provider-assisted sign-in/email |
| Optional mobile number and UPI address | Authorized group contact and payment handoff, guardian-controlled sharing |
| Group/member/family names and membership | Shared group operation and access control |
| Expenses, currencies, allocations, balances, payment attempts and confirmations | Expense management, financial reconciliation and group reporting |
| Receipt photos and text chat | User-shared group content, moderation and support |
| Push identifiers and notification settings | Optional notification delivery through Expo/Firebase |
| Age group, terms version, guardian consent, blocks and safety cases | Eligibility, child/social safeguards, complaint handling and abuse prevention |
| Operational activity/audits and necessary diagnostics | Security, troubleshooting and reconciliation |

Review provider processing and user-initiated sharing against Google's exact collected/shared definitions. Verify the final native SDK inventory and manifest before submitting answers. The financial declaration must assess expense management and external UPI handoff against Other and Payments/transfers. The account holder resolves financial-service/account-type applicability using the actual flow and any necessary Play support guidance.

### Asset acceptance

The [listing asset pack](play-store-assets/README.md) contains the current S/T Splitora
512×512 store icon, 1024×500 feature graphic and six 1080×2400 synthetic screenshot drafts
showing group overview, Exact splitting, settlement review, receipts, chat safety and reports.
All eight images were visually reviewed. The drafts come from the final production web
export in a 432×960 Chromium viewport at device scale factor 2.5. API/WebSocket traffic
was redirected to the disposable local API; other external requests were blocked.

[The asset manifest](play-store-assets/manifest.json) records dimensions, byte sizes,
checksums and application-source provenance. Recapture/review actual Android rendering
on the approved final artifact and obtain the owner's listing approval before submission.
These captures do not establish Play-installed acceptance.

## Phase 2 deferred Play Console work

| ID | Owner | Prerequisite | Completion criterion |
| --- | --- | --- | --- |
| ACCOUNT | Account holder | Owner provides account later | Enroll/identify the intended publisher; create or identify its app; record URL/name/package, account type, exact creation date and identity/contact/device verification status |
| ELIGIBILITY | Account holder | ACCOUNT | App-specific production-access state and applicable closed-test requirement recorded |
| DECLARATIONS | Account holder + product owner | Phase 1 evidence | Financial classification, audience/IARC, Data safety, support, free pricing, India distribution and reviewer access completed |
| SIGNING | Account holder + release engineer | Existing app/key evidence | Upload/app-signing certificates reconciled, existing APK upgrade path verified, Play SHA-1 OAuth and SHA-256 App Links registered |
| BUNDLE | Release engineer | Readiness acceptance + SIGNING | Fresh production AAB, version code above every used/reserved code, source/build/checksum/manifest/signing evidence recorded |
| PLAY-QA | Test coordinator | Play internal release | Real Play-installed sign-in, invite routing, push, upgrade recovery and core journeys pass |
| CLOSED | Account holder + tester coordinator | Applicable eligibility rule | At least 12 testers continuously opted in for the preceding 14 days, feedback/engagement evidence and production-access approval |
| PUBLISH | Account holder | All release gates | Google review approved and India listing/install journey verified |
| OBSERVE | Support/moderation owner | Publication | 72 hours of vitals, policy, support and moderation triage recorded, recovery owner assigned |

Future releases use higher version codes. Percentage-based staged rollout is available for app updates. The first publication uses the approved country distribution. The qualifying 14-day period starts with the actual closed-test opt-ins, followed by access and release reviews.

## Official requirements checked

The requirements below were revalidated against official Google Play and Expo documentation
during 12–14 November 2026. Recheck account notices and policy changes at submission.

- New personal accounts created after 13 November 2023 require 12 continuously opted-in closed testers for 14 days before applying for production access. Internal testing supports up to 100 testers. [Testing eligibility](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
- Internal-only distribution has a Data safety exemption. Availability can take time and the guide must avoid a review-delay guarantee. [Testing tracks](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en) · [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
- Financial declarations cover financial features and organization-account rules apply to specified financial services. [Financial declaration](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en) · [Account types](https://support.google.com/googleplay/android-developer/answer/13634885?hl=en)
- New phone/tablet apps and updates require API 36 from 31 August 2026, with native 16 KB compatibility verified in the actual artifact. [Target API](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en) · [Native page sizes](https://developer.android.com/guide/practices/page-sizes)
- Public privacy and outside-app deletion pathways, UGC moderation and local child definitions affect readiness. Indian teen access requires the operator's approved verification/consent procedure. [User data](https://support.google.com/googleplay/android-developer/answer/10144311?hl=en) · [Deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en) · [UGC](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en) · [Audience](https://support.google.com/googleplay/android-developer/answer/9867159?hl=en)
- Photo access must match the receipt use case, and signing choices affect cross-distribution upgrades. [Media policy](https://support.google.com/googleplay/android-developer/answer/14115180?hl=en) · [App signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
- Expo supports production AAB generation and either manual upload or configured EAS Submit. [Expo submission](https://docs.expo.dev/submit/android/)

## Verification before the gallery-only correction

The following broad test runs and APK checks precede the owner's gallery-only correction.
Current gallery-only verification is recorded in the next section. The earlier APKs include
camera acquisition and must be rebuilt for the current receipt flow.

Local evidence is under `.release-tmp/play-store-readiness-20261113/` (ignored; synthetic
fixtures and credentials must stay there). The environment uses loopback-only MongoDB
replica set `splitoraLaunchQA` on port 27029, a disposable API on 18795, web preview on
18796 and final export server on 18798. Native media/core checks use the canonical
`frontend/` through Metro on 8081 and a dedicated QA package. The final cold-start check
uses embedded JavaScript/assets in a standalone QA APK. Email and push delivery are
disabled. Production data has not been used.

| Check | Result / evidence |
| --- | --- |
| Full isolated backend regression | **1,647 passed, 2 skipped, 320 deselected** in the final run; `backend-tests.xml`; includes ten real MongoDB/authenticated safety scenarios and both actual-server startup/report scenarios |
| Full frontend Jest run | **144 suites passed, 1 skipped; 1,298 tests passed, 18 skipped**; `frontend-tests.json`; precedes the final four moderator/provider tests |
| Final focused frontend regression | **7 suites, 141 tests passed** after the last frontend edits: API, moderator isolation, restored/offline policy loading, authentication, Exact editor/helpers and original group-deletion fix; `frontend-final-focused.json` |
| Final focused backend safety regression | **10 passed**, including identity-replacement metadata, guardian eligibility/grants/revocation, reports, moderation and account cleanup; `backend-safety-final.xml` |
| TypeScript | `node node_modules/typescript/bin/tsc --noEmit` passes after regenerating Expo route declarations |
| Lint | `node node_modules/eslint/bin/eslint.js .` passes with no warnings after the final import correction |
| Dependency validation | Expo SDK package-map compatibility passes; existing keyboard-controller exclusion retained; offline map check supplemented by Doctor |
| Expo Doctor | **17/17 pass**; existing app-config/native-directory synchronization check is disabled in project settings |
| Web production export | Final **49-route** export, including policies and safety/moderation screens; `web-export-reviewed/`; bundle `entry-7b9681dcde6c89770e2e5bcf7245e436.js` |
| Public browser journeys | Seven pass, no page errors: three signed out policies, adult terms acceptance, three signed in policies; `browser-check.json` |
| Community browser journeys | Five pass, no page errors: teen terms/request, guardian limited grants, moderator review, withdrawal and under-13 restrictions; `browser-safety-check.json`; email/identity verification explicitly simulated |
| Listing browser journeys | Five pass, no page errors: report, block, unblock, actual synthetic PDF download and XLSX download; six screenshots captured; `listing-check.json` |
| Fresh native builds | Initial Metro QA build and release-manifest merge pass (`native-retry.log`); production-JavaScript `export:embed` and standalone QA packaging pass (`standalone-bundle.log`, `standalone-gradle.log`); both installed on Android 15/API 35 x86_64 emulator `emulator-5574` |
| Native manifest | Fresh debug **and release** merges assert target API 36, no broad/selected media-read or microphone permissions, and legacy write permission capped at API 28; `native-artifact-check.json` |
| QA native alignment | All **27 x86_64 libraries** pass ELF load-segment and uncompressed ZIP 16 KB alignment checks; `native-alignment-check.json`; final ARM/Play artifact still required |
| Native media checks | Historical system picker, selection/crop, gallery save and upload pass. Historical camera checks belong to the earlier receipt flow |
| Native cached access | Standalone cold start with API reverse removed, Wi-Fi off and mobile data off restores Alex's dashboard and INR +4,500 position; reopening the saved Goa weekend group also passes. Network state is restored afterward; `native-standalone-offline-check.json` and `native-device-check.json` |
| Native pending writes | Freshly refreshed Android preview saves an INR 40 expense while the API is unavailable; reconnection creates exactly one server expense and a repeated resume creates no duplicate; temporary test expense removed; `native-core-offline-check.json` |
| Native account isolation/deletion | A new synthetic account sees none of Alex's cached group/balance; deleting it clears remembered identity, signs out and revokes its token; Alex's independent account restores successfully; `native-core-cleanup-check.json` |
| Local QA cleanup | Verified task-owned emulator, Metro, web/export servers, API and MongoDB stopped; all seven task ports clear; evidence and AVD data retained; `cleanup-all.json`, `cleanup-verification.json` |

The 320 deselected backend tests depend on live-API fixtures; they were not silently
reported as passed. The two skipped backend cases and 18 skipped frontend cases remain
visible in the evidence. Historical APK 24 device checks do not satisfy new native acceptance.

An earlier full run hit the two isolated server-startup deadlines while native checks were
running. Both passed in isolation, and the final full run passed after those checks stopped.
Startup failures now include their isolated server diagnostics; the earlier attempt is
retained as `backend-tests-startup-timeout-attempt.xml`.

## Gallery-only correction verification

Current source opens the gallery directly from the existing attachment buttons. The focused
Add/Edit tests exercise Android and iOS selection/cancellation, iOS permission denial,
populated form preservation and receipt upload. TypeScript and frontend lint pass.
Fresh native permission evidence is under `.release-tmp/gallery-only-20261114/`.

| Check | Result |
| --- | --- |
| Focused Add/Edit regression | 2 suites and 33 tests pass, including 10 gallery selection/cancellation/denial cases. `frontend-tests.json` |
| TypeScript and frontend lint | Both pass on the corrected source |
| Fresh Android debug and release manifests | Both merges pass for `com.tripsplitter.app`, target API 36. Camera, microphone and broad media-read permissions are absent. Legacy gallery write is capped at API 28. `native-manifest.log` and `verification.json` |
| Checked-in Android configuration | Local QA manifest applies the same camera/media exclusions and legacy write limit. EAS continues generating its native project from the canonical Expo configuration |
| iOS Expo permission introspection | Photo-library selection/saving descriptions present. Camera and microphone descriptions absent. `ios-gallery-permissions.json` |

The corrected application-source review fingerprint is
`d71f1351ebf433f852c0413dc2c84eb49f4dd02c98bb71599401b06aa943a244`,
covering 725 Git-listed files under `backend/`, `frontend/` and `shared/` using the
path/NUL/bytes/NUL algorithm in `verification.json`. Earlier listing and APK fingerprints
identify their earlier source snapshots.

The final signed gallery-only APK still needs its own device selection/crop/upload/save checks.

### Earlier source and native artifact provenance

The earlier pre-gallery-correction application snapshot has SHA-256
`a55bab2d4aedb398fe9a150461021b0ca22bf7b6ec11a114c8557decc4782e7d`.
Its 723 Git-listed `backend/`, `frontend/` and `shared/` files are fingerprinted using
the exact algorithm in the asset manifest. This is a review fingerprint, not a release
commit. Record the reviewed commit before any production build or upload.

The earlier standalone QA APK is `qa-standalone.apk` under the evidence directory,
87,824,056 bytes, SHA-256
`e747986a7fd829d2e1bdcbbecba1fb7e39ec5ecee62c516d938120a94cd26077`.
Its embedded Android bundle has SHA-256
`d84e8052a856652eb895fc78a8e0d5855779141dbc4d6931101a57001f41129a`.
It uses `com.tripsplitter.app.launchqa`, debug signing, QA loopback transport and
`EXPO_PUBLIC_OFFLINE_QA=true`. Developer support was disabled only in the disposable
native project so the app could start without Metro.

Earlier media, single-write synchronization and account-deletion checks used
`qa-metro.apk`, 77,866,567 bytes, SHA-256
`558400f4cc6d723682076c367d9243570d1637add7be6b281ee1f8847dc1414b`,
with the refreshed canonical frontend through Metro. The native journal assigns each
journey to its artifact. The last backend identity-response fix was applied after the
standalone client was embedded; the frontend stayed unchanged. The combined review
fingerprint identifies the final verification snapshot, rather than an immutable APK
build input. `native-artifact-check.json` also records the frontend/shared fingerprint.

Short CMake staging paths and reduced compiler concurrency were applied only to the
disposable Windows QA project. Production package configuration was not changed by
these build workarounds.

This x86_64 development build does not verify ARM 16 KB compatibility, a signed production
AAB, APK-24 upgrade continuity or Play installation. Those require the final artifact.
API-28 legacy gallery permission handling and Android-16/API-36 device behaviour still
need their own device checks. The earlier camera permission-expiry failure belongs to the
removed camera acquisition path. Current acceptance exercises selection of an existing
gallery image and verifies that the rebuilt APK excludes camera access.

The initial Metro APK needed its development assets for a fully disconnected cold start.
The subsequent standalone APK passes with embedded assets and both Wi-Fi/mobile data
disabled. Final signed-artifact acceptance must repeat this journey without QA overrides.

### Remaining device and operating acceptance

| Journey | Owner / prerequisite | Completion evidence |
| --- | --- | --- |
| Existing APK-24 upgrade and terms-review route | Release engineer; coordinated compatible release | Existing accounts can reach review/update and preserve groups/local work; no backend-only lockout |
| Google OAuth, email verification/reset and invitation links | Engineer + owner; configured OAuth/email provider and QA build | Delivered links/tokens work once, correct routing/session recovery; no synthetic-delivery substitution |
| Notifications and external UPI app flow | Engineer + testers; approved QA device/provider configuration | Permission denial/re-enable, exact recipient/amount, return/cancel and confirmation checked without claiming bank verification |
| Offline/restart/account isolation | Engineer + testers; final native artifact | QA standalone offline start, cached group access, single-write sync and cross-account deletion pass locally; repeat on the final signed artifact and verify remote revocation/recovery |
| Native media across supported Android versions | Android engineer with API-28, API-35 and API-36 devices | Direct gallery selection/crop/upload/save, cancellation and denial recorded. Final manifest excludes camera, microphone and broad media-read permissions |
| Support/deletion/moderation operations | Named primary and backup operators | Inbox request and report/guardian/appeal/deletion rehearsal accepted, retention process and India review signed off |

For a reproducible isolated run, start a **disposable loopback replica set**, set
`SPLITORA_TEST_MONGO_URL` in the test process, then run from the repository root:

```powershell
rtk proxy backend/.venv/Scripts/python.exe backend/scripts/run_isolated_tests.py tests -q --tb=line
```

The runner rejects a non-loopback Mongo URL, replaces inherited application/API connections
with unused loopback endpoints, supplies the seven explicit Mongo test opt-ins and deselects
the live-API fixtures. Each opted-in test creates its own disposable database. Without the
Mongo opt-in, those integration cases skip; that is not a complete launch-readiness run.

From `frontend/`, repeat only checks affected by subsequent changes:

```powershell
rtk proxy node node_modules/typescript/bin/tsc --noEmit
rtk proxy node node_modules/eslint/bin/eslint.js .
rtk proxy node node_modules/jest/bin/jest.js --runInBand
rtk proxy npx expo install --check
rtk proxy npx expo-doctor
rtk proxy node node_modules/expo/bin/cli export --platform web
```

## Remaining owner decisions and release gates

1. **P0, product owner:** name primary/backup support and moderation operators; approve the
   operating procedure, shared-record retention/redaction purposes and recovery/deletion handling.
2. **P0, product owner + qualified India reviewer:** record applicable rule commencement,
   approve the adult/guardian verification method and evidence handling, and rehearse consent,
   withdrawal and age correction. Teen launch remains blocked until accepted.
3. **P0, release engineer + owner:** review and commit the readiness patch; coordinate backend,
   web and native delivery, rehearse the APK-24 upgrade/review route, and make the public policy
   and outside-app deletion URLs available on the launch domain. No deployment occurred here.
4. **P1, engineer + testers:** complete the remaining device matrix above with the rebuilt
   gallery-only APK and final Android listing captures. Record the new artifact and device
   evidence alongside the earlier QA results and web listing drafts.
5. **Deferred, account holder:** provide the intended Play account later. Then follow ACCOUNT
   through OBSERVE above, including final publisher/financial declarations, signing, final AAB,
   Play-installed testing, production access and India publication.

Phase 1 is complete only after its independent acceptance and operating gates pass. Launch
is complete only after the deferred Console gates, publication and 72-hour observation pass.
