# Approved Session 1 contract and implementation handoff

Recovered from the user-approved contract in “Plan expense-level settlement”. Session 2 implementation is authorized in “Plan expense coverage engine”. The contract below is retained verbatim; implementation evidence follows it after verification.

# Expense-level settlement contract

## 1. Summary and repository findings

Preserve the expense cards and add confirmed progress for individual participating shares. Offer direct expense payment and an explained simplified group option in a shared payment sheet.

Inspection found:

- The current balance engine combines signed expenses, historical settlements, payments, and migration adjustments into family/individual wallet balances.
- Expense shares are currently display-only. Payments do not identify the expenses or people they cover.
- Manual payments and UPI confirmation currently depend on the latest recommended transfer. UPI confirmation can reduce the posted amount when that recommendation changes.
- Receiving-family accounts and authorized administrators can confirm receipt. Ordinary payers cannot establish receipt.
- Reported UPI attempts currently expire after 24 hours. Existing pending-payment screens also represent offline synchronization, which must remain distinct from receiver approval.
- Expense cards currently derive their “Settled” badge from the whole group’s balance. That cannot establish expense coverage.

The working tree at `dd7590c` is clean. This turn changed no files; findings are from code and test inspection, without runtime verification.

The planning decisions are fixed: reconcile ambiguous history conservatively; count participating shares funded by the paying family wallet as covered; require all affected people or an authorized admin to approve group offsets; retain confirmed money as unapplied credit while allocation consent is incomplete; retain reported payments until explicitly resolved.

## 2. Accounting model, difficulties, and reconciliation

### Separate money from expense coverage

Retain the existing wallet ledger as the financial source of truth. Add a linked obligation and allocation journal.

| Record | Required meaning |
|---|---|
| Expense share revision | Expense, participant person, family/individual wallet, signed canonical share, participation snapshot, and original funding wallet/person when known |
| Obligation | Positive outstanding amount with explicit debtor and creditor wallets; linked to its participating share |
| Settlement intent | Immutable reviewed allocation plan, cash legs, method, actual payer and receiver identities, reporting actor, approvals, and lifecycle |
| Allocation event | Amount applied to a named obligation through confirmed payment, approved offset, wallet funding, historical reconciliation, or correction |
| Correction event | Append-only reversal or adjustment with actor, reason, affected records, and before/after accounting effect |

Use UUID identities, canonical trip currency, and the existing whole-unit policy. New settlement contracts use whole-unit decimal strings for money; existing numeric response fields remain compatible.

Required invariants:

- A share’s remaining amount equals its obligation minus effective approved allocations.
- Pending reports, reservations, and recommendations contribute **zero** approved coverage.
- A share is settled only when its remaining amount is zero.
- Coverage never exceeds the share’s obligation.
- Cash is posted to the wallet ledger exactly once. Linking that cash to shares does not post it again.
- Applied group allocations must have exactly the same wallet effect as their linked confirmed cash. A pure offset must have zero effect on **every** affected wallet.
- The wallet vector of outstanding obligations, plus unapplied confirmed money and accounting adjustments, must reconcile exactly to existing balances.

### Gross obligations versus net balances

A net recommendation loses information about the original expense obligations. Consequently:

- Direct payment eligibility uses the selected obligation’s unpaid, unreserved amount—not the simplified recommended amount.
- Direct payment targets the original creditor. Where the expense identifies only a family wallet, select and disclose a receiving person within that wallet.
- Keep the existing recommendation engine. Add an allocation planner that explains its relationship to named expense obligations.
- Construct group plans by decomposing the obligation graph together with reversed proposed cash transfers into conserving paths/cycles. Use stable obligation and transfer ordering for deterministic results.
- A route that cannot independently clear a conserving set of obligations belongs to a bundle containing its dependent payments. Display those dependencies before payment.
- Pure debt cycles remain outstanding until explicitly approved. Extracting or displaying a cycle never settles it.

For partial simplified payments, recompute the proposed bundle for the requested cash amount and show the exact resulting coverage. Approval applies only those reviewed lines.

### Historical money without expense references

Historical payments cannot reliably reveal which expenses were intended, or whether anyone accepted an offset.

Activation performs an idempotent reconciliation preview:

1. Snapshot existing expenses, wallets, participating people, effective historical settlements, confirmed payments, and migration adjustments.
2. Preserve all existing financial totals and receipt evidence.
3. Link explicit references, or a uniquely eligible directed obligation supported by the available historical record.
4. Treat all other historical money as unapplied reconciliation credit. Show the possible affected obligations and block their direct payment until reviewed.
5. Let an authorized admin approve a reviewed allocation or offset with a recorded reason. Do not fabricate historical participant consent.

Only historical settlements that currently affect balances enter reconciliation. Pending historical settlements remain unconfirmed. Identify existing links, such as UPI attempt/payment links, to avoid counting the same event twice.

Missing historical people, edited expenses without sufficient history, removed members, and rounding adjustments produce review cases. Never silently invent an expense or spread adjustment money across shares.

### Family and person allocation

Family wallets continue to determine group balances and recommendations. Person records explain participation and coverage; they do not introduce separate intra-family debts.

- Derive person allocations from authoritative entity amounts and existing participation/EXACT rules. Person amounts must sum exactly to their wallet’s expense share.
- Snapshot stable person IDs, wallet ownership, participation, and display names. Later roster changes cannot silently reinterpret approved coverage.
- Every participating share inside the original paying wallet starts covered as “Covered by family wallet.” A standalone bill payer’s participating share starts covered likewise.
- Record the payment’s actual payer separately from the people whose shares it covers.
- Add optional expense `paid_by_person_id`, validated against the funding wallet. Historical unknown payers remain explicitly unknown; the expense creator is not assumed to be the payer.
- Count actual participants, including participants whose rounded amount is zero; exclude nonparticipants and zero-allocation EXACT exclusions. Zero monetary shares need no payment.

### Refunds and corrections

For negative expenses, reverse the obligation direction: the wallet that received the refund owes participating recipients their refund shares. Use positive payment amounts and wording such as “Refund due”; retain the signed expense in accounting and reports.

Financial corrections must preserve approved evidence:

- Uncovered expenses retain existing creator/admin editing rights, with a new share revision.
- Approved allocations or active payment reservations require a correction preview before financial edits, deletion, reconversion, or retroactive family reallocation.
- Admin-approved corrections append compensating financial and allocation events. Excess confirmed money becomes reviewable credit.
- Approved receipts are never rewritten or hard-deleted. A correction does not imply that money was physically refunded.
- Note-only edits keep existing permissions.
- Extend departure/removal guards to unresolved obligations, credit, and settlement intents, even when the group’s net balance is zero.

## 3. Lifecycle, permissions, concurrency, and APIs

### Lifecycle

Track receipt and allocation status separately.

| Event | Financial effect | Expense effect |
|---|---|---|
| Review quote or display recommendation | None | None |
| Start UPI handoff | None | Reserve selected amounts |
| Report UPI/cash/bank payment | None; receipt pending | Reservation retained |
| Receiver/admin confirms direct payment | Post confirmed cash once | Apply reviewed direct allocations |
| Receiver confirms group cash, consent incomplete | Post confirmed cash once as unapplied credit | Coverage remains pending |
| All required receipts and allocation approvals complete | No duplicate cash posting | Apply the complete conserving bundle |
| Approve pure offset | No cash posting | Apply approved zero-vector coverage |
| Report non-receipt or allocation conflict | None from the report | Needs review; no automatic settlement |
| Approved correction | Explicit compensating effect | Reverse/reapply specified coverage |

Unreported UPI starts may expire after 24 hours. Reported payments and confirmed credits do not expire automatically. Cancellation is available before reporting; reported money requires receiver/admin resolution. Notification failure never loses a report or approval.

A zero-money proposal does not reserve shares or block direct payment. Direct payments can proceed until the offset is approved. The final offset transaction rechecks current obligations and payment reservations; stale consent cannot close changed shares.

### Permissions

- Any linked payer can pay eligible shares belonging to their individual/family wallet and report money they paid.
- Ordinary payers cannot approve their own receipt.
- Preserve receiving-wallet authority: the linked receiver, receiving-family accounts, owner, group admins, and application super-admin may confirm incoming money.
- UPI initiation remains restricted to the actual linked payer; administrator status alone does not authorize launching payment as another person.
- Receiver/admin reports still enter a pending state and require an explicit approval action.
- Group allocation consent is person-specific. Receiving-family receipt authority does not authorize consenting for every affected family member.
- Affected approvers comprise the people whose obligations or funding entitlements are reduced. When historical funding identifies only a family wallet, include its participating people from the expense snapshot.
- Unlinked or unavailable affected people require an authorized admin override. Record the override, actor, and reason.
- Approved financial corrections and ambiguous-history reconciliation are admin-only.
- Group members may see coverage explanations. Preserve narrower access to UPI details and private transaction references.

Recheck membership, account links, and administrator authority inside the approving transaction.

### Concurrent and external payments

Use required MongoDB transactions, permanent mutation receipts, unique cash-posting identifiers, and conditional trip/intent versions.

- Reserve allocation amounts before UPI launch or accepting a report.
- Check reservations across direct and group payment paths.
- Revalidate each share revision, remaining amount, and reservation before allocation.
- Concurrent conflicting actions return a structured conflict and require refreshed review.
- Do not silently shrink confirmed money or substitute different expenses at approval.
- If money arrived despite a conflict, preserve its receipt as unapplied credit and require reconciliation.
- Repeated taps and retries return the accepted result without repeating money, allocations, or notifications.

Reservations reduce duplicate opportunities; external applications remain outside the app’s control. Copying, launching, returning, screenshots, and user-entered references never prove receipt. Reuse current UPI copy-and-open behavior, fresh recipient review, and locked conversion evidence. Label approvals “Receiver confirmed” or “Admin approved,” never “Bank verified.”

### Public contracts

All routes are under `/api/trips/{trip_id}`.

| Contract | Purpose and essential fields |
|---|---|
| `GET /expense-settlement` | Consistent financial snapshot: ledger version, server timestamp, expenses/revisions, person coverage, balances, payment history, pending approvals, and reconciliation blockers |
| `POST /settlement-quotes` | `mode: direct/group/offset`, selected share IDs/amounts, payer/recipient or recommended transfer, cash amount, expected ledger version |
| Quote response | Immutable quote ID/hash, currency, cash legs, allocation lines, offset explanation, required approvers, dependencies, freshness, and expiry |
| `POST /settlement-intents` | Reviewed quote ID/hash, method `upi/cash/bank/offset`, and mutation UUID; cash/bank creates a pending report, UPI creates an unreported start |
| Payment-leg actions | Start/report/cancel a named cash leg; bind existing UPI attempts to that leg and use the shared lifecycle |
| `POST /settlement-intents/{id}/approvals` | Receipt confirmation, allocation consent, non-receipt/rejection, or admin override; include leg/person scope, plan hash, intent version, and reason when required |
| Intent list/detail | Durable pending work, receipts, approval progress, coverage explanations, and correction references |
| Reconciliation/correction preview and commit | Reviewed source records, proposed allocations/adjustments, expected version, reason, and mutation UUID |

Quotes expire after five minutes or earlier when their underlying FX quote expires. Relevant changes require renewed review. Later approvals validate the immutable plan against current share revisions rather than blindly trusting its original group version.

Expense summaries expose `settled_count`, `participant_count`, viewer status, remaining amount, and pending/reconciliation status. Participant rows expose allocated, covered, reserved, and remaining amounts plus coverage sources.

Use structured errors for stale plans, already-covered shares, reservations, insufficient authority, reconciliation requirements, unavailable transactions, and required client upgrades.

## 4. Minimal UI, feature flag, and execution handoffs

### Expense cards and sheet

Preserve card layout, amount, receipt, sorting, search, and edit controls.

- Add compact **“N/M shares settled”** and **“Settle / View shares.”**
- Use **“Your share settled”** when the viewer’s actual participating share is fully covered.
- Keep settled expenses visible. Replace group-derived expense badges with expense-specific coverage.
- Move participant details and payment choices into the existing sheet component. Keep card editing and sheet actions independently tappable.
- Use a Google Pay-inspired arrangement: parties and amount first, compact person rows, primary payment action, secondary group option, and readable activity history within existing app styling.
- Offer **“Pay this expense”**, **“Use group settlement”**, and **“Already paid — Cash / Bank transfer.”**
- Explain group cash, offsets, affected expenses, required approvals, and dependent payments before submission.
- Show partial coverage, pending receipt, pending consent, wallet funding, and historical review distinctly.
- Covered shares expose their settlement explanation and no payment action.

Settle Up retains recommendations and history, adding allocation explanations, offset proposals, and approval work. A zero group balance with open obligations reads **“Group balance is zero; expense shares still need settlement or offset approval.”**

### Online actions and cached freshness

All new payment starts, reports, approvals, offsets, and corrections require a live authenticated connection. Do not queue these actions offline.

Cache the consistent financial snapshot by account/group with its version and server timestamp. Show a persistent **“Saved progress — last confirmed [time]”** indication while cached or refresh-failed. Missing legacy cache fields mean progress is unavailable, not settled.

Refresh before actionable review; returning online alone does not make cached data current. Keep UPI details and private references out of progress caches. Existing offline payment outbox items in activated groups require explicit online review.

### Rollout

Add `EXPENSE_SETTLEMENT_ENABLED`, default `false`, protocol version metadata, and persistent per-group activation version.

1. Implement accounting and reconciliation in shadow mode; compare against existing balances and reports.
2. Verify transaction capability and preview migration before activating a group.
3. Activate a synthetic pilot with the updated client, then explicitly selected groups after validation.
4. Route every financial write in activated groups through the new accounting guard. Legacy payment/settlement writes that lack a reviewed allocation contract return an upgrade-required error.
5. Read compatibility remains. Existing group accounting cannot revert after disabling the UI flag.
6. The kill switch pauses new starts while preserving history, approval, and reconciliation access.

XLSX/PDF retain gross signed expense figures and add shared coverage, offset, unapplied-credit, and correction explanations from the same accounting projection.

During subsequently authorized execution, first save the accepted contract to:

`D:\projects\tripPlanner\docs\expense-settlement-plan.md`

Update that document after each implementation stage with decisions, completed work, validation results, unresolved data cases, and the next session’s handoff. Do not create it during planning.

## 5. Acceptance criteria and remaining validation

### Required examples

| Example | Accepted result |
|---|---|
| Dinner debt ₹100 to A; A owes me ₹80 elsewhere | Dinner offers direct ₹100 and explained group ₹20. Neither recommendation settles shares. |
| Direct ₹100 approved | Dinner is fully covered. The reverse ₹80 obligation remains; A owes me ₹80. |
| Simplified ₹20 approved with required consent | Dinner receives ₹20 cash coverage plus ₹80 approved offset coverage; the reverse ₹80 obligation is covered by that offset. Both explanations remain accessible. |
| Opposing ₹100 debts | Both remain directly payable, including while a zero-money proposal awaits approval. Only all affected approvals or an admin-approved offset closes them. |
| Share covered by confirmed group settlement | Its original-recipient payment action is unavailable. A stale/concurrent direct request fails without another allocation or cash posting. |

### Additional acceptance tests

- A ₹300 expense among A/B/C starts at **1/3 settled** when A paid. Paying-wallet family participation follows the agreed wallet-coverage policy.
- A ₹40 approved payment toward ₹100 leaves ₹60 outstanding and does not increment the settled-share count.
- Every payer report remains pending until receipt approval; UPI callbacks and app return never change balances or coverage.
- Confirmed group cash remains recorded once as credit while another person’s consent is pending. Later allocation does not repost it.
- Group bundles involving multiple cash legs cannot close shares before their required receipts and consents complete.
- Direct/group races, duplicate retries, two family accounts, stale revisions, and repeated approvals cannot over-cover a share.
- Unknown historical allocations remain visible and guarded; reviewed links preserve wallet totals.
- Negative refunds, EXACT splits, participation exclusions, zero-rounded shares, removed people, FX evidence, and migration adjustments conserve amounts.
- Corrections, reconversion, roster reallocation, and deletion preserve receipt evidence and produce explainable residual credit.
- Unauthorized approval, revoked roles, outsider access, offline submission, and legacy-route bypasses fail.
- UI, balances, XLSX, and PDF reconcile to one projection. Cached progress shows its confirmation time.
- Native sheet behavior, accessibility, large text, app restart, UPI launch failure, and pending-report recovery work on supported Android devices.

Run focused domain and route tests first, real replica-set concurrency/idempotency tests next, then frontend behavior, type checking, lint, and report parity checks.

No product-policy choice remains open from this planning session. Production history quality, transaction capability, account linkage, and native UPI QA remain unverified. Unknown historical attribution requires the defined reconciliation process; production activation awaits those checks. Deployment and publication are outside this planning turn.

---

## Session 2 implementation handoff — 6 October 2026

The approved Session 1 contract above was restored before implementation. This section records
the backend foundation actually implemented in Session 2. No production data was read or changed,
no group was activated, and no deployment or frontend change was performed. Activation markers in
tests belong only to generated disposable fixtures.

### Implemented interfaces and versions

| Interface | Responsibility |
|---|---|
| `ledger_snapshot.load_ledger` / `LedgerSnapshot` | Complete trip accounting inputs, without a 1,000-row cap; coverage mode also loads journal, intents, and attempts |
| `balances.project_ledger_balances` | Existing balances/recommendations/family display from that shared input; existing public shape preserved |
| `expense_shares.person_shares_for_entity` | Shared whole-unit person amounts and participation; entity totals still come from `expense_entity_shares_scaled` |
| `expense_coverage.make_share_revision` | Freeze authoritative shares, roster/participants, original funding ownership, and conversion evidence |
| `expense_coverage.build_coverage_snapshot` | Coverage, reservations, unapplied sources, review cases, exact wallet reconciliation, and content fingerprint |
| `expense_coverage.preview_historical_reconciliation` | Pure conservative preview; no database writes or inferred offset consent |
| `coverage_allocations.plan_direct_allocations`, `plan_group_allocations`, `plan_offset_allocations` | Deterministic reviewed whole-unit plans, dependencies, cycles, and person approval requirements |
| `coverage_allocations.validate_plan`, `validate_cash_uses`, `validate_allocation_bundle` | Immutable references, unpaid capacity, conserving explanations, source claims, receipts, and consent |
| `coverage_journal.append_coverage_event` | Internal atomic metadata append/reversal against existing cash; no cash posting and no public mutation route |
| `coverage_journal.store_new_share_revision` | Future expense-create transaction hook; not invoked by legacy expense writes or a migration in this session |
| `coverage_read.coverage_response` | Privacy-safe summaries and optional batched person/explanation details |

Read protocol: **1**. Coverage policy: **`expense_coverage_v1`**. Historical inference policy:
**`legacy_coverage_v1`**. Money policy remains **`whole_unit_v1`**, independently of the existing
recommendation routing algorithm/version. API money fields are decimal strings; active amounts
are whole units. Legacy precision is retained in exact strings and requires review.

### Persisted schemas and write boundary

`expense_share_revisions` contains a deterministic UUID `id`, `trip_id`, `expense_id`, content-based
`revision` / `financial_fingerprint`, policy, `effective_from`, provenance (`recorded_at_creation`
or conservative `read_time`), wallet totals, funding wallet/person, frozen roster and conversion
evidence, and per-person share rows. Rows contain signed canonical original shares, participation,
wallet ownership, debtor/creditor direction, and deterministic ordering. Unknown historical people
are opaque wallet obligations with `person_id=null`, never fabricated roster members. New creation
hooks use actual server recording time, not the bill's potentially backdated date.

`expense_coverage_events` is append-only. Allocation events retain the plan/hash, exact allocation
lines/cycles, cash-source claims and fingerprints, approval evidence, actor, sequence, mutation ID,
request hash, and time. Reversal events identify the original event and actor/reason. Indexes enforce
unique revision keys, permanent actor/mutation retry keys, event IDs, and one reversal per event.
Intent IDs are unique. No TTL removes journal or mutation evidence.

The internal append requires the enabled flag, activation version 1, financial write-guard version 1,
current trip access, and a MongoDB snapshot transaction. It verifies current receiver/admin authority
and person-specific consents, with reasoned authorized admin overrides where permitted. Another
actor's approval must already exist in the durable intent; loading their account does not prove
consent. It replays/reconciles the resulting ledger before committing, advances the trip revision,
and resolves the intent atomically. Retries replay the same event; different payloads conflict.
Reversals restore credit and shares without refunding or reposting cash. Unsupported transactions
fail closed. No existing public payment/settlement route calls this helper yet.

### Coverage and allocation rules actually applied

- Positive expenses create participant-wallet → funding-wallet obligations. Refunds reverse that
  direction. Payments always carry positive magnitudes and explicit directions.
- Participating people in the funding wallet begin covered. Real zero-rounded participants need no
  payment. Nonparticipants and explicit zero EXACT allocations do not enter settled-share counts.
  Funding-family person identity remains unknown unless supported by the expense record.
- Source kinds are separately tracked as `wallet_funding`, `direct`, `group`, `approved_offset`,
  and `historical_inferred`. Pending reports, intent reservations, and recommendations never cover
  shares. Each resolved share's absolute original amount equals these sources plus remaining.
- Family wallets remain ledger entities. Frozen person amounts explain coverage and introduce no
  intra-family debts. The existing family net breakdown is never used as evidence of coverage.
- Direct plans use gross unpaid, unreserved reviewed shares and their original creditor, even when
  the group recommendation is smaller or zero. Already-covered shares cannot be selected again.
- Obligations order by normalized frozen creation timestamp, expense ID, revision, and participant
  position/ID. Cash legs order by debtor, creditor, and leg ID. Database row order is irrelevant.
- Group allocation uses integer lower-bound circulation with stable breadth-first augmenting paths.
  Requested cash is fixed; recommended dependent cash is bounded by its current recommended limit.
  Ordered cycle decomposition produces exact obligation lines and cash explanations; residual pure
  debt cycles within the selected component become explicit proposed offset lines.
- Partial group cash recomputes the plan. For ₹100 versus ₹80, cash ₹10 covers ₹10 of dinner plus
  ₹80 approved offset, offsets the reverse ₹80, and leaves dinner ₹10. It does not scale an old plan.
- A ₹100 A→C transfer can discharge A→B ₹100 and B→C ₹100. Coverage-line totals can exceed cash
  along a path. Every wallet's effect must conserve; cash source claims separately consume only
  ₹100. Explanations distinguish actual cash receivers from people receiving debt discharge.
- Offset lines must have zero effect on every wallet. Pure offset proposals neither cover nor
  reserve shares, including when an obsolete proposal needs review. Group/direct pending plans
  reserve only validated current references. Corrupt/stale plans and competing reservations require
  review and do not turn an unavailable amount into zero.
- A bundle waits for all required receipts and consents. Until allocation applies, confirmed cash
  is unapplied credit. Accepted events remain fixed after later or backdated expenses. Changed
  financial/FX evidence, invalid revisions, stale consent, or exhausted cash rejects application;
  the engine never silently changes the reviewed obligations or shrinks cash.

### Historical reconciliation and unresolved cases

Both `payments` and every legacy settlement with status other than `pending` match the existing
balance engine's effective-source selection. Attempts provide pending/link evidence and never post
additional cash. Two distinct balance-effective rows remain two sources; suspected duplicate attempt
links require review, with both amounts preserved as credit rather than two safe inferences.

Explicit historical direct references link only valid known-person revisions in the source's
direction and amount. Opposing or indirect references cannot fabricate offset/group consent.
Otherwise inference requires exactly one reliable directed obligation with retained creation
revision, chronology, person ownership, sufficient amount, and no reservation/review blocker.
It is labelled **historically inferred**, never recipient-confirmed or bank-verified. Broken
reference sets are not partially applied. Historical preview and the read API never persist links.

Ambiguous sources, missing creation time or revisions, incomplete edits, unknown/removed people,
synthetic or missing family rosters, fractional history, conversion conflicts, and migration
adjustments remain review cases or structured unavailable projections. Unsupported nonzero expenses
without authoritative participants are unavailable. Adjustment money is not allocated to shares.
Review blocks the implicated obligation component, or the group when scope cannot be determined.

The exact check is:

`outstanding obligation vector + unapplied confirmed cash + accounting adjustments = authoritative precise balances`

Coverage metadata does not enter that cash ledger. Stored canonical trip-currency amounts and
original conversion evidence are used without FX lookups or reconversion.

### Batched read API and availability

`GET /api/trips/{trip_id}/expense-settlement` returns summaries for all expenses. Repeated
`detail_expense_id` parameters request details for up to 100 expenses together. Filtering details
never filters accounting/reconciliation input. Instrumented small/1,101-expense fixtures both use
10 trip-level collection reads per projection attempt, plus the normal authentication lookup.
Mongo transaction retries may repeat that fixed batch; there are no per-card queries.

Responses include protocol/policies, canonical currency, trip ledger version, content-based
`snapshot_id`, server `generated_at`, completeness, consistent-read freshness, availability,
uncertainty/review reasons, pending work, exact balances, and unapplied credit. Fingerprints include
financial/FX evidence, source references/people, journal, pending settlements/intents/attempts,
adjustments, membership/authorization, activation, and write-guard state; trip version alone is not
freshness proof. `expected_snapshot_id` mismatch produces HTTP 409 `coverage_snapshot_changed`.

Summaries expose participant/settled/evidenced/inferred and known-progress counts, viewer status,
remaining/reserved amounts, pending count, and review reasons. Details expose signed originals,
directions, source-separated coverage, actual cash people when recorded, remaining/reserved/eligible/
actionable amounts, and allocation explanations. Unresolved settled counts and payable totals are
nullable. Unattributed historical pending work stays identifiable without invented expense links.
Malformed records and unavailable snapshot transactions return structured review/unavailability,
not fabricated settled totals or an accidental missing-key error.

Authentication and trip access are checked again inside the snapshot. Receipt bytes and private
UPI/transaction references are excluded from coverage loading/serialization. The endpoint provides
online read evidence; it implements no cache client. A future client must treat missing cache
metadata as unavailable and cached timestamps as insufficient for action eligibility.

`EXPENSE_SETTLEMENT_ENABLED=false` remains the default and sample configuration. Unactivated
groups return disabled/not-activated responses. Activated-history fixtures remain readable when
starts are disabled. `/meta/config` advertises protocol 1, the flag, and
`expense_settlement_actions_ready=false`. Session 2's `ACTIONS_READY=False` ensures no actionable
payment amount is offered, even if the flag is toggled before later workflows are implemented.

### Validation evidence

Final combined gate: **523 passed** in 33.44 seconds, with one existing Starlette
`python_multipart` deprecation warning and no skipped tests. It ran the four new coverage suites
together with `test_settlement_engine`, `test_balances_projection_unit`, `test_expense_shares`,
`test_family_participation`, `test_per_family`, `test_split_bugfix`, `test_exact_split`,
`test_currency_rules`, `test_trip_currency_lock`, `test_currency_precision_audit`,
`test_expense_conversion`, `test_expense_conversion_routes`, `test_whole_unit_migration`,
`test_income_migration`, `test_payments_rollup`, `test_payment_attempts`,
`test_payment_handoff_preview`, `test_payment_recipient_details`, `test_payment_idempotency`,
`test_settlement_routes_unit`, `test_settlement_write_policy`, `test_settlement_gate`,
`test_report_builder`, `test_report_layout`, `test_report_pdf`, and `test_report_routes`.
The command used `.venv/Scripts/python.exe -m pytest` with those files and `-q` from `backend/`.
`git diff --check` also passed. The combined selection
covers the new tests and existing settlement, share, balance, family, EXACT, split, currency,
conversion, migration, payment, XLSX/report-builder, and PDF suites. It uses the workspace virtual
environment with safe test-only overrides and no shared database. New checks reside in:

- `backend/tests/test_expense_coverage.py`: Session 1 examples, conservation, source claims,
  offsets/refunds, families/removed people, historical inference/review, permissions, reservations,
  deterministic ordering, frozen FX evidence, and 60 generated conserving obligation graphs.
- `backend/tests/test_expense_settlement_api.py`: batched details, constant queries through 1,101
  expenses, fingerprint conflicts without trip-version changes, auth, private evidence exclusion,
  nullable uncertainty, malformed records, and disabled/unavailable behavior.
- `backend/tests/test_coverage_journal_mongo.py`: real isolated replica-set atomic retry, competing
  allocation/source claims, durable approvals, injected rollback, reversal, and capability gates.
- `backend/tests/test_coverage_server_mongo.py`: actual app startup and authenticated HTTP against
  a generated loopback database; disabled new groups, consistent retained-history reads, unchanged
  balances, XLSX/PDF exports, auth rejection, and no extra cash/journal writes.

Replica-set tests require explicit `COVERAGE_TEST_MONGO_URL` on loopback and generate/remove only
their own UUID-named databases. The API startup test forces email, push, conversion rollout, and
expense settlement starts off. No production history, production transaction capability, provider
network, Android UI, native UPI, or end-to-end new payment/approval flow was validated.

### Session 3 integration requirements

1. Implement authenticated reviewed-intent, report/receipt, person-consent, and admin-review
   workflows around these pure planners and internal append. Record actual payer/receiver identities
   and durable actor actions; preserve reported work until explicit resolution.
2. Atomically post exact confirmed cash once and retain it as credit until the conserving bundle's
   full approval completes. Map intent cash legs to source fingerprints, handle dependencies, and
   never clamp an approved payment to a changed recommendation.
3. Store share revisions during validated expense creation. Integrate corrections/reconversion,
   roster reallocation/removal, and deletions with append-only reversals and retained evidence
   before permitting any incompatible existing write in activated groups.
4. Add activation/reconciliation preview/apply tools, review unknown history, freeze approved links
   idempotently, verify replica-set guarantees, and route **all** activated-group financial writers
   through the trip write guard. Only then set activation/write-guard markers deliberately.
5. Add public freshness preconditions, renewed review for changed obligations/reservations/sources,
   approval authority revocation checks, and legacy-client upgrade errors. Test complete financial
   writer races; do not infer readiness from the Session 2 internal helper alone.
6. Subsequent UI/cache/report sessions must replace group-derived expense badges with this coverage
   projection, preserve offline-state distinctions, expose indirect-recipient explanations and
   unknown history honestly, and add shared coverage explanations to exports. Native and end-to-end
   acceptance remain later gates. Deployment/activation still require separate approval.

---

## Session 3 implementation handoff — 6 October 2026

The approved payment-submission/review execution extends the Session 2 foundation above. Existing
Session 2 working-tree changes were preserved. All writes used local source files or generated
loopback test databases; no production group was activated and no deployment, frontend change,
provider request, or native UPI launch was performed. `EXPENSE_SETTLEMENT_ENABLED=false` remains
the default and sample setting. This section supersedes Session 2’s statements that public payment
workflows and actionable readiness were still unimplemented.

### Implemented contracts

| API, under `/api` | Contract |
|---|---|
| `POST /trips/{trip_id}/settlement-quotes` | `mode=direct/group/offset`, method, current `expected_snapshot_id`, share/cash selections, and actual payer/recipient person bindings; returns immutable quote/hash, preassigned intent ID, conserving plan, party snapshots, and five-minute-or-earlier-FX expiry |
| `POST /trips/{trip_id}/settlement-intents` | Quote ID/hash and mutation UUID, optional normalized private reference/note; consumes a fresh owned quote and saves reservations/report evidence transactionally |
| `GET /trips/{trip_id}/settlement-intents` | Trip-authorized public summaries, exact amounts, separate receipt/allocation status, version and plan hash; no private references or account IDs |
| `GET /trips/{trip_id}/settlement-intents/{intent_id}` | Summary plus reports and attributed action history restricted to the initiating actor/current authorized receiving-wallet reviewers/admins |
| `POST /trips/{trip_id}/settlement-intents/{intent_id}/legs/{leg_id}/actions` | Mutation UUID, expected intent version/hash; `start`, `report_paid`, or pre-report `cancel` |
| `POST /trips/{trip_id}/settlement-intents/{intent_id}/approvals` | Same preconditions; `confirm_received`, reasoned `report_not_received`/`reject`/`resolve_not_sent`, person `consent`, reasoned `admin_override`/`reverse_allocation`, or authorized pre-report bundle `cancel` |

New money contracts require positive whole-unit decimal strings. Existing numeric payment history
remains numeric; confirmed receipt rows store canonical integers explicitly. Intent IDs are assigned
before quote planning, so reservation linkage does not change the reviewed plan hash. The quote hash
also binds method, trip/currency, all selected revisions/amounts and actual party snapshots. Offset
quotes expose the computed conserving component and require every affected person’s consent or an
authorized reasoned override; they never reserve shares by themselves. A group quote that needs
additional party bindings returns its required cash legs so a client can complete the quote.

Direct validation uses gross outstanding, unreserved shares and their original directed creditor,
without a net recommendation cap. Selected lines must have one debtor/creditor wallet pair. A linked
family account can pay another selected participant’s share in its own family wallet; actual paying
person and covered person remain separate. Group quotes and new UPI starts preserve recommended-pair
limits. Before a dependent UPI leg starts, only this bundle’s already confirmed cash is restored for
that comparison; it cannot invalidate itself merely because an earlier leg has received money.
Partial group amounts recompute the circulation plan instead of scaling an old allocation.

UPI snapshots retain the selected address/revision, exact conversion quote and INR amount, payer,
recipient, timestamps and available reported evidence. Each UPI conversion quote remains unique per
attempt; the quote index is partial so cash/bank reports can omit it. References and notes are kept
in restricted reports/action records and excluded from general payment/coverage responses. A reference,
callback or return from another app never confirms receipt. Screenshot ingestion/verification is not
implemented. Existing sender/recipient attempt endpoints delegate settlement-bound rows to these
services, requiring mutation/version/hash fields; old requests receive a refresh-required response.

### Lifecycle and authority

- UPI intent creation reserves the reviewed shares before launch and posts no cash or coverage.
  Cash/bank creation records payment-reported evidence and enters awaiting review in the same commit;
  dependent cash legs need their own report. Receiver/admin-created reports still need explicit approval.
- Leg `receipt_status` is independent of intent `allocation_status`. Receipt approval posts the exact
  immutable trip-currency amount once. Direct coverage applies when valid; group/offset allocation
  waits for every required receipt and person-specific consent. Pending coverage is never reported
  as approved coverage. An incomplete bundle’s confirmed cash remains unapplied credit.
- Receiver, linked receiving-family accounts, owner, trip admins and application super-admin retain
  review authority. An ordinary payer cannot approve their own receipt. UPI start/report authority
  uses the exact initiating account and its current person link; admin status cannot impersonate a
  sender. Receiving-family receipt authority does not grant another person’s offset/group consent.
- Stale revisions, amounts, recipients, UPI details, covered shares, or competing reservations stop
  new sending. Reporting and receipt approval retain the original contract and discrepancies rather
  than substituting expenses or shrinking money to the latest recommendation. Invalid allocation
  returns `needs_review` while exact confirmed cash stays as credit.
- Dispute/rejection retains claims, reasons, reservations and evidence. Only explicit reasoned
  `resolve_not_sent` closes an unconfirmed claim; it cannot erase another leg’s report or confirmed
  credit. Pre-report cancellation atomically releases the bundle’s reservations. Late evidence from
  authorized initiating accounts can reopen expired/canceled starts for review, retaining and naming
  overlapping later intents. Current reviewers can record a former payer’s claim with attribution.
- Only unreported starts expire after 24 hours. Any reported or confirmed leg prevents bundle expiry
  and reservation release. Expiry adds a system action. The shared sweeper conservatively recovers
  legacy expired rows with sent-report evidence into review, retaining a newer attempt’s pair key.
  Reported/disputed work has no TTL. An elapsed deadline does not authorize repayment or departure.
- Admin-only, reasoned reversal appends a journal compensation, restores obligations, and leaves
  confirmed cash as credit. It does not claim a physical refund. Receipt monetary edits/deletion,
  expense financial edits/reconversion/deletion, roster/reallocation writes, and migrations are
  blocked for activated groups pending correction support. Description/category edits remain allowed.

### Transaction and concurrency boundary

`settlement_intents.mutate` owns a MongoDB snapshot transaction with majority write concern. It reloads
trip/user authority, links, report/version/hash, revisions, reservations, prior approvals and source
claims. Payment, eligible coverage journal, intent/attempt status, attributed action evidence,
permanent mutation receipt, trip revision and notification outbox commit together. The journal accepts
the caller’s session with `advance_trip=False`, preserving its standalone wrapper without nested
transactions or double version advancement. Later group consent consumes existing source cash rather
than reposting it. Projection replay verifies exact wallet reconciliation before the journal commits.

Permanent actor/operation/mutation receipts include request fingerprints and path bindings. Matching
retries replay accepted results; altered payloads conflict. Unique intent/leg cash postings and unique
bundle allocations complement shared share reservations and the conditional trip revision. Concurrent
receiver/admin confirmations return the same linked result. Mode-specific keys are lookup protection,
not the concurrency guarantee. Unattributed legacy attempts block their obligation component.
Trip-role changes advance the same revision; user-document write claims also serialize application-role
and UPI-profile changes against privileged actions. Required transactions fail with structured 503s
and no standalone fallback. Notification events identify the actual attempt, deduplicate by durable
action, and target authorized reviewers or the initiating payer. Delivery runs after commit.

Activated expense creation uses the existing permanent expense mutation receipt/roster preconditions
and saves its authoritative share revision in that transaction. Legacy creates without mutation UUIDs
receive an upgrade-required response. Existing activated financial and membership writers are guarded,
including direct claims, clean-stub replacement, join-request approval, departure/removal, historical
reallocation, whole-unit migration and the legacy income migration script. Departure checks include
gross obligations and unapplied credit at zero net balance; settlement retry evidence survives cleanup.

`/meta/config` readiness now uses the enabled flag and verified write-transaction capability; each
trip additionally needs activation version 1 and financial-write-guard version 1. The kill switch
pauses new quotes/intents/UPI starts while preserving existing report, review, reversal and history
access. The read projection derives actionable readiness from those runtime/trip checks.

### Validation evidence and remaining boundaries

Final combined gate: **738 passed** in **51.18 seconds**, **zero skipped tests**, and one existing
Starlette `python_multipart` deprecation warning. This includes Session 2’s full 523-test selection,
the new **35 real workflow scenarios**, departure/join/reallocation/notification regressions, and
existing expense-idempotency unit/real-Mongo tests. `test_settlement_intents_mongo.py` exercises:

- ₹100 gross obligations at ₹20/zero net, ₹40 partial coverage, families/refunds/unlinked receivers,
  offsets, dependent multi-leg bundles, person consent and reasoned admin overrides;
- duplicate submissions, simultaneous receiver/admin approvals, direct/group and two-family-account
  reservation races, reviewer revocation during approval, source bounds, and lost-response replay;
- stale expenses/recipients, revoked sender links, late/canceled/expired reports, overlapping later
  attempts, indefinite blockers and legacy expired-report recovery;
- authenticated HTTP freshness, self-approval/outsider/cross-trip rejection, owner/admin/super-admin
  authority, private report/history visibility and exact existing-UPI-route delegation;
- injected financial, journal, status, audit, mutation-receipt, outbox and new-revision failures with
  full rollback; standalone MongoDB 503/no partial writes; activated legacy-write rejection.

Tests used explicit loopback replica-set and standalone processes on separate ports and disposable
UUID database names, removed by their fixtures. Safe test-only environment overrides prevented any
shared backend database use. No provider network or notification delivery was called. The combined
gate ran `.venv/Scripts/python.exe -m pytest ... -q` from `backend`, selecting Session 2’s listed files
plus `test_settlement_intents_mongo`, `test_departure_service`, `test_join_requests`, `test_reallocation`,
`test_push_notifications`, `test_expense_idempotency` and `test_expense_idempotency_mongo`.
After the combined gate, the readiness serializer cleanup passed **66** focused coverage/API tests;
the sender-revocation scenario was strengthened to use two accounts in one family wallet and passed
its real-database check. Tracked diff and all 16 untracked source/document files passed whitespace
checks. The two task-owned MongoDB processes were verified by executable, port and data-directory
arguments before cleanup; disposable database directories/logs remain local ignored QA artifacts.

Production activation remains blocked on reviewed historical attribution/reconciliation tooling,
deliberate guarded activation, production transaction/index/data checks, and the separately approved
correction/migration workflow. Stale confirmed credit is safely retained for review; changing monetary
claims or applying a replacement resolution plan is not yet a public correction API. Frontend payment
review, offline coverage/cache semantics, shared export explanations, screenshot support, native UPI
device QA, deployment and production activation remain separate stages. Legacy unactivated-group
recommended-payment behavior remains compatible, including its existing capped confirmation rule.

---

## Correction implementation handoff — 6 October 2026

This implementation extends Sessions 2–3 with protocol/schema 2 corrections, effective historical
replay, reviewed legacy adapters, financial-review interfaces, and explicit historical reconciliation
tooling. This section supersedes earlier statements that public correction support and the app review
interfaces are missing. Deployment, production reads/index changes/migrations, and group activation
were not performed. `EXPENSE_SETTLEMENT_ENABLED=false` remains the default. Native UPI/device and
manual assistive-technology acceptance remain rollout gates.

### Evidence, corrections and current permissions

`financial_ledger.py` replays immutable cash compensations and authoritative current expense pointers
while retaining original sources/revisions for journal verification. Revision IDs bind a distinct
operation, sequence and complete frozen roster/allocation/FX snapshot; repeated financial content
never revives an old revision ID. Version-1 historical hashes, including their persisted datetime
representation, remain replayable. Unknown schemas fail closed.

`financial_corrections.py` and `correction_planner.py` provide immutable previews, durable proposals,
current-authority approval, complete conserving bundle reversal, and compensating reversal of earlier
corrections. Financial changes preserve prior expense, receipt, source, approval, reason and identity
evidence. Replacing or deleting an expense retires its obligations; reversal reopens every affected
share and releases source claims. Exact confirmed cash remains credit until explicitly reconciled.
Correcting/voiding a payment changes the recorded assertion with a signed compensation and optional
replacement source; it does not assert a physical refund. Actual returned money uses a distinct
reported/confirmed transfer. No new cash is posted during reversal or credit reconciliation.
Public previews explain affected expense names, before/after shares, prior reservations, complete
dependent coverage, retained approval counts, source-claim releases, and recorded-money changes.
Private payment references and recipient addresses are excluded from these effects.

The creator/admin can apply an uncovered financial expense change. Existing external allocations,
reservations or reported claims require current admin approval. Intrinsic paying-wallet coverage
alone does not require an admin. Zero-money offset reversals require every affected person's current
consent or a reasoned current-admin approval, bound to the exact plan. Receiving-family receipt
authority never substitutes for another person's consent.

Harmless description/category/time/payment-note edits compare effective values before any legacy
normalization or conversion. Receipt changes append immutable versions and change the visible
pointer. A financial preview cannot overwrite subsequently updated metadata or attachment pointers.
Prior receipt references remain in correction evidence; old GridFS/inline attachment evidence is
retained. Unreported bundles may be canceled/released; reported/disputed/confirmed work remains
`needs_review` against its original amounts, parties, recipient/FX and dependencies. Exact late
receipt confirmation can record credit without approving obsolete allocations.

`roster_corrections.py` preserves stable people and archived wallets. Family edits/reassignment affect
future allocations by default; `reallocate_history` is an explicit separate correction. Bulk-array
removal checks the same gross blockers as individual removal. Departures check obligations, credit,
reports, reservations and durable review cases even at zero net. Owners explicitly transfer ownership
before leaving; last-person family dissolution must be selected. Account deletion requires reviewed
departure from protected groups first. Group deletion becomes archival after blockers clear. Later
reversal can reopen historical wallets without restoring account access or consent.

UPI profiles carry monotonic `recipient_account_revision`; linked-account and recipient-address
changes synchronously invalidate obsolete sending. Pending links/role approvals use current
authorization, and applied approvals stay historical. Binding invalidation, expiry and protected
expired-report recovery append system action and notification outbox evidence inside their required
transactions. Financial actions claim the current user record to serialize role/profile changes.

### Public contracts and legacy behavior

All paths are trip-scoped beneath `/api/trips/{trip_id}`. Correction previews expire after five minutes
or the earlier FX deadline. A changed financial basis requires a renewed preview; submitted proposal
and action evidence never expire. Matching permanent mutation UUID retries replay; altered requests
or substituted paths conflict before effects.

| Contract | Implemented behavior |
|---|---|
| `POST /correction-previews` | Expected snapshot, operation/target/changes/reason; immutable ID/hash, effects and authority requirements. No allocation/cash effects. |
| `POST /corrections` | `protocol_version=2`, preview ID/hash, mutation UUID; apply an authorized uncovered change or create an awaiting-approval proposal. |
| `GET /corrections` and `GET /corrections/{id}` | Current trip access; public effects/history, attributed actions, restricted renewal request for creator/admin. Payment references/UPI details are excluded. |
| `POST /corrections/{id}/actions` | Expected version/hash and mutation UUID; `approve`, person `consent`, `reject`, `withdraw`, `renew`. Approval/rejection require an admin reason. Reversal uses a new `reverse_correction` preview/proposal. |
| `POST /reconciliation-previews`, `POST /reconciliations` | Direct retained-source mapping, conserving group mapping, or zero-money offset; explicit current-admin reason, exact snapshot/hash and mutation UUID. No invented receipt/cash. |
| `GET /historical-reconciliation` | Current-admin read-only redacted diagnostics, plan hash, prerequisites and staged-run summaries. Malformed v2 evidence returns guarded diagnostics. It never upgrades or activates. |

Correction operations are `replace_expense`, `void_expense`, `replace_cash`, `void_cash`,
`reverse_allocation`, `reverse_correction`, `update_member`, `remove_member`, `reassign_family`,
`reallocate_history`, `add_member`, `link_person`, `grant_admin`, `revoke_admin`, `transfer_owner`,
`archive_trip`, and `leave_group`. Source corrections use canonical `payments:{id}` or
`settlements:{id}` bindings. New amounts are whole-unit decimal strings, signed for refunds.

Existing `/payments`, `/settle`, `/settlements` and pending-settlement PATCH accept `ReviewedWrite`
(`protocol_version=2`, quote ID/hash, mutation UUID, explicit submission action). They create one
canonical intent/cash result. A transitioned pending settlement retains `status=pending` and
`reviewed_intent_id`; it cannot become a second effective source or a pending-progress blocker.
Permanent mutation and unique alias binding reject substitution of another settlement URL.
Expense PATCH/reconvert/DELETE, payment PATCH/DELETE, member/family mutations, membership leave,
admin grant/revoke, ownership transfer and trip archival accept path-bound `CorrectionCreate`.
Family-submember DELETE verifies that the reviewed roster actually removes that person from that
family. Harmless expense/payment-note/receipt contracts remain available.

Old protected financial payloads return structured upgrade/correction errors. Settlement-bound old
attempt actions require the reviewed version/hash/mutation fields. Legacy unbound attempts and
protected join/claim/clean-stub/join-request approval are blocked: preserve their evidence and use
reviewed `link_person` or administrative reconciliation; do not replace historical person IDs.
Unprotected groups retain legacy behavior, including capped legacy UPI confirmation. They expose
no expense coverage until reconciliation. The persistent guard survives disabling new starts.

The [writer inventory](financial-writer-inventory.md) and its
[function catalog](financial-writer-inventory.json) document 177 explicit policies across routes,
helpers, startup, background jobs, GridFS, and scripts. Its AST maintenance check flags new writers.
Legacy whole-unit/income/reallocation tools reject protected groups; protected startup financial,
identity and admin backfills are excluded. The v2 installer/backfill is never run at startup.

Settle Up, expense/member editing and Financial review expose before/after effects, retained credit,
approval/reversal, late evidence, payment-note updates, reasoned admin mappings and historical
diagnostics. Financial actions require a live connection; offline drafts retain their frozen payload
and require explicit online review. Account/route switches clear review state and abort reads.
Balances, spend, progress, XLSX and PDF consume the effective ledger; exports include correction,
pending-review and retained-credit explanations.

### Additive collections and exact index prerequisites

Authoritative schema definitions/installers are `models/financial_correction.py`,
`financial_corrections.INDEXES`, `ensure_indexes`, `index_prerequisites`, and `inspect_index_data`.
New evidence collections are `financial_correction_previews`, `financial_corrections`,
`financial_correction_events`, `financial_correction_actions`, `cash_source_versions`,
`ledger_identity_snapshots`, `receipt_versions`, `reconciliation_previews`, `reconciliation_runs`,
`reconciliation_staging`, and `reconciliation_cases`. Expense current/deletion pointers, recipient
revision, group schema/guard and membership revisions are additive. Historical rows remain evidence.

| Index | Required definition |
|---|---|
| Every new collection's named ID index | Unique `id`; no TTL |
| `financial_revision_number` | Unique `(trip_id, expense_id, revision_number)`; partial `schema_version=2` |
| `cash_source_version_number` | Unique `(trip_id, root_source_id, version_number)` |
| `financial_correction_reversal` | Unique `reverses_correction_id`; partial string type |
| `financial_legacy_settlement_alias` | Unique `legacy_settlement_id`; partial string type |
| `correction_trip_status` | `(trip_id, status)` |
| `correction_event_trip` | `(trip_id, sequence)` |
| `ledger_identity_trip` | `(trip_id, member_id)` |
| `receipt_version_expense` | `(trip_id, expense_id)` |
| `reconciliation_stage_position` | Unique `(run_id, position)` |
| `reconciliation_case_status` | `(trip_id, status)` |

Existing permanent uniqueness prerequisites are verified by exact key, uniqueness, partial-filter
and absence of TTL: share `id` and `(trip_id, expense_id, revision)`; journal `id`,
`(trip_id, actor_user_id, client_mutation_id)`, reversal reference, reservation-intent reference;
expense/payment mutation receipts `(actor_user_id, operation, client_mutation_id)`; intent/quote/action
`id`; payment `(settlement_intent_id, settlement_leg_id)` and `payment_attempt_id`; attempt `id` and
partial-string `quote_id`; and outbox `event_key`. Receipt/evidence and permanent retry receipts
must not have TTL. Ordinary delivery cleanup does not delete financial action evidence.

Inspect duplicate/malformed keys and exact definitions before installation. The legacy unique
nonpartial `payment_attempts.quote_id_1` is incompatible with cash/bank attempts lacking quote IDs.
`settlement_intents.ensure_indexes` rejects it by default. A separately authorized, reviewed
maintenance action may invoke its explicit `replace_incompatible_quote_index=True` upgrade after
checking data and quiescing writes. Never perform this destructive replacement automatically at
startup. The historical CLI's v2 installer does not silently repair missing/incompatible v1 indexes.

### Migration order, unresolved cases and activation gates

`backend/scripts/reconcile_expense_history.py` requires an explicit task-specific connection-variable
name, database and trip ID. It refuses ambient `MONGO_URL`/`DATABASE_URL`, defaults to dry-run, and
does not print credentials, private references or UPI addresses. Nonloopback reads require separate
read authorization. Duplicate-key prerequisite inspection is database-wide; authorization must cover
that scope. Index installation, migration application and activation have separate explicit flags;
flags document authorization and are not substitutes for human approval.

1. Obtain authorization for the exact environment and read scope. Pause legacy writers/clients for
   maintenance. Verify a compatible server/client build, snapshot transactions and majority writes.
2. Run the dry-run and prerequisite/data audit. Review baseline wallet vectors, exact differences,
   all effective payments/settlements, direct-link evidence, aliases/duplicates, pending attempts,
   missing identities, precision/adjustments, planned snapshots, blockers, record counts and plan hash.
3. Separately authorize index changes. Install additive v2 indexes and separately resolve the UPI
   compatibility prerequisite. Existing duplicate/malformed evidence requires explicit review.
4. Accept the current deterministic plan hash and authorize backfill application with current admin
   actor/reason. Staged batches use stable IDs/manifest hashes and are invisible to ledger readers.
   Final snapshot rechecks the original group/plan, actor access/authority, manifest, and prerequisites
   before exposing frozen pointers and `expense_settlement_schema_version=2` /
   `financial_write_guard_version=2`. Interrupted staging is resumable; stale history needs a new run.
5. Correct/reconcile guarded historical cases explicitly before activation. Corrections and credit
   mappings work in a guarded v2 group while new quotes/intents remain blocked. No backfill invents
   a receipt, consent, payment or automatic allocation. Evidenced links are reviewed suggestions.
6. Repeat dry-run. Source-baseline IDs are stable across runs; accepted-run retries have no additional
   effects. Only evidenced explicit allocations/retirements/voids resolve supported durable cases,
   preserving action/actor/reason. Unknown cash, missing people, suspected duplicate rows, unresolved
   attempts, legacy precision and migration adjustments remain visible blockers. There is no generic
   “ignore case” bypass. Unexplained wallet differences or any credit/review/pending work block activation.
7. Obtain separate activation authorization after the zero-difference/blocker-free report and runtime
   prerequisites pass. The final accepted run may set activation version 1. New starts also require
   the runtime flag/capability and a nonarchived group. Disabling starts retains review/history and
   all guards. Rollback after v2 adoption uses a compatible build or this kill switch; an older server
   must never resume writes to a v2 ledger. Resume maintenance traffic only after these checks.

### Validation evidence

The proportional backend regression gate passed **813 tests**, zero skipped, against explicit
task-owned loopback replica-set and standalone MongoDB processes. The selection includes correction
domain/route/Mongo suites, writer inventory, coverage/journal/workflows, share/balance/EXACT/family/
currency/conversion/migration, legacy payment/settlement routes, departure/join/mobile/profile,
idempotency, notification and XLSX/PDF tests. It ran `.venv/Scripts/python.exe -m pytest ... -q` with
safe test-only environment overrides; fixtures removed only UUID-named disposable databases.

New acceptance coverage includes ₹100→₹120/₹80, covered deletion/reversal, refund/payer/split/FX
replacement, ₹20 cash plus offsets, ₹100→₹60/void compensation, current offset quorum and reversal,
competing edits/reports/receipts/approvals, harmless edits and attachment-version races, historical
wallet reopening without access, zero-net gross blockers, stale/revoked authority, reviewed alias
binding, lost-response retries, failure rollback, interrupted/stale/repeated backfills, malformed
history/indexes and standalone fail-closed behavior. Actual XLSX/PDF output uses compensated ₹60
while preserving the original ₹100 receipt.

The final backend gate passed **105 tests**, zero skipped, including actual isolated API startup,
exports, standalone rejection, and guarded pre-activation corrections while new settlement starts
remain blocked. A subsequent **39-test** domain/correction-route gate passed after the final preview
fields were added. Reviewed admin-revocation and account-relink regressions preserve historical
approval/recipient evidence, deny former authority, stop obsolete sending, and retain exact late
receipt confirmation as credit. Dependent-bundle previews retain the correct historical approval
counts and explain recorded ₹100→₹60/void effects without claiming a physical refund.

The final full frontend gate passed **132 suites / 1,167 tests**. Account/trip switches while sign-in
is pending suppress obsolete actions; switching away and back suppresses a previous visit's report.
Offline draft preservation, explicit review submission, retry identity, proposal renewal, dependent
expense/reservation/approval explanations, and accessible sheet/focus contracts are covered. `npx tsc --noEmit`,
`npx eslint src app`, and `git diff --check` passed. The reconciliation CLI's `--help` was verified;
the CLI was not used to read or migrate a database.

No production data, provider network, notification delivery, production migration, group activation
or deployment was exercised. Local renderer accessibility/focus-contract tests do not establish
native screen-reader, supported-device or external UPI acceptance; those remain explicit release gates.

---

## Expense-tab UI implementation handoff — 7 October 2026

The approved interface plan is implemented in source. No group was activated, no production data
or index was inspected/changed, and no release was published. Existing runtime/trip activation
controls remain intact. The Google Pay attachment was unavailable; the sheet uses the approved
parties-first arrangement with existing Outfit/Figtree fonts, theme tokens and sheet components.

### UI decisions and implementation

- `app/trip/[id]/index.tsx` preserves cards, signed amounts, receipts, display-only split disclosure,
  edit/delete, search, ordering and notification navigation. It replaces the group-derived expense
  badge with `ExpenseSettlementFooter` and mounts one `ExpenseSettlementSheet`. Pending local
  expenses receive no confirmed count. Footer and split controls are independent of body editing.
- Footer actions are **Settle / View shares**. Server expense summaries supply nullable counts and
  personal status; pending/proposed money never contributes coverage. **Your share settled** stays
  visible when the personal participating share is covered while other family shares remain open.
- `ParticipantShareRow` presents share, source-separated confirmed coverage, remaining and reserved
  money, with Needs review → Settled → Awaiting approval → Partial → Unpaid precedence. Started,
  unreported work is described separately. Unknown participation/history remains review-required.
- All eligible outgoing linked-family shares are selected initially, with individual deselection
  and positive whole-unit partial amounts. Rows name the actual payer and covered people. Direct
  actions are grouped by debtor/creditor wallet; refunds reverse direction and separate recipients
  receive separate actions. Unknown family recipients require explicit person selection.
- `ReviewedSettlementFlow` reviews direct gross shares without the legacy recommendation cap.
  Optional group review shows affected expense/person allocations, actual cash parties, dependent
  legs, proposed offsets, required consent, method and locked UPI conversion. Missing share details
  disable submission. Quotes expire and changes require renewed review; offset proposals settle
  and reserve nothing. UPI payer identity stays the current linked person, including for admins.
- `ReviewedIntentPanel` distinguishes initiated, reported, received, applied and needs-review work.
  Explicit review reads current intent/detail and complete affected-share descriptions before
  receipt/consent/admin actions. Ordinary payers cannot confirm their own receipt; receiving-family
  reviewers can confirm receipt, while consent belongs only to the linked person. Current admins
  may use the existing reasoned override contract. Restricted history is fetched only on demand.
- `CoverageDetails` identifies wallet funding, direct/group payment, approved offset and inferred
  history, with recorded payer/recipient identities when available. Missing historical attribution
  is explicitly unknown; inferred coverage never claims bank or receiver verification. Financial
  review remains the correction/reconciliation path.
- `reviewedSettlement.ts` retains the same mutation UUID/body for uncertain retries, shares duplicate
  in-flight requests, and blocks a different submission until recovery. Financial review uses this
  same session recovery. Mutations are authenticated live requests and are never placed in an
  offline outbox. Returning from a UPI app cannot confirm payment/receipt.
- `useExpenseSettlement` batches summaries, fetches opened details against their snapshot, renews
  snapshot conflicts without mixing revisions, and aborts/suppresses obsolete reads. Malformed or
  legacy metadata yields unavailable financial values. Android cache schema **6** adds only a
  separate `coverage_snapshots` table; existing outbox/read bundles remain intact. Sanitized cached
  progress preserves protocol/snapshot/revision/time, removes sending authority and private
  evidence, and carries the persistent saved-progress warning. Web/iOS use session memory only.
- The shared sheet retains safe areas and its 640px cap. Its single scroll region includes reachable,
  wrapping actions; narrow/large-text rows stack monetary labels. Web checkboxes explicitly expose
  checked state and support Space; the labeled modal traps focus, closes with Escape and restores
  focus. Status text/icons and readable currency announcements supplement color.

### Verification performed

Final frontend command, from `frontend/`:

```text
npx jest --runInBand --cacheDirectory ../.release-tmp/expense-ui-20261007/jest-cache src/__tests__/expenseSettlement.test.ts src/__tests__/reviewedSettlement.test.ts src/__tests__/useExpenseSettlement.test.tsx src/__tests__/ExpenseSettlementSheet.test.tsx src/__tests__/ReviewedFlows.test.tsx src/__tests__/screens/trip-settled-badge.test.tsx src/__tests__/offlineSchema.test.ts src/__tests__/offlineStore.android.test.ts src/__tests__/offlineRetention.test.ts src/__tests__/offlineReads.test.ts src/__tests__/financialReview.test.tsx src/__tests__/financialReviewScreen.test.tsx src/__tests__/screens/settle-up-handoff.test.tsx src/__tests__/screens/settle-up-modal.test.tsx src/__tests__/screens/trip-detail-header-budget.test.tsx src/__tests__/upiLauncher.test.ts src/__tests__/notificationRouting.test.ts
```

**17 suites / 172 tests passed, zero skipped.** Coverage includes gross opposing debts at zero net,
authoritative 1/3 progress, partial coverage, reservations/report count separation, persistent own-share
settlement, proposals, family defaults/deselection, paying identities, family recipient choice,
multiple refund recipients, unknown participation, cache allowlisting, account/trip switching,
snapshot conflicts, stale recipients/versions, revoked authority, person-specific consent, reasoned
admin approval, deferred offline requests, duplicate taps and permanent retries. Existing card/search,
header, legacy settle-up/UPI, notification, offline read/storage/schema/retention and financial-review
regressions pass. Node's experimental SQLite warning is informational; those tests executed.

`npx tsc --noEmit` and affected-file `npx eslint ...` passed with no errors or warnings.
`git diff --check` passed. Initial Jest temp-cache permission errors were resolved with a workspace
cache; outdated migration/test-fixture assumptions were corrected before the final passing gate.
RTK was unavailable on this host, so the disclosed raw-command fallback was used.

Backend verification, from `backend/`, with explicit task-owned loopback replica-set settings and
test-only auth/email/push overrides:

```text
.venv/Scripts/python.exe -m pytest tests/test_settlement_intents_mongo.py tests/test_expense_coverage.py tests/test_coverage_server_mongo.py -q --tb=short
```

**81 passed / 1 skipped**, in 37.58 seconds. The skipped check requires a separately configured
standalone MongoDB; no standalone URL was configured in this UI session. UUID disposable databases
were cleaned by the existing fixtures. The gate exercises reviewed direct/group/offset reports,
receipts, dependencies, reservations, retries/races, revocation, authenticated HTTP and actual API
startup/coverage/report compatibility. No backend source changed. The existing python-multipart
deprecation warning is informational.

Browser evidence used the actual React Native Web components/fonts with disposable coverage data
and a local read-only fixture API. It verified light/dark rendering, the **640px** desktop cap,
**320px** width without horizontal overflow, simulated **180%** text, selected-state announcements,
Space deselection (₹200 → ₹100), Escape focus restoration and cached action blocking. See
[screenshots and observations](evidence/expense-settlement-ui-20261007/README.md).

### Remaining acceptance gates and limits

- Native Android layout/font scaling, TalkBack, external UPI app discovery/copy/open/return, and
  supported-device acceptance were not performed. Simulated browser text scaling is not native QA.
- Renderer/client flow tests and real backend HTTP/Mongo tests ran separately. A complete
  browser/native-client-to-real-API multi-account payment journey remains an integration gate.
- Production permissions, history reconciliation, data/index migration, deliberate activation,
  notification delivery, deployment and release remain separately authorized work. Groups without
  the existing capability/activation gates show unavailable/not-enabled progress.
- Historical names/parties or affected retired shares can remain unavailable. The interface says
  so, blocks unverifiable allocation approval, and retains authorized financial-review access.

---

## Complete payment journey execution handoff — 7 October 2026

This execution implements the approved journey in `frontend/` and the required backend integration.
The accounting contract, runtime/activation gates and existing uncommitted expense-tab work remain
intact. `q/` is untouched. No production access, migration/index maintenance, group activation,
deployment, APK publication, provider delivery or real transfer was performed.

### Completed stage 1: shared payment and reviewer journeys

- Protected Settle Up recommendations and durable history now use `ReviewedSettlementHub`,
  `ReviewedSettlementFlow` and `ReviewedIntentPanel`. Expense sheets preserve the active intent
  across projection refresh. Financial Review uses the same report/reviewer controls and retains
  correction, reconciliation and credit tools; the obsolete second payment form was removed.
- Quote review uses gross direct shares, actual paying/receiving people, covered participants,
  optional reference/note, frozen expense/date/share context and exact sending/conversion evidence.
  Receivers/admins may report already-paid cash/bank money, but report and receipt approval remain
  separate. Ordinary self-confirmation remains server-denied. Historical missing attribution is
  explicit; consent/allocation controls block when affected shares cannot be identified.
- UPI controls first read authorized evidence and create the start action. Copy/open/return do not
  post cash or coverage. App discovery has truthful unsupported/failed/empty fallback states;
  clipboard failure prevents launch. Explicit Payment sent / I did not pay / Not sure actions retain
  the original work. Changed or unavailable sending details preserve the original late-report path.
- Expired or admin-withdrawn UPI work suppresses new sending for its shares. A current linked sender's
  explicit cancellation records `unsent_resolved`; expiry/admin withdrawal alone cannot assert that
  money was never sent. Other independently eligible shares remain payable. Reported/disputed claims
  do not expire. Dispute and authorized reasoned `resolve_not_sent` remain distinct.
- Reviewer context includes frozen expense/date/people/shares, exact amounts and methods, party
  snapshots, report time/reference/note, dependency and discrepancy context, authority and decision
  history. Authorized cash/bank evidence includes the reporting actor's recorded name/authority even
  when the reviewer cannot read another cash leg's action requests. Applied coverage uses receiver/admin
  attribution; partial shares remain partially covered. Explicit unsent resolution removes the pending
  share label while preserving rejected report evidence.

### Completed stage 2: offsets, recovery, freshness and notifications

- Pure offsets transfer no money, reserve nothing, and are excluded from payment expiry, including
  pre-upgrade proposals with old deadlines. Own-person reasoned `decline_allocation` retains evidence
  and leaves the proposal unapplied. Consent/admin override cannot revive a declined proposal;
  withdrawal and a new reviewed proposal are required. Current authority, revisions and conflicting
  reservations are rechecked at final allocation. Missing linked approvers are surfaced to admins.
- Simplified plans display cash separately from offsets, all related expense coverage and dependent
  legs. Confirmed cash remains credit until prerequisites complete. Applied coverage removes duplicate
  direct actions and explains their source; pending work retains a continue/review path.
- Account/trip checkpoints persist exact body, permanent UUID and known intent ID before HTTP writes.
  Native SecureStore uses verified small chunks plus a last-written manifest without splitting Unicode
  pairs. Browser recovery uses session storage. No token is stored. Read caches and offline outboxes
  remain separate. Hydration never submits, and recovery never launches an external app. Explicit retry
  reconciles known durable action history first; changed uncommitted starts can be cleared after a
  live attributed-history check instead of trapping users in a retry loop. Storage failure prevents writes.
- A coalesced account/trip financial signal handles accepted/uncertain mutations, UPI return,
  notification receipt/tap, foreground return and corrections. Related intent/balance/queue reads
  receive a final expected-snapshot coverage check. Obsolete reads are suppressed; failed refreshes
  gate actions. Cached sanitized progress keeps its last-confirmed time and no private UPI/reference data.
  A successful start publishes its signal after native copy/discovery/launch completes, so its own
  refresh cannot interrupt a slow launch. Account/review changes still stop obsolete launches;
  uncertain responses and explicit retry recovery still refresh immediately.
- Transactional outbox events distinguish receipt requests/outcomes, allocation requests/completion,
  offset decline and explicit review closure. Payload version 2 separates `eventId` from `sourceId`;
  old source-key and already-delivered action-key notifications still route. Intent/attempt taps open
  current durable work, correction taps open authorized detail, and existing trip-access checks remain.
  Allocation outcomes target currently linked affected people and actual parties, including a sibling
  whose share was covered by a different family payer; lock-screen payloads omit private payment evidence.

### Completed stage 3: real client/API acceptance

`backend/tests/test_payment_journey_client_mongo.py` launches the full API against a UUID disposable
database in the task-owned loopback replica set and runs the actual primary React components/API
helpers from `frontend/src/__tests__/paymentJourney.integration.test.tsx`. Presentation, network
availability and external app seams are stubbed; quotes, intents, report/approval requests, auth,
coverage and retry reconciliation travel through real HTTP and MongoDB transactions.

The final joined gate passed **18 client acceptance tests / 1 backend harness test**. It covers:

- UPI creation/start with launch/copy failure, a slow successful launch and simulated app return,
  no coverage before reporting/receipt approval, a lost committed report response, and ₹40 approval
  leaving ₹60 outstanding with zero fully settled shares.
- Cash/bank/receiver-created reports pending a separate receipt decision, restricted reviewer evidence
  and reporting-actor attribution, ordinary self-confirmation/outsider/cross-trip denial.
- Direct ₹100 versus simplified ₹20+₹80 offsets, cash waiting for person consents, duplicate covered
  direct denial, pure-offset reasoned admin approval, own-person decline/withdrawal, unavailable
  approvers, and stale consent rejected after a financial correction while frozen evidence survives.
- Runtime module restart at create/start/report/approval boundaries with persistent browser checkpoints,
  reconciliation before retry, one HTTP financial effect per boundary, and no automatic launch.
- Concurrent direct/group reservation exclusion, recipient-change sending denial, original party
  evidence and exact retained credit, dispute versus explicit unsent resolution, three-day pending
  reports surviving the sweeper, and late reporting after expiry.
- Two-leg/four-person dependent bundle receipt replay and final consent, family payer/sibling coverage,
  receiving-family receipt authority, zero-rounded shares and refund directions.
- Open Settle Up convergence after another account's approval and a simulated notification signal,
  removal of the covered route, actual sanitized saved-progress reads offline, no offline HTTP writes,
  and cache isolation after account switching.

The harness checks exact payment/journal counts, **15 allocation-completion notifications** and unique
durable event keys in the database. It removes its generated namespace and child API process. The
recipient-profile fixture uses a separate receiving account so it cannot invalidate the pre-seeded
aged-report case. Test-only correction indexes are installed exclusively in each disposable namespace.

### Verification and remaining gates

Broad frontend gate, from `frontend/`:

```text
rtk npx jest --runInBand --cacheDirectory ../.release-tmp/payment-journey-20261007/jest-cache
```

**140 suites / 1,218 tests passed**, in 87.80 seconds. The fixture-dependent integration suite's
17 tests were skipped in this ordinary invocation and ran successfully through the joined harness.
This broad gate preceded the final slow-launch signal-timing refinement and the added eighteenth
integration scenario. The final focused gate below verifies the refined production code.

Final focused frontend gate:

```text
rtk npx jest --runInBand --cacheDirectory ../.release-tmp/payment-journey-20261007/jest-cache src/__tests__/expenseSettlement.test.ts src/__tests__/ReviewedFlows.test.tsx src/__tests__/ExpenseSettlementSheet.test.tsx src/__tests__/reviewedRecovery.test.ts src/__tests__/reviewedSettlement.test.ts src/__tests__/financialRecoveryStorage.native.test.ts src/__tests__/financialRefresh.test.tsx src/__tests__/financialReviewScreen.test.tsx src/__tests__/upiLauncher.test.ts src/__tests__/notificationRouting.test.ts src/__tests__/PushNotificationCoordinator.android.test.tsx
```

**11 suites / 67 tests passed**, zero skipped, in 16.94 seconds. This includes the final handoff timing,
reviewer panel, terminal-unsent share state, storage/retry, freshness and notification regressions.

Proportional backend gate, from `backend/`, with task-owned loopback replica-set settings and
test-only authentication/email/push settings:

```text
rtk .venv/Scripts/python.exe -m pytest tests/test_settlement_intents_mongo.py tests/test_expense_coverage.py tests/test_coverage_journal_mongo.py tests/test_coverage_server_mongo.py tests/test_financial_corrections.py tests/test_financial_corrections_mongo.py tests/test_correction_safeguards_mongo.py tests/test_financial_writer_inventory.py tests/test_payment_attempts.py tests/test_payment_idempotency.py tests/test_payment_idempotency_mongo.py tests/test_push_notifications.py tests/test_notification_triggers.py tests/test_payment_journey_client_mongo.py -q -s --tb=short
```

**304 passed / 1 skipped**, in 145.43 seconds. The skipped check requires a separately configured
standalone MongoDB. It includes transaction/outbox rollback boundaries, concurrent approval/retry,
offset expiry/decline, family outcome recipients, restricted reporting attribution and the then-current
17 joined scenarios. Backend production source did not change after this passing gate.

The final expanded joined gate used:

```text
rtk .venv/Scripts/python.exe -m pytest tests/test_payment_journey_client_mongo.py -q -s --tb=short
```

**1 backend harness passed / all 18 client scenarios passed**, in 28.85 seconds. Its successful
launch/return is a native seam simulation against real HTTP/account/transaction/coverage behavior.
TypeScript (`rtk npx tsc --noEmit`), affected-file ESLint and `rtk git diff --check` passed.
Node's experimental SQLite and python-multipart deprecation warnings did not skip their tests.
Earlier failures were fixture/expectation issues (required correction indexes, canceled stale consent,
shared profile invalidation and test-only app-state restoration) and were corrected before these gates.
Final source/status review preserved existing expense-tab work and confirmed `q/` unchanged. Generated
client-test namespaces and child APIs were cleaned, and the verified task-owned loopback MongoDB
process was stopped after verification. No commit or release was requested or created.

Native Android API 24/36 app discovery, external copy/open/return, physical process restart,
font scaling and TalkBack remain device acceptance gates. Simulated launch seams and SecureStore
contract tests do not verify a provider, bank, operating system or notification delivery. Browser
tab reload recovery is tab-scoped; closing the tab requires finding existing server work. Existing
activation/migration and release authorization remain separate. No screenshot evidence upload was added.
