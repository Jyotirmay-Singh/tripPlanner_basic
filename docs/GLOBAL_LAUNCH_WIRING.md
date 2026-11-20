# Splitora production hosting and provider handoff

## Latest coordinated deployment — 20 November 2026

Both release branches are merged into main. Backend and website now use `e746f5a`, following
reviewed APK source `e8d8e8f`. Render deployment `dep-dc02r87f3r2c738hgv8g` is live and Vercel
`dpl_BsG3k5BJBR6XnLx387rPpcq4TtjD` is READY/PROMOTED. The API has 97 paths, all 17 safety
operations and compatible create/chat protocols. Public privacy, terms, deletion and
Community safety pages return their distinct content. Existing users can review current
age/terms on the website. GridFS remains the persistent receipt store.

APK 29 remains a verified candidate: hosted WSS auth upgrades/rejects server-side but clients
receive no close frame/code 4401. Publication is held; stable downloads remain APK 28 and
local QA APK 27. [The integration report](releases/android-1.0.0-build-29.md) records diagnostic
evidence, exact artifact identity, recovery and completion steps. A same-source redeploy did
not fix the transport check. No provider credentials, production fixtures or paid resources
were changed. Preserve the EmailJS interim decision below.

Actual Render auto-deploy remains enabled; source `autoDeploy: false` has not changed that
existing service setting. Main documentation pushes carry `[skip render]`. Vercel main Git
deployment is disabled in source and the reviewed website was promoted explicitly. Future
pushes must recheck actual deployment controls. Earlier observations below are historical.

Later direct-APK update: [build 28](releases/android-2026-11-20.md) is published with the
existing HTTPS backend and current main-based flow. Its binary/public-download checks do
not complete the future safety/provider, device or Play gates described below. The earlier
documentation-only scope statements refer to the preceding handoff milestone.

Updated 20 November 2026. This runbook records the existing services and remaining owner
steps for a future production release. The current milestone changes documents only: no
app tests, QA services/accounts, provider settings, builds or deployments.
Use [the launch register](PLAY_STORE_LAUNCH.md) for dated evidence and
[the submission pack](PLAY_STORE_SUBMISSION_PACK.md) for listing/declaration drafts.

## 1. Existing services and observed state

| Service | Existing target | Observation during 20 November planning |
| --- | --- | --- |
| FastAPI | `https://tripsplitter-api.onrender.com`; Render `tripsplitter-api`, `srv-d8s120svikkc739442bg`, workspace playingArea | Free Docker service in Singapore, one instance, linked to main; live source `ef2b250477453b4503c6c04649ea996cbe1fb98d`, deployment `dep-dboankijnfac73ebq7a0` |
| Web | `https://tripsplitter-web.vercel.app`; Vercel `tripsplitter-web`, `prj_hpWQjLfXAt9fp8413lCipbjDE10L` | READY production deployment `dpl_EAboF8JRN9a1oTgY9Y4sscXycRxa`, source main `ab97b5a5430650674700d55e5c95f205b93849d8` |
| Database / receipts | Existing MongoDB Atlas cluster; private Render `MONGO_URL` and `DB_NAME` | Credentials, access rules and backups were not inspected or changed; receipts use persistent GridFS, not the Render filesystem |

Public API observations: health HTTP 200 at revision `ef2b25047745`, chat protocol 1,
expense/payment create protocols 1/1, email/invitations/multi-currency enabled and
expense-settlement activation disabled. OpenAPI had no Community safety paths. The reviewed
safety/policy release is not established in production. A main-site SPA HTTP 200 at
`/privacy`, `/terms` or `/account-deletion` is not acceptance of the reviewed pages.

The verified Vercel CLI could inspect the intended project, deployments and variable names;
only `EXPO_PUBLIC_BACKEND_URL` was listed for Production. The connector returned a scope-access
error. Use the verified CLI/project context or owner reconnection for future work; do not
select a different project silently. Reconfirm Render workspace playingArea and service identity.

### Capacity and persistence

- Render Free sleeps after 15 idle minutes; cold starts take about a minute. Its 750 monthly
  running hours are shared across the workspace's free web services. Exhaustion suspends
  those services until reset. Monitor included bandwidth/build usage as well.
- Free Render has an ephemeral filesystem and no persistent disk. Keep receipts in MongoDB
  `receipts.files` / `receipts.chunks`. A restart must not require reuploading receipts or reseeding.
- Keep one worker/instance: current chat fan-out and email pacing are process-local. Scaling
  needs a separately reviewed shared coordination design.
- Atlas Free currently has 0.5 GB shared document/index storage, including receipt data.
  The owner must confirm actual tier, capacity, transaction support and backup availability;
  do not assume a free automated backup or expose database URIs during diagnosis.
- Preserve the existing Atlas network policy. Future access changes need the intended
  service's current egress information and owner-approved credentials; do not widen access
  as an automatic troubleshooting step.

No new hosting spend, QA database, paid compute/disk, EmailJS plan change or EAS upgrade is
part of this milestone. Play enrollment's one-time US$25 fee is a separate owner action.

### Future read-only service observations

From the repository root, when release work resumes:

```powershell
& 'C:\Users\JYOTIRMAY\.headroom\bin\rtk.exe' proxy curl.exe --fail https://tripsplitter-api.onrender.com/api/health
& 'C:\Users\JYOTIRMAY\.headroom\bin\rtk.exe' proxy curl.exe --fail https://tripsplitter-api.onrender.com/api/meta/config
```

Health is deliberately DB-free. Require startup transaction readiness and compatible protocols
in addition to liveness; health does not establish database, OAuth, inbox or push acceptance.

## 2. Coordinated release prerequisites

1. Review the main-based readiness source and preserve the approved deletion/gallery fixes
   and excluded-commit boundary. Root `render.yaml` targets production. Changing it, merging
   readiness work or pushing main can trigger production actions.
2. Prepare signed native delivery plus working public policy, terms-review and update routes
   for existing APK-24 users before mandatory review enforcement. The reviewed Community safety
   requirement has no separate deployment flag; do not invent one in the handoff or assume
   a backend-only rollout will leave older clients usable.
3. Record final source/checks, service/configuration identities, previous compatible deployments,
   artifact/signing identifiers, database recovery point and named operator. Keep secret values
   only in their intended private stores.
4. Deploy compatible backend/protocol changes before promoting a dependent client, while
   satisfying the older-client review/update prerequisite. Confirm actual signed-out policy
   content and the outside-app deletion contact, not just HTTP status.
5. Retain the existing credential-free chat deployment gate for future release verification:
   health revision/protocol; all five REST paths; unauthenticated send returns 401; WSS upgrade
   followed by invalid first-frame auth closes with 4401. Use
   `backend/scripts/verify_chat_deployment.py` through RTK when separately authorized. The
   safety release also needs all 17 reviewed Community safety operations. No verifier or
   application journey is run by this documentation milestone.

The [Console guide](PLAY_INTERNAL_TESTING.md) owns fresh AAB/signing/version-code requirements.
The production configuration must resolve to `com.tripsplitter.app` and the existing HTTPS API,
without the QA variant or local-HTTP plugin.

## 3. EmailJS — preserve the authorized interim rollout

[EMAIL_SETUP.md](EMAIL_SETUP.md) is authoritative for the decision and inbox evidence.
On 4 November the owner authorized automatic verification/password-reset email despite the
known Origin-bearing-request private-key bypass, while awaiting EmailJS support. Production
`email_features_enabled=true` was observed again on 20 November. This does not establish that
provider authorization is fixed or that a fresh inbox journey was performed.

Keep non-browser/private-key settings enabled and include the private key in every backend
send. Keep all EmailJS identifiers/credentials server-side. Preserve hashed, expiring,
single-use tokens, MongoDB transactions, cooldowns/rate limits and sanitized logging.
Action links use trusted HTTPS `APP_URL`, fragments and explicit confirmation. Never log
links or restore the retired link-logging fallback. Resend variables are retired; no
sending-domain purchase or provider migration is required by this handoff.

The 200-message monthly free allowance, Gmail connection, provider support response and
plain-text MIME evidence remain operating items. Retain dated delivery observations; do not
send additional probes/emails from this milestone.

## 4. Google OAuth — owner configuration for the production package

The owner will configure the existing Google Cloud project when provider/release work resumes.
Its current access and console settings were not verified here.

| Public identifier | Configured value / purpose |
| --- | --- |
| `EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID` | `307368957277-58jdf9opq70e195gm5n1pcf4ucfd7rlt.apps.googleusercontent.com`; Web and Android Credential Manager token audience |
| `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` | `307368957277-19ho7nrl2drsdvkahh7nkqpi6f2tag9h.apps.googleusercontent.com`; existing iOS/plugin configuration |
| Android registration | Exact `com.tripsplitter.app` package and certificate signing the installed application; a separate client entry for each package/certificate pair |

1. In the project owning the Web client, reconcile the direct-EAS SHA-1 recorded in
   [the APK guide](ANDROID_APK.md) and, once chosen, Play's actual app-signing SHA-1. The
   build-27 QA signer or a debug signer is not a substitute for Play's certificate.
2. Android uses `react-native-nitro-google-signin` / Credential Manager and sends the Web-audience
   ID token to `POST /api/auth/google`. No Android OAuth redirect URI, runtime Android client-ID
   variable or client secret is required by this flow.
3. Keep that exact Web audience in Render `GOOGLE_CLIENT_ID`, preserving other intended audiences
   during a reviewed rollout. Inspect OAuth consent/branding/publication and any required Google
   test-user access; client IDs alone do not establish provider access.
4. For web sign-in, authorize `https://tripsplitter-web.vercel.app` as a JavaScript origin and
   register the exact redirect URI produced by the actual AuthSession flow. Do not add
   wildcard redirects or infer native redirects from the web flow.
5. Supply the same public Web client ID in the intended Vercel Production build environment
   when authorized. Public variables are inlined at build time, so a new deployment is required.
   Use the dashboard or BOM-free input and preserve unrelated variables.

Native Google sign-in, cancellation/retry and first-user password setup remain unverified
on the final Play artifact. No new provider journey is scheduled here.

## 5. Firebase and Android notification prerequisites

1. Register Android **`com.tripsplitter.app`** in the intended Firebase project; record its ID/
   number and reconcile relevant signing SHA-1/SHA-256 values, including the chosen Play signer.
   The actual Firebase project is still unidentified; do not infer it from an OAuth prefix alone.
2. Download that exact package's client configuration and supply the EAS **production file
   environment variable `GOOGLE_SERVICES_JSON`**, outside Git. Canonical dynamic Expo config
   includes `android.googleServicesFile` only when supplied; QA mode deliberately omits it.
   A QA JSON file is not the production configuration.
3. Enable FCM v1 and provision its matching Android service-account credential in the intended
   EAS project/package context. The client JSON and FCM v1 credential must refer to the same
   Firebase project. Keep the service-account private key in EAS credentials, outside source,
   release notes and mobile/browser bundles.
4. Preserve EAS project `0a3b5a1c-5cbd-4eac-bff7-5b53ee4b6948`, notification plugin, channel and
   icon configuration. Native Firebase configuration needs a new traceable native build;
   a backend restart cannot add it to an installed app.
5. Align Expo enhanced push security with backend `EXPO_PUSH_ACCESS_TOKEN`: both enabled/
   configured or both disabled/unset. Keep the token server-side. Enable
   `PUSH_NOTIFICATIONS_ENABLED` only through the coordinated provider rollout.
6. Android 13+ eligibility/permission, registrations, Expo tickets/FCM receipts, display and
   authorized tap routing remain separate acceptance items in
   [the notification runbook](ANDROID_NOTIFICATION_QA.md). Only one physical phone is currently
   available; no two-device result is claimed or scheduled here.

Preserve direct gallery attachment and all eight receipt permission exclusions. Notification
configuration does not justify restoring camera, microphone or broad storage/media access.

## 6. Recovery and release record

Primary/backup operating owners remain unassigned. The product owner must name them before
an unattended launch. Future operator procedure:

1. Identify the failing service and exact deploy/configuration revision. Distinguish a Free
   cold start or exhausted allowance from a failed deployment. Inspect the existing deployment;
   do not create duplicate services/builds or automatically upgrade plans.
2. For API restart, use the existing Render service's restart/redeploy action when authorized,
   preserve secrets/database and wait for completion. Confirm expected revision, startup
   transaction readiness and protocols. Local QA launchers are not production recovery.
3. Select only a recorded compatible backend/web rollback revision that can read current
   financial/safety data and retain the review/update route. Do not roll back blindly across
   schema/protocol changes; the previous live revision is not universal rollback approval.
4. Use an owner-approved coherent database recovery point, including linked ledger/idempotency
   records and GridFS files/chunks. Confirm backups before promising recovery. Never wipe or
   reseed production, or restore old authentication/session state without assessing revocation
   and consistency consequences.
5. For email incidents, an authorized operator can disable `EMAIL_FEATURES_ENABLED`, deploy
   the configuration and confirm its public flag. Provider abuse also needs provider-side
   action; the flag does not revoke templates. Disabling push dispatch must retain durable
   outbox/retry evidence.
6. Preserve previous verified download targets and source redirects. A direct-APK redirect can
   return to a retained verified artifact; installed higher versions need a compatible higher-code
   fix. Never clear storage/uninstall to force a downgrade or lose unsynced actions. Use Console
   release controls for Play and submit a higher-code recovery bundle when needed.

The final private handoff records source/check results and skipped/unverified items; service/
deployment IDs and configuration names/flags; database recovery ownership; artifact/version/
checksum/signing/permission/alignment evidence; redirect/Console state; and named operating
coverage. Keep credentials/private recovery material in ignored handoffs or provider stores.
Preserve the EmailJS interim decision and all dated historical evidence.
