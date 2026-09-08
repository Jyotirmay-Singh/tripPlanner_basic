# Android Notification QA

Use this checklist to verify the complete production path: committed business action -> MongoDB
outbox -> current recipient and active-device resolution -> Expo ticket -> FCM receipt -> Android
display -> authorized tap navigation. Expo Go is not valid evidence; use a preview APK and physical
Android devices.

## Expected eligibility and permission behavior

- Notification support is Android-only. Web and iOS show **Notifications - Not available**.
- `GET /api/push/eligibility` is authenticated and returns only `{ "eligible": boolean }`.
- Eligibility is true when the signed-in user belongs to any trip or owns an active pending join
  request. A zero-trip user with neither condition is not prompted.
- Creating a join request immediately awaits permission and registration synchronization so a
  first-trip requester can receive approval or rejection. Sign-in and foreground synchronization
  retry interrupted, offline, or unavailable attempts.
- On Android 13+, the first eligible account with undecided permission sees a rationale explaining
  that alerts identify the trip and activity type while excluding personal and activity details.
  Android's dialog appears only after **Enable notifications** is pressed.
- **Not now** is remembered and suppresses later automatic rationale prompts. Recovery remains
  available from Profile and Android app settings.
- Revoked or denied permission deactivates the current server registration when the app next
  synchronizes. Restoring permission and foregrounding the app registers it again.
- Android 12 and older normally grant notification permission without a runtime dialog; treat them
  as optional compatibility coverage.

## Test record and topology

Create `test_reports/android-notifications-YYYY-MM-DD.md` before testing and record only redacted
metadata:

- exact Git revision, APK version/build number, EAS build ID, EAS project ID, Android package, and
  hosted API origin;
- both device models and Android versions;
- disposable account labels (**Owner**, **Member**, **Requester**) rather than emails;
- isolated activity, approval, and rejection trip IDs;
- synchronized sender/receiver timestamps and timezone.

Never record credentials, bearer tokens, Expo push tokens, Firebase material, installation IDs,
email addresses, chat text, financial details, or rejection reasons.

Use three disposable accounts, two physical Android 13+ devices, and three isolated trips:

1. **Activity trip**: Owner and Member are linked; Member is signed into both devices.
2. **Approval trip**: an unlinked requester placeholder; Requester has no joined trips.
3. **Rejection trip**: another unlinked requester placeholder; Requester has no joined trips.

## Configuration evidence

Before changing code or credentials, verify:

- hosted and repository revisions match the intended release source;
- Render startup logs say the push dispatcher is enabled;
- Expo enhanced push security and `EXPO_PUSH_ACCESS_TOKEN` are either both enabled/configured or
  both disabled/unset;
- the preview profile is an internal APK, uses remote versioning and `autoIncrement`, targets the
  hosted API, and resolves to package `com.tripsplitter.app` and the expected EAS project;
- the build consumes the `GOOGLE_SERVICES_JSON` EAS file variable;
- EAS has the matching Android FCM v1 service-account credential.

Do not print environment-variable values or credential contents while gathering this evidence.

## Fresh-install registration gate

1. Fresh-install the same APK on both devices and sign in as Member.
2. Grant notification permission and confirm the **Trip activity** channel exists at high
   importance with sound and Android-controlled lock-screen visibility.
3. Foreground each device and allow synchronization to finish.
4. In a redacted MongoDB query, require exactly two active, unique Android installations owned by
   Member. Report only the count and uniqueness result.
5. Log one device out. Confirm its registration becomes inactive, then sign it back into Member and
   confirm the two-device state is restored before the canary.

## Two-device canary

From the web, Owner creates one disposable expense in the activity trip. Correlate its source ID
and `expense.created:<sourceId>` event key without exposing expense content:

1. `push.event_enqueued` exists with the expected revision, event type, source, trip, and
   `inserted=true`.
2. `push.delivery_snapshot` reports one expected recipient and two active Android deliveries.
3. Expo returns two successful tickets.
4. Both devices display exactly one **Expense added** notification with the sanitized trip name
   within two minutes.
5. The receipt-check cycle reaches two `receipt_ok` statuses; allow up to 20 minutes.
6. Tapping on each device opens the activity trip's Expenses tab and matching expense. Repeat a
   tap and confirm it does not add another navigation entry.

Do not start the full matrix until the canary passes on both devices. Fix only the first failing
boundary, then repeat the canary.

## Seven-event positive matrix

Allow two minutes for display and 20 minutes for a terminal Expo receipt. Run one event at a time.

| Event | Receiver state | Eligible audience | Exact title / supporting line | Tap destination |
| --- | --- | --- | --- | --- |
| Expense created | Foreground | Member's two active devices, not Owner | `Expense added` / trip name | Activity trip Expenses tab and matching expense |
| Chat message created | Background | Member's two active devices, not Owner | `New group message` / trip name | Activity trip Chat tab and matching message |
| Payment recorded | Swiped away, not force-stopped | Member's two active devices, not Owner | `Payment recorded` / trip name | Activity trip Settle Up and matching payment |
| Settlement marked paid | Background | Member's two active devices, not Owner | `Settlement marked paid` / trip name | Activity trip Settle Up and matching settlement |
| Join request created | One owner/admin device foreground and one background | Current owner/admin devices only, not Requester or non-admins | `Join request received` / trip name | Members request view and matching request |
| First-trip request rejected | Background | Zero-trip Requester's active devices | `Join request declined` / trip name | Request status and locally authorized admin reason |
| First-trip request approved | Swiped away, not force-stopped | Zero-trip Requester's active devices | `Join request approved` / trip name | Newly joined trip summary |

For every positive case require:

- the exact action-first title, sanitized trip-name supporting line, one notification per eligible
  active installation, and sound/banner appropriate to the device state;
- no person name, email, amount, currency, note, expense details, rejection reason, or chat text in
  notification copy; the trip name is the only user-authored text allowed;
- a white monochrome **TS** status icon and the configured mint notification accent;
- `payloadVersion=1`, the exact `eventKey`, `eventType`, `tripId`, `sourceId`, target, and exactly one
  matching typed source key: `expenseId`, `messageId`, `paymentId`, `settlementId`, or `requestId`;
- correct authorized warm and cold-start navigation; repeated taps must not duplicate navigation;
- expected enqueue, recipient count, device count, ticket status, final receipt status, and measured
  sender-to-display latency on both devices.

## Negative and lifecycle matrix

Record each row independently as Pass, Fail, or Blocked.

| Case | Expected result |
| --- | --- |
| Pending settlement | No push |
| Cancelled budget confirmation | No push |
| Expense/payment/chat edits or deletes | No push |
| Cancelled join request | No push |
| Repeating an already-paid settlement update | No additional push |
| Actor performs the action | No self-notification |
| Former member | No notification after access removal |
| Non-admin observes a join request | No join-request-created notification |
| Idempotent retry of the same chat message | One outbox event and one delivery per installation |
| First rationale: **Not now** | No Android dialog and no repeated automatic rationale after restart/foreground |
| Profile/settings recovery | Granting in Android settings re-registers without reinstalling |
| One device logs out | Only the still-active installation receives |
| Logged-out device signs into another account | Token ownership moves; neither account receives the other's activity |
| Permission revoked then app foregrounded | Registration deactivates and delivery stops |
| Permission restored then app foregrounded | Registration becomes active and delivery resumes |
| Uninstall/reinstall one device | New installation receives once; stale token retires after `DeviceNotRegistered` |
| Device temporarily offline | Notification displays after connectivity returns |
| Android explicit Force stop | Record separately; do not classify suppression as a product failure |
| Old notification tapped while signed out | Authenticate, then continue to the authorized destination |
| Old notification tapped after trip access removal | Reject navigation safely without showing trip data |

Malformed payloads, Expo 429/5xx/auth failures, malformed ticket/receipt responses, delayed or
missing receipts, bounded retry, deduplication, and retry exhaustion belong in automated tests. Do
not damage or rotate live credentials to simulate them.

## Automated release gates

Run from the repository root unless the command changes directory:

```powershell
python -m pytest backend\tests\test_push_notifications.py backend\tests\test_notification_triggers.py backend\tests\test_join_requests.py backend\tests\test_chat_api.py backend\tests\test_chat_helpers.py backend\tests\test_chat_routes_unit.py backend\tests\test_payments.py backend\tests\test_settlements.py backend\tests\test_settlement_routes_unit.py -q
python -m pytest backend\tests -q
python -m pip check
Set-Location frontend
npm.cmd test -- --runInBand
npx.cmd tsc --noEmit
npx.cmd eslint app src
npx.cmd expo install --check
npx.cmd expo-doctor
npx.cmd expo config --type public --json
npx.cmd expo export -p web
```

Do not run production-data-mutating integration tests. The preview APK must be built from the exact
committed and pushed revision that passes these gates, with an incremented Android build number.

## First-failure triage

- No/skipped outbox event: verify the feature flag, business trigger, deployed revision, and event
  deduplication key.
- Zero deliveries: verify current membership or explicit request audience, active device ownership,
  token reassignment, and Android platform filtering.
- Ticket/retry/dead: align Expo enhanced security, access token presence, Firebase project, and FCM
  v1 credentials; use automated tests for retry behavior.
- `receipt_ok` without display: inspect channel importance, Android permission, Do Not Disturb,
  battery restrictions, package/Firebase match, and OEM settings.
- Display without correct navigation: inspect payload version/type/target, typed source ID,
  authorization result, cold-start handling, and duplicate-response suppression.

After any fix, repeat the two-device canary before resuming the matrix. Backend-only fixes deploy to
Render; client/native/config changes require a new traceable EAS preview APK.

## Release criteria

The test report must include redacted logs, screenshots, sender/receiver timestamps, latency,
outbox/ticket/receipt status, and defect/fix references for every case. Release and stable-download
promotion remain blocked by any missing positive notification, unexpected notification, duplicate,
privacy leak, wrong destination, actor notification, wrong audience, logout/permission leak, or
first-trip approval/rejection failure on either physical device.
