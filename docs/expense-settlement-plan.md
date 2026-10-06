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
