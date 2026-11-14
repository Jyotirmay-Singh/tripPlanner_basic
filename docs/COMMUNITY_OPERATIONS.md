# Splitora community and privacy operations

Draft operating procedure for the India, free, ad-free, ages-13+ launch. Product-owner
acceptance and an India privacy review are launch gates. Implemented controls and test
results do not establish statutory compliance. Deployment readiness depends on the owner,
device and compatibility gates in the shared launch handoff.

## Ownership and readiness evidence

The product owner must name a primary and backup operator for `teamsplitora@gmail.com`,
the application administrator's moderation queue, guardian verification and deletion
requests. Record the names, coverage, escalation contact and acceptance date in the launch
handoff. Review proposed response targets before publishing them: urgent safety reports
immediately when received; ordinary reports and privacy requests within one business day
for acknowledgement, followed by a case-specific completion date.

Operators use their own authenticated accounts. The server grants moderation only to the
configured application super-admin identity. Group owners/admins do not gain access to
the global moderation queue. Do not put access credentials, personal identity-document
images, bank credentials or UPI PINs in case notes, email or the repository.

## Guardian verification and consent

1. The teen declares ages 13–17 and accepts the current terms. Group access remains blocked.
2. The teen creates a seven-day private code for their intended guardian's Gmail. The
   guardian signs into their own account, declares adulthood, accepts the current terms
   and verifies that Gmail. The guardian reviews the teen's request, confirms the legal
   relationship and explicitly chooses chat, receipt and contact-sharing permissions.
3. The operator completes an **owner-approved adult-identity and guardian-relationship
   verification method**, records the evidence in the approved restricted verification
   system and enters only its case reference in Moderation. Email verification and an
   adulthood declaration alone do not establish adulthood or a guardian relationship.
4. The operator checks the intended guardian, current terms, verification outcome and
   selected permissions before approving. A typed case reference is an audit pointer;
   the application does not independently verify external identity evidence.
5. The guardian can change each sharing permission or withdraw all account consent.
   Withdrawal blocks new group access and closes live chat connections. Server checks
   govern subsequent requests. An offline device can retain its previously confirmed
   local state until it reconnects; operators must account for this limitation.
6. Changed terms, expired requests, changed guardian eligibility and withdrawn consent
   require renewal. Support handles guardian replacement and audited age correction.
   Age correction resets terms and consent; the account must complete the resulting
   eligibility journey again. Under-13 accounts retain support and deletion access.

Before enabling teen production access, the owner must record the applicable Indian
child-data rule commencement, lawful verification method, notice/consent wording,
withdrawal/erasure handling and evidence-retention decision. Obtain a qualified review
of the actual workflow. The current manual review must not be described as a certified
verification service. No guardian can be approved merely to bypass this launch gate.

## Reports, blocking and appeals

1. Open **Community safety → Moderation queue** with the application administrator account.
   Review open cases and failed actions awaiting retry, oldest first, with urgent child
   safety, threats and disclosure of private information escalated immediately under the
   approved safety procedure and applicable reporting duties.
2. Review the report's message snapshot or **reported receipt revision**. Receipt replacement
   may remove that revision. If unavailable, record that limitation and seek appropriate
   support evidence; never treat a replacement image as the reported content.
3. Record a meaningful explanation and dismiss, remove the reported content or suspend
   posting. Receipt removal hides the reported revision without altering financial
   amounts. Message removal removes text. A suspension stops posting and revokes live
   chat; retained shared financial evidence remains available under the access policy.
4. On a failed action, refresh and retry the recorded pending action. Do not select a new
   action until the pending one completes. The case retains its moderator and resolution.
5. A user's block filters chat in both directions, including history, unread counts,
   realtime events and pending chat pushes. It does not erase shared expenses or settle
   balances. Users can unblock through Community safety.
6. Receive appeals at the support inbox, verify the claimant, review the original case
   and document the decision. Use **Restore community posting after appeal** only after
   review. Restoration is audited. Account switching clears the moderation screen and
   cancels its pending requests.

Confirm daily queue coverage and verify the outcome from an ordinary account after each
urgent action. The release gate includes a rehearsal of reporting, blocking, removal,
retry, suspension and appeal restoration with synthetic accounts.

## Outside-app deletion and privacy requests

1. The public `/account-deletion` page provides a mail request to
   `teamsplitora@gmail.com`, usable after uninstalling. Confirm that this inbox is
   monitored and that its deletion link works on an outside-app device before launch.
2. Verify ownership through the registered address and the approved recovery process.
   Never request a password, bank credential, UPI PIN or identity-document image by email.
   Record the request, ownership outcome and proposed completion date in a restricted
   support case, not in public listing evidence.
3. Explain the account's financial/ownership impact, active payment blockers and retained
   categories. Help the requester complete the signed-in deletion review where possible.
   For an inaccessible account, use an individually reviewed support procedure; do not
   run an unreviewed database deletion or bypass ledger/departure protections.
4. Confirm removal of credentials, direct account contacts, tokens, push registrations,
   live roster links and copied account/safety references. Confirm local cleanup on the
   deleting device. A previously offline installation must reconnect before it can learn
   of a remote account deletion; do not promise immediate remote erasure of that device.
5. Review personal information in retained receipts, names, chat and transaction evidence
   separately. Redaction must preserve the financial ledger and authorized participants'
   ability to reconcile. Explain any justified retained fields and duration to the requester.
6. Confirm completion and the retained categories. A subsequent registration creates a
   new account; it must not reconnect automatically to the deleted identity's groups.

The implementation supplies the public request pathway and signed-in deletion workflow.
Inbox monitoring, ownership recovery and exceptional support fulfilment require an
operator; a `mailto:` link does not perform deletion automatically.

## Retention register to approve

| Category | Current implementation / required operating decision |
| --- | --- |
| Active account and optional contacts | Retained while active; removed by confirmed account deletion |
| Shared group/member names, financial records, receipts, reports and de-identified chat | Can survive account deletion while the shared group exists; owner must approve reconciliation/dispute purposes and an event-based deletion/redaction review process |
| Guardian consent and verification references | Stored with the relationship; account cleanup removes live guardian references; approve the external verification system's access and retention separately |
| Open reports | Retained until resolution; operator must prevent an unattended indefinite queue |
| Resolved reports | MongoDB TTL on resolution time expires cases after 90 days; expiry is asynchronous |
| Android confirmed cache | Existing 30-day local policy; unresolved local actions remain for same-account review/retry; confirmed account deletion invokes account cleanup |
| Backups, provider logs and external support evidence | Verify actual provider settings, deletion lag and justified retention before making a public timing promise |

## Deployment and release rehearsal

Deploy public policies and compatible backend/frontend changes through the repository's
normal reviewed release procedure after the operating gates are accepted. The new API
requires current terms; APK 24 has no community-review screen. Rehearse the existing-user
upgrade and web-assisted review path and coordinate the release so users have a working
review/update route when enforcement starts. Avoid an unattended backend-only rollout
that strands installed users at an eligibility error.

Rehearse with synthetic adult, teen, guardian, moderator and deleted accounts. Record
source/patch, environment, action, expected result, actual result and evidence. Require
public policy URLs, tested support handling, operational acceptance and final native
acceptance before marking Phase 1 complete.
