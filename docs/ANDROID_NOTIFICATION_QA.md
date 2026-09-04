# Android Notification QA

Use this checklist to verify the real Expo/FCM delivery path after the automated notification
tests pass. Remote push acceptance requires an installable app build and a physical Android device;
Expo Go is not a valid substitute.

## Expected permission behavior

- Notification support is Android-only.
- An account with no trips is not asked about notifications.
- On Android 13 or newer, the first eligible account with undecided permission sees the app's
  **Stay updated on your trips** rationale. Android's system dialog appears only after
  **Enable notifications** is pressed.
- **Not now** is remembered and suppresses later automatic prompts. Profile then shows
  **Enable notifications**.
- A denied system permission changes the Profile action to **Notification settings**, which opens
  the app's Android settings page.
- Android 12 and older normally have notification permission granted without the Android 13
  runtime dialog. Treat this as an optional compatibility smoke test, not a prompt failure.

## Preconditions

- Build from `frontend/` with the EAS `preview` profile. Do not use the obsolete root Expo config.
- Confirm the build uses package `com.tripsplitter.app`, the intended EAS project, the hosted API,
  and a valid EAS file variable for the Firebase `google-services.json` file.
- Confirm FCM v1 credentials are attached to the EAS project and the hosted backend has push
  delivery enabled. Configure the Expo access token only when enhanced push security is enabled.
- Use a physical Android 13+ receiver and two dedicated test accounts in one isolated test trip:
  **Actor** creates activity from web, while **Receiver** is signed in on Android.
- Record the APK build ID/version, device model, Android version, test accounts' non-sensitive
  labels, and start time. Never record bearer tokens, Expo push tokens, credentials, or database
  connection details.

## Permission sequence

Uninstalling the app is the most reliable reset because it clears both Android permission and the
app's stored one-time rationale choice. Clearing app storage plus resetting Notifications under
Android app settings is also acceptable.

### Cycle A: decline and recover

1. Fresh-install the APK and sign in as Receiver while that account has no trips.
2. Confirm no notification rationale or Android permission dialog appears.
3. Add Receiver to the test trip, then open that trip.
4. Confirm the private rationale appears once. Verify it covers expenses, recorded payments, paid
   settlements, and group messages and says names, amounts, and message text are not shown on the
   lock screen, then press **Not now**.
5. Background and reopen the app. Confirm neither the rationale nor the system dialog repeats.
6. Open Profile and confirm **Enable notifications** is present.
7. Press it, deny Android's notification dialog, and confirm Profile changes to
   **Notification settings**.
8. Press **Notification settings**, enable notifications in Android settings, and return to the
   app. Confirm the Profile notification row disappears after the permission state refreshes.

### Cycle B: accept immediately

1. Uninstall/reinstall the same APK; keep Receiver in the test trip.
2. Sign in, wait for trip eligibility to load, and confirm the rationale appears.
3. Press **Enable notifications**, confirm Android's system dialog appears, and press **Allow**.
4. Confirm the rationale and Profile action do not reappear on later foreground launches.

## Delivery and routing matrix

Allow up to two minutes for each hosted push. Run one event at a time and record sender time,
receiver time, app state, visible copy, sound/banner behavior, and tap destination.

| Case | Receiver state | Actor action | Expected result |
| --- | --- | --- | --- |
| Foreground expense | Trip Splitter open | Create an expense | Exactly one banner/list entry with sound; tap opens that trip's Expenses tab |
| Background message | App in background | Send a group message | Exactly one notification; tap resumes the app on that trip's Chat tab |
| Terminated payment | App swiped away, not force-stopped | Record a payment | Exactly one notification; cold-start tap opens Settle Up |
| Paid settlement | App in background | Create or mark a settlement paid | Exactly one notification; tap opens Settle Up |
| Pending settlement | Any | Create a pending settlement only | No notification |
| Unconfirmed budget action | Any | Reach confirmation without saving | No notification |
| Actor exclusion | Receiver performs a financial action on Android | Create an expense/payment | Receiver gets no notification for their own event |
| Invalid duplicate tap | Tap the same delivered notification repeatedly | None | One destination is opened; no duplicate navigation stack entry |

For every delivered notification, confirm:

- Title is **Trip Splitter**. The body identifies only the activity class: **A new expense was added
  to one of your trips.**, **A payment was recorded in one of your trips.**, **A settlement was
  marked paid in one of your trips.**, or **A new group message was sent in one of your trips.**
- The lock screen exposes no trip name, member name, amount, currency, note, expense details, or
  message text.
- It uses the **Trip activity** channel with private lock-screen visibility.
- Only current trip members receive it, and each registered installation receives at most one copy.
- The private data payload carries `payloadVersion`, `eventKey`, `eventType`, `tripId`, `sourceId`,
  and exactly one matching `expenseId`, `paymentId`, `settlementId`, or `messageId`.

## Registration lifecycle

1. With permission granted, log Receiver out and wait for logout to finish.
2. Have Actor create a new expense. Confirm Receiver's installation receives no notification.
3. Sign Receiver back in, foreground the app, and have Actor create another expense.
4. Confirm delivery resumes without reinstalling the app.
5. Revoke permission in Android settings, return to the app, and confirm no notification is
   displayed. Restore permission through Profile/Android settings and confirm delivery recovers.

## Automated release gates

Run from the repository root unless a command says otherwise:

```powershell
python -m pytest backend\tests\test_push_notifications.py backend\tests\test_notification_triggers.py -q
cd frontend
npm.cmd test -- --runInBand
npx.cmd tsc --noEmit
npx.cmd eslint app src
npx.cmd expo install --check
npx.cmd expo-doctor
npx.cmd expo export -p web
```

The APK is ready for device QA only when these gates pass and the preview EAS build finishes for
the expected package/project and source revision.

## Evidence and triage

Store screenshots and a redacted result summary under `test_reports/`. Include each case as
Pass/Fail/Blocked plus delivery latency and a defect link where applicable.

- No app rationale: check sign-in, trip eligibility, and stored rationale state.
- No Android system dialog: check Android version and current OS permission state.
- No device registration: check project ID, Firebase file, FCM credentials, API reachability, and
  authenticated `PUT /api/push/devices/{installation_id}` completion without exposing its token.
- No outbox event: check the expense/payment/settlement/chat trigger and backend push feature flag.
- Event exists with zero deliveries: check current trip membership, Android permission, and the
  active device registration count recorded by `push.delivery_snapshot`.
- Expo ticket/receipt failure: check enhanced-security token and FCM credential alignment.
- Delivered but not displayed: check Android permission, channel settings, Do Not Disturb, and
  vendor battery restrictions.
- Wrong destination: compare the versioned event/type/source identifiers and target against the
  notification routing tests and the `navigation_completed`/`navigation_rejected` client log.

Any privacy leak, duplicate notification, actor self-notification, wrong-trip navigation, missing
logout deactivation, or failure of the Android 13 permission recovery path blocks release.
