# Android Notifications Test Report - 2026-09-07

## Outcome

Release status: **Blocked**. The eligibility repair and automated gates pass, but the current EAS
project has no FCM v1 credential, no `GOOGLE_SERVICES_JSON` variable is visible, and Build 6 lacks
Firebase app/sender resources. No physical Android device is attached, so no canary or device
matrix result is claimed.

| Area | Status | Evidence |
| --- | --- | --- |
| First-trip eligibility repair | Pass | `GET /api/push/eligibility` returns only a boolean; pending requesters are eligible; join creation awaits sync |
| Push/backend focused automation | Pass | 47 tests passed |
| Notification/join/chat/payment/settlement unit gates | Pass | 172 tests passed across the selected non-mutating suites |
| Full frontend Jest | Pass | 641 tests passed across 85 suites |
| TypeScript and tracked-source ESLint | Pass | Both exited successfully |
| Expo dependency and Doctor gates | Pass | Dependencies current; 18/18 Doctor checks passed |
| Production web export | Pass | 35 static routes exported |
| Hosted health/home | Pass | API health HTTP 200 at revision `c7a8ea143815`; web HTTP 200 |
| Build 6 Firebase client configuration | Fail | APK has Firebase messaging classes but no `google_app_id`, GCM sender, or default web client resource |
| EAS FCM v1 credential | Fail | EAS Android credential status reports none assigned |
| EAS Firebase file variable | Fail | Not present in project/account preview environment or legacy app secrets |
| Render push flag/access-token alignment | Blocked | Private runtime configuration is not exposed by health and no authenticated Render session is available |
| Two-device canary and physical matrix | Blocked | ADB reports zero attached devices |

## Redacted test record

| Field | Value |
| --- | --- |
| Record opened | 2026-09-07 20:16:34 +05:30 (Asia/Calcutta) |
| Repository baseline | `c7a8ea1438152c5a75af6941e5329aa33af36362` |
| Candidate revision | Uncommitted eligibility repair on the baseline; update before APK build |
| Hosted backend revision | `c7a8ea143815` |
| Existing APK | Version 1.0.0, Android build 6 |
| Existing EAS build ID | `298c6aba-a29f-4038-9171-eee957cce866` |
| Package | `com.tripsplitter.app` |
| EAS project ID | `0a3b5a1c-5cbd-4eac-bff7-5b53ee4b6948` |
| Hosted API | `https://tripsplitter-api.onrender.com` |
| Device A / Android | Not attached |
| Device B / Android | Not attached |
| Account labels | Owner / Member / Requester not provisioned in this run |
| Activity / approval / rejection trip IDs | Not created; production-mutating tests were not run |

No token, credential, email address, installation identifier, financial content, chat text, or
rejection reason is stored in this report.

## Defects and repairs

### NOTIF-ELIG-001 - first-trip requester could not register

- Boundary: client eligibility and post-request lifecycle.
- Cause: Android synchronization inferred eligibility from `/trips`, which is empty until approval.
- Repair: authenticated minimal eligibility endpoint; pending/approving own requests count; the join
  screen awaits synchronization immediately after durable request creation; sign-in and foreground
  remain retry paths.
- Automated evidence: zero-trip/no-request suppression, zero-trip/pending eligibility, auth, exact
  response shape, restart/offline retry, declined permission, successful registration, and awaited
  join synchronization all pass.

### NOTIF-FCM-001 - Android build cannot prove FCM delivery readiness

- Boundary: native Firebase/EAS configuration, before any live canary.
- Evidence: Build 6 has `FirebaseInitProvider` and messaging service declarations, but its resource
  table lacks Firebase app/sender identifiers. EAS reports no FCM v1 service-account assignment and
  no Firebase file variable name in the preview environment.
- Required repair: obtain the existing Firebase Android app's `google-services.json` for
  `com.tripsplitter.app`, obtain an FCM v1 service-account JSON for the same Firebase project, upload
  them to their correct EAS locations, and verify only project/package metadata. Never commit either
  file.
- Release effect: do not start Build 7 or the canary until this defect is repaired.

## Automated fault coverage

| Case | Status |
| --- | --- |
| Private allowlisted payloads for all seven event types | Pass |
| Actor exclusion, explicit join audiences, recipient/token deduplication | Pass |
| Idempotent outbox/chat retry and negative business triggers | Pass |
| Malformed navigation payloads and duplicate taps | Pass |
| Expo 401/403/429/5xx ticket handling | Pass |
| Malformed ticket envelopes and ticket entries | Pass |
| Expo 401/403/429/5xx receipt handling | Pass |
| Missing/delayed/malformed receipts with bounded retry | Pass |
| `DeviceNotRegistered` retirement and retry exhaustion | Pass |
| Permission decline/revocation/recovery synchronization contracts | Pass |

The requests-based backend integration suites were not run because there is no isolated local API
or MongoDB service. They were not pointed at production.

## Seven-event physical matrix

| Event | Device A | Device B | Evidence |
| --- | --- | --- | --- |
| Expense created | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| Chat message created | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| Payment recorded | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| Settlement marked paid | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| Join request created | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| First-trip request rejected | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |
| First-trip request approved | Blocked | Blocked | Awaiting NOTIF-FCM-001 and devices |

## Negative and lifecycle physical cases

| Case group | Status | Reason |
| --- | --- | --- |
| Two active unique installations and two-device canary | Blocked | No configured push-capable APK or attached devices |
| Lock-screen privacy, channel importance, sound/banner | Blocked | Requires Android 13+ devices |
| Foreground/background/swiped-away/offline delivery | Blocked | Requires Android 13+ devices |
| Logout, account reassignment, permission revoke/restore | Blocked | Requires Android 13+ devices and redacted Mongo evidence |
| Uninstall/reinstall stale-token retirement | Blocked | Requires Android 13+ device and receipt cycle |
| Signed-out continuation and access-removed rejection | Blocked | Requires installed APK and disposable hosted accounts |
| No self/former-member/non-admin/duplicate delivery | Blocked | Automated contracts pass; hosted physical evidence still required |

## Next gate

Repair NOTIF-FCM-001, verify Render's push flag/enhanced-security alignment without revealing
values, build an incremented preview APK from the exact passing pushed revision, and run the
two-device expense canary. The stable `/download/android` redirect must remain on the prior artifact
until every physical positive, negative, lifecycle, privacy, routing, and receipt-status case passes.
