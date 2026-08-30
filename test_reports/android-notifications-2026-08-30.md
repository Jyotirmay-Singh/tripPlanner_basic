# Android Notifications Test Report — 2026-08-30

## Outcome

| Area | Status |
| --- | --- |
| Android permission/registration automation | Pass |
| Notification backend automation | Pass |
| Frontend regression gates | Pass |
| Expo configuration/build readiness | Blocked |
| Physical Android 13+ permission and delivery QA | Blocked |

The implemented behavior does ask eligible Android users to enable notifications. On Android 13+
it first shows the app rationale, and Android's system prompt follows only after the user presses
**Enable notifications**. Accounts without trips are not prompted. **Not now** suppresses later
automatic prompts and leaves a manual action in Profile.

## Automated evidence

| Check | Result |
| --- | --- |
| Android notification and routing Jest tests | 27 passed across 4 suites |
| Full frontend Jest suite | 536 passed across 73 suites |
| Backend push and trigger pytest suites | 21 passed |
| TypeScript (`tsc --noEmit`) | Pass |
| Tracked frontend ESLint (`eslint app src`) | Pass |
| Python package consistency (`pip check`) | Pass |
| Expo SDK dependency compatibility | Pass — dependencies up to date |
| Production web export | Pass — 34 static routes exported |
| Hosted API health | Pass — HTTP 200 |
| Hosted web sender | Pass — HTTP 200 |

The Android-specific automated coverage verifies:

- No prompt or registration before the account has trip access.
- One-time private rationale behavior for **Not now** and **Enable notifications**.
- Granted, denied, undecided, unavailable, offline, and missing-EAS-project states.
- Android settings recovery, foreground resynchronization contract, concurrency deduplication,
  stable installation registration, and best-effort logout cleanup.
- Profile row visibility, labels, busy-state duplicate-press protection, and post-grant hiding.
- Cold/warm response routing, authentication deferral, invalid payload rejection, duplicate response
  suppression, AppState retries, and listener cleanup.
- Backend target validation, active-token reassignment races, recipient/token deduplication, private
  payloads, successful receipts, retry exhaustion, trigger idempotency, and actor exclusion.

## Configuration evidence

- Resolved Android package: `com.tripsplitter.app`.
- Expo notifications plugin and `trip_activity` default channel are configured.
- The generated notification asset is PNG-compatible.
- `POST_NOTIFICATIONS` is declared by the Android notification dependency.
- Preview uses internal distribution, APK output, remote versioning, and automatic build-number
  increments.
- EAS authentication and preview build history are accessible.
- The newest existing APK was built before the notification implementation and is not valid
  evidence for this feature.

## Blockers

1. Expo Doctor passes 16 of 18 checks. It reports that the dynamic Expo config does not consume the
   static config even though `app.config.js` explicitly loads `app.json`; this needs a deliberate
   config-structure resolution rather than an unreviewed edit to the current dirty file.
2. Expo Doctor reports `react-native-nitro-google-signin` as untested on the enabled React Native
   New Architecture. The project must either document/exclude this known-compatible dependency or
   choose a supported architecture/library change.
3. The worktree contains many unrelated, pre-existing uncommitted UI and configuration changes.
   The Android release workflow requires an approved commit pushed before EAS builds, so building
   the current mixed source would not be traceable.
4. No physical Android 13+ receiver or dedicated hosted test accounts were available in this
   workspace. Permission dialogs, FCM delivery, lock-screen privacy, sound/channel behavior,
   background/cold-start delivery, and tap navigation therefore remain unverified on-device.
5. The hosted backend's push feature flag and EAS Firebase file-variable presence are intentionally
   not exposed by public health checks and were not inferred from secret values.

## Device cases remaining

Follow `docs/ANDROID_NOTIFICATION_QA.md` with a newly approved preview APK. All permission cycles,
foreground/background/terminated delivery cases, privacy checks, actor exclusion, negative trigger
cases, logout/re-login lifecycle checks, and Android settings recovery remain **Blocked**, not
failed. Do not release based on automated results alone.
