# Splitora combined release — Android build 29

Updated 20 November 2026. **Both branches are merged into main and the compatible backend
and website are live. APK 29 is built and verified as a candidate; public APK publication
is held by the live WebSocket close-response check.** The stable download still serves
[build 28](android-2026-11-20.md). Do not announce build 29 as published.

## Source and behavior

- Integrated `codex/splitora-launch-preview` at `2cc1f627e140028d7711901065a3b05e97c5a53c`
  and `codex/android-apk-20261120` at `b8644852ab6a0dc0971d2ab52b2a76b458cba17a`.
- Merge commits: `c7d8bf7` and `c96c9a7`; reviewed integration/APK source:
  `e8d8e8f26de945a45ce97f0d71809ba8634facde`.
- Backend/website source: `e746f5a83ab7b10e6762f72f239dbf3e0dff002a`. Its only change
  after the APK source is direct routing for the four policy/review web pages.
- Both branch heads and reviewed main `ab97b5a` are ancestors of main. Excluded saved
  UI commit `7bbee46c6a37f800507b68ce4d10a8798c058270` remains outside its ancestry.
- Preserved the reviewed group-deletion restriction, case-insensitive confirmation,
  financial calculations, direct gallery receipt attachment and eight permission exclusions.
  Conflict resolution retained the Community safety implementation from the launch branch.
- The chat safety shortcut moved inside the composer's existing bottom-clearance container.
  The regression test reproduced the original misplaced footer and passes with the fix;
  final native visual acceptance remains open.
- New/existing accounts review current terms and their real age group. Existing APKs receive
  a usable HTTPS review/update message. The website's Community safety route is live;
  users on older APKs can sign in there and complete review. Teen access still requires
  the existing guardian/operator process. No consent bypass was added.
- The recorded EmailJS interim authorization remains unchanged. No new hosting resource,
  account fixture, production-data test, real UPI transfer or Play Console action was performed.

## Completed verification

| Check | Evidence and limits |
| --- | --- |
| Frontend regression | 1,325 passed, 18 skipped; 147 suites passed, one skipped |
| Isolated backend regression | 1,684 passed, 2 skipped, 320 live-API cases deselected; separate client/API/payment scenarios were exercised with synthetic local data |
| Focused integration checks | Safety/terms compatibility, chat authorization, group-deletion behavior, footer placement and simulated payment journeys passed |
| Source checks | TypeScript, lint, Expo dependency check, Doctor 17/17 and backend pip check passed |
| Web export | 49 routes; final policy-routing correction verified against staged and promoted content |
| EAS archive | Canonical dynamic Expo configuration; private handoffs, environment/signing material, local native project and temporary outputs excluded |
| Build | EAS `18dab8fc-c606-4e39-8b2b-690b137248cf`, FINISHED; preview/internal APK, SDK 54 |
| Binary | `com.tripsplitter.app`, Splitora 1.0.0, version code 29; minimum API 24, target API 36; ARM64/ARMv7/x86/x86_64 |
| Bytes / SHA-256 | 132,317,528 / `061e4761aca3f5d68fb6bcff5ee12045f21c9b7120e60efe0650f0096aa28dae` |
| Signing | Existing direct-APK identity; SHA-1 `b23110170788618b0ee7153281d6334e62537c8b`; SHA-256 `fd894bfbeae599d7345c40dae91380cfc15dae6d4d58b5189d681881fa4fd91c` |
| Native checks | All eight camera/audio/storage permission exclusions; 54 ARM64/x86_64 libraries pass ELF/ZIP 16 KB alignment; release bundle selects hosted HTTPS, QA mode false |
| Backend | Render `srv-d8s120svikkc739442bg`, live deployment `dep-dc02r87f3r2c738hgv8g` at `e746f5a`; same-source redeploy after initial `dep-dc02c06c6qcc73av1a3g` |
| API compatibility | Health 200 at `e746f5a83ab7`, 97 OpenAPI paths, all earlier paths retained, 17 safety operations, unauthenticated safety reads 401; chat protocol 1, create protocols 1/1, settlement protocol 2 |
| Website | Vercel `dpl_BsG3k5BJBR6XnLx387rPpcq4TtjD`, READY/PROMOTED, source `e746f5a`; explicit production build supplies existing public Google IDs and HTTPS backend |
| Public pages | Homepage, privacy, terms, account deletion and Community safety each return 200 with distinct expected content; deletion page contains the support address |
| Public downloads | Both 307/no-store routes preserved: normal APK 28 and local QA APK 27. APK-29 GitHub release/asset is still a draft; no route promotion performed |
| Device | No physical device or emulator was available in the final ADB inventory. No phone app/data was modified and no APK-29 runtime acceptance is claimed |

Private logs and exact results are in `.release-tmp/main-integration-20261120/`, including
`frontend-all.json`, `backend-all.xml`, `verified-artifact.json`, `archive-audit.json`,
`live-backend-verification.json`, `coordinated-public-verification.json`, `web-status.json`
and `ws-path-isolation.json`. The consolidated document folder remains
`.release-tmp/play-store-handoff-20261120/`; reviewer credentials stay private there.

## Open release gate

The WSS connection upgrades successfully and server logs reject invalid/missing first-frame
authentication with intended code 4401. Local clients receive abnormal closure 1006 or time
out, with no close frame on the wire. This reproduces with Node's standard client, the `ws`
client, a raw TLS frame probe, both public Render addresses and a fresh same-source deployment.
An independent WSS echo service succeeds from this PC. The same application rejects with
4401 locally using both installed Uvicorn 0.49.0 and production-pinned Uvicorn 0.25.0.
These observations narrow the problem to the hosted transport path; they do not establish
the cause or prove working authenticated production chat. No speculative app/UI change
or weaker acceptance condition was introduced.

Owner: release engineer with hosting operator/Render support if needed. Required evidence:
the deployed endpoint must deliver close code 4401 for invalid first-frame auth and pass
`backend/scripts/verify_chat_deployment.py`, followed by authenticated chat acceptance on
the final native artifact. An independent phone/network probe can help isolate the path.
Do not publish another APK merely to investigate this backend transport problem.

## Finish and recover

1. Resolve the hosted transport gate and rerun the existing credential-free deployment
   verifier plus API/public-page checks. Preserve first-frame authentication and avoid
   production-data mutations. Inspect the existing deployment before another restart.
2. Publish the existing verified APK-29 draft asset after that gate passes. Reconfirm source,
   package, signer, size and checksum; do not start a duplicate EAS build without a code reason.
3. Change only `/download/android` from the verified build-28 asset to build 29, with temporary
   307/no-store behavior. Preserve `/download/android-qa` and all policy/review routes.
   Update `frontend/vercel.json`, verify anonymous complete download/checksum and homepage,
   then update the share message, release status and consolidated handoff manifest.
4. Complete physical ARM64 and Android-version acceptance: preserved-data upgrade, password
   sign-in, real age/terms review, groups, reporting/blocking, receipts, offline recovery,
   Google sign-in, notifications and external UPI handoff/return. Gallery selection/cancel,
   crop/upload/view, API 24–32 Save to folder and API 33+ Save to gallery remain mandatory.
   Provider credentials/configuration and appropriate devices are prerequisites; simulated
   tests and historical build-27 journeys are separate evidence.
5. Preserve app storage and pending writes during recovery. A higher installed version needs
   a compatible forward fix. Repointing a download cannot downgrade installed apps. Backend/
   web rollback needs schema/protocol compatibility and the HTTPS terms-review path; retain
   current safety/financial data and GridFS receipts. Do not reset/reseed production.
6. Actual Render auto-deploy is still enabled despite `render.yaml` recording a manual
   release intent. Documentation pushes use `[skip render]`; Vercel main auto-deployment is
   disabled in source. Recheck actual settings before future main pushes; do not assume
   editing the Blueprint changed the existing service.

Play publication remains pending a developer account, approved operating/teen procedures,
provider/device acceptance, signing/Console declarations, a fresh higher-code production AAB
and the account's required testing/review. This APK candidate is not a Play submission.
