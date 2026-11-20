# Splitora Play Store submission pack

Latest integration: both release branches are merged into main and the safety backend/web
are live at `e746f5a`. APK candidate 29 remains held by the hosted WebSocket close-response
check; stable download 28 is unchanged. [Current evidence and remaining release work](releases/android-1.0.0-build-29.md)
supersede earlier scope statements below. Listing/operator approval, providers/devices,
fresh production AAB and all Console gates remain pending.

Prepared 20 November 2026. **Draft for owner approval; Play enrollment and Console app creation are pending.**
This documentation milestone does not run app tests, create QA services/accounts, change the
application, build binaries or deploy services. The owner retained India, free, ad-free,
ages 13–15, 16–17 and 18+ with group chat and guardian controls.

Use [the launch register](PLAY_STORE_LAUNCH.md) for source, dated evidence and release status,
[the Console guide](PLAY_INTERNAL_TESTING.md) for publication order, and
[the hosting runbook](GLOBAL_LAUNCH_WIRING.md) for future provider/deployment work.
Prepared text is not a completed Console declaration or production approval.

## 1. Store listing draft

### App name

Splitora

### Short description

Split group expenses, track balances and settle up with friends and families.

### Full description

Splitora helps friends and families organize shared expenses in private groups.

Create a group, invite people and track who paid. Split each expense per person, per family
or by exact amounts. Record refunds, review balances and keep a clear payment history.

Choose your group's currency and record foreign-currency expenses with reviewed conversion
details. Attach existing receipt photos from your gallery and export PDF and Excel reports
for the group.

Use group chat to coordinate. In-app reporting, blocking and guardian controls support
community safety. Teen accounts require parent or guardian consent and verification review.

On Android, previously saved groups and same-currency expense/manual-payment entries support
offline use and server-confirmed synchronization. UPI handoff opens your selected payment
application, with payment reporting and recipient confirmation inside Splitora.

Splitora uses Gmail accounts. The initial launch is free and ad-free for people aged 13 and
over in India. Support and privacy requests can be sent to teamsplitora@gmail.com.

### Initial release notes draft

Welcome to Splitora.

- Track shared expenses with friends and families.
- Split costs per person, per family or by exact amounts.
- Review balances, record payments and export PDF or Excel reports.
- Attach existing receipt photos and coordinate through group chat.
- Manage community safety with reporting, blocking and guardian controls for teens.

Owner approval is pending. Match the final copy to the enabled, submitted application before
uploading; provider-dependent Google sign-in, push delivery and external UPI acceptance remain
unverified. These notes do not announce publication.

### Listing assets

The [asset pack](play-store-assets/README.md) contains a 512×512 icon, 1024×500 feature graphic
and six 1080×2400 mobile-web screenshot drafts. Preserve the manifest and source/checksum
provenance. The screenshots precede the final gallery-only correction and are not final
Android captures. Final screenshot selection/capture and owner approval remain pending;
do not relabel these drafts as native or Play-installed evidence. No new capture is scheduled
by this milestone.

## 2. App-content worksheet

| Console item | Prepared answer or action | Remaining owner input / evidence |
| --- | --- | --- |
| App identity | Splitora; Android `com.tripsplitter.app`; app, not game | Publisher legal identity, developer display name, category, default listing language and Console app record |
| Pricing / ads / distribution | Free, ad-free, India | Confirm final SDK inventory and actual Console country/pricing settings |
| Target audience | Ages 13–15, 16–17 and 18+ | Approve teen/guardian operations and applicable India requirements; apply the Console's Families/child-safety questions to the actual app |
| Content rating | Declare group chat, user interaction and user-shared receipt images honestly | Complete IARC; no rating is preselected |
| Privacy policy | Intended URL: `https://tripsplitter-web.vercel.app/privacy` | Deploy and inspect the actual signed-out policy content, publisher identity, provider/retention details and support contact |
| Account deletion | Intended URL: `https://tripsplitter-web.vercel.app/account-deletion`; signed-in impact review also exists in source | Deploy the actual outside-app page; assign request handling and approve retained shared-record purposes/process |
| App access | Reusable Gmail/password adult reviewer account and synthetic group, without a private workstation dependency | Populate the private handoff after a compatible hosted release is available; no credentials or reviewer account were created here |
| Data safety | Draft inventory below | Decide each collected/shared, required/optional, purpose, security and deletion answer against the final build and Google's definitions |
| Financial features | Assess expense management under **Other** and external UPI under **Payments and transfers** | Owner determines the exact applicable subcategories and personal/organization-account implications from the current Console policy |
| Government apps | Answer from the actual publisher/service | Do not infer this answer from financial features |

On 20 November the policy URLs returned the same main-site SPA document, while the deployed
web source was `ab97b5a`; this is not acceptance of the reviewed policy pages. The backend at
`ef2b25047745` exposed no Community safety paths. Source implementation and HTTP 200 alone
do not establish that the policy/safety release is live.

### Data safety draft inventory

| App data | Google form categories to assess | Purpose / processing / retention to disclose |
| --- | --- | --- |
| Name, Gmail, account identifiers, password hash and verification/session metadata | Personal info: name, email address, user IDs; assess authentication/security fields as applicable | Authentication, account security and shared-group identity; Gmail/password or Google sign-in |
| Optional mobile number and UPI address | Personal info: phone number; assess other personal/financial info for UPI address | Authorized group contact/payment handoff; optional profile fields; guardian-controlled sharing for teens |
| Groups, members/families, expenses, allocations, balances, settlements and payment evidence | Financial info: other financial info; app activity / user-generated content as applicable | Shared expense reconciliation and reports; shared records can survive account deletion |
| Receipt images | Photos and videos: photos | User-selected upload, shared-group viewing and moderation; persistent MongoDB GridFS storage; no camera acquisition |
| Group text chat | Messages: other in-app messages | Private group conversation, blocking, reporting and moderation; account deletion can leave de-identified shared history |
| Age band, accepted terms, guardian relationship/consent and safety cases | Personal info / app activity / other user-generated content as applicable | Eligibility, consent and abuse handling; the app records age bands, not a birth-date collection flow |
| Push token and installation registration | Device or other IDs | Optional Android notifications through Expo and Firebase; account ownership and logout/revocation lifecycle |
| Operational audits and actual diagnostics | App activity / app info and performance as applicable | Security, reconciliation and service operation; confirm actual hosting/native SDK collection before selecting diagnostic categories |

Providers to assess include Render, MongoDB Atlas, Vercel, Google OAuth, backend-only EmailJS,
Expo Push Service and Firebase Cloud Messaging. User-initiated external UPI handoff and
user-exported reports also need assessment under the form's exact definitions. Do not treat
every transfer as third-party sharing automatically, or claim no sharing simply because a
provider is described as infrastructure. Record any applicable service-provider or
user-initiated-sharing exception and its basis.

Do not claim that Splitora collects bank passwords, UPI PINs, card numbers or continuous
photo-library access. Confirm the final SDK/permission inventory before finalizing exclusions.
Resolved safety reports have a 90-day TTL; the confirmed Android cache has an existing
30-day policy; unresolved local actions remain for same-account recovery. Shared ledger,
receipt, backup and external support retention require the owner's approved process.

Internal-only apps currently have a Data safety form exemption. Keep this worksheet ready
for tracks requiring the form; the exemption does not remove policy/security obligations.

## 3. Reviewer access handoff

All required handoff documents and listing-asset copies are collected locally under
`.release-tmp/play-store-handoff-20261120/`; open `START_HERE.md` there. Public source documents
remain canonical in this repository. The local copy, manifest and private access file are
excluded from Git and EAS uploads. Refresh the local snapshot from the committed source;
do not overwrite owner-populated private access notes.

The private template is `.release-tmp/play-store-handoff-20261120/REVIEWER_ACCESS_PRIVATE.md`.
It contains placeholders only. Populate it privately when the final hosted application and
Console app exist. Do not copy the local QA accounts, USB instructions, moderator password,
bearer tokens or provider keys into Console access notes or tracked files.

Prepared navigation instructions, to reconcile with the final submitted build:

1. Open **Splitora**, package `com.tripsplitter.app`, and choose Gmail/password sign-in using
   the reviewer credentials supplied privately in Console App access.
2. Use the designated adult account. Its current terms/age review and any required account
   setup must be completed or clearly explained in the private instructions. Google sign-in
   and access to a private email inbox must not be the only way to enter the app.
3. Open the synthetic review group recorded privately. Its sample expenses, linked people,
   receipt and chat content must be available through the hosted API without ADB or USB.
4. Review Expenses, Balances, Members, Chat, receipt viewing/saving and PDF/XLSX export.
   Use Profile → Community safety for blocks and the policy links.
5. Read the in-app deletion impact and outside-app request page. A separate sacrificial
   account is needed for destructive deletion review; keep the primary reviewer account
   usable throughout review.
6. UPI handoff requires an installed supported payment app. No real transfer is authorized
   by this milestone; never supply bank credentials/PINs or imply that returning from a
   payment app proves settlement. Financial posting follows the app's confirmation rules.

Reviewer accounts should have ordinary group roles. Moderator access remains private to the
existing application administrator; there is no review-only authorization bypass. Record
availability/contact instructions and avoid short-lived credentials, expiring invitation
links or one-time codes as the sole access path.

## 4. Ordered owner-action register

All entries below are pending unless a dated completion record is added to the launch register.
Role labels assign responsibility; named people and acceptance dates have not been supplied.

| Order / ID | Owner | Completion criterion |
| --- | --- | --- |
| 1 / PUBLISHER | Account holder | Choose the applicable account type, pay the one-time US$25 enrollment fee, complete identity/contact/device verification and record account/app/eligibility details |
| 2 / OPERATIONS | Product owner | Name primary/backup support and moderation coverage for teamsplitora@gmail.com and the existing super-admin queue; approve escalation, deletion and recovery procedures |
| 3 / TEENS / RETENTION | Product owner + qualified India reviewer | Approve applicable rule commencement, adult/guardian verification, consent/withdrawal, evidence handling and retained shared-record purposes/process |
| 4 / SIGNING | Account holder + release engineer | Choose signing continuity before first upload; reconcile direct APK, upload and Play app-signing certificates and any recovery consequences |
| 5 / PROVIDERS | Owner, following the hosting runbook | Supply the correct production Google/Firebase/EAS configuration privately; record provider acceptance separately from configuration |
| 6 / COORDINATED RELEASE | Release engineer | Review/integrate the approved source and prepare policy/review/update routes before mandatory review enforcement; retain rollback records and protect APK-24 users |
| 7 / BUNDLE | Release engineer | When separately authorized, build a fresh production AAB from reviewed, committed/pushed source; record final checks and version/signing/permission/16 KB evidence |
| 8 / LISTING / ACCESS | Product owner + account holder | Approve listing/real Android images, final declarations and usable private reviewer access |
| 9 / ELIGIBILITY | Account holder | Complete the actual Console track/production-access requirements, including 12 continuously opted-in testers for 14 days where applicable |
| 10 / PUBLISH / OBSERVE | Account holder + operating owners | Obtain release approval, publish to India and record 72 hours of support/moderation/vitals coverage and recovery ownership |

The no-new-QA instruction applies to this documentation milestone. Mandatory Console testing
and the remaining release-evidence gaps stay visible as future publication prerequisites.
No new hosting spend, EmailJS plan/provider change or paid EAS upgrade is authorized here.

## 5. Documentation acceptance and references

The pack is ready for owner review when source/artifact/status tables agree across the linked
guides, listing text fits the current Console limits, local document links resolve, credentials
are absent from tracked changes, and each pending owner action has a completion criterion.
This is documentation acceptance, not app, provider or publication acceptance.

Official references: enrollment, personal-account testing, financial features, target API and
signing were re-read during planning on 20 November 2026. The other policy references retain
their 12–14 November review date. Recheck actual Console requirements when the account is
created and before submission:

- [Enrollment and US$25 fee](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en)
- [Developer account types](https://support.google.com/googleplay/android-developer/answer/13634885?hl=en)
- [Personal-account testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
- [Financial features](https://support.google.com/googleplay/android-developer/answer/13849271?hl=en)
- [Target API: new phone/tablet submissions require API 36 from 31 August 2026](https://support.google.com/googleplay/android-developer/answer/11926878?hl=en)
- [Play App Signing](https://support.google.com/googleplay/android-developer/answer/9842756?hl=en)
- [Data safety](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
- [Account deletion](https://support.google.com/googleplay/android-developer/answer/13327111?hl=en)
- [User-generated content](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)
