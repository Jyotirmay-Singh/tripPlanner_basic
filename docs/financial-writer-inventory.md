# Financial writer inventory — protocol 2

The maintained function-level inventory is [financial-writer-inventory.json](financial-writer-inventory.json).
It records an explicit policy for every mutating HTTP route and database writer in routes, services,
scripts, utilities, and startup. `backend/tests/test_financial_writer_inventory.py` fails when a
writer is added, removed, or renamed without reviewing its policy. Nested transaction callbacks
have their own parent-qualified entries. GridFS staging and deletion are included.

A protection marker is persistent: either a nonzero `expense_settlement_activation_version` or
`financial_write_guard_version` protects a group. The runtime kill switch never permits old writes.
Schema/guard version 2 is required for corrections and reconciliation. Version 1 history stays
readable and its reviewed settlement workflows remain supported; it must undergo the explicit
upgrade before financial corrections become available. Unsupported versions fail closed.

## Route policies

All paths below are beneath `/api`. Protected financial writes use required snapshot transactions
with majority write concern, reload the current user/group authority, and advance the group version.
There is no standalone financial fallback. Harmless changes use their own permission-checked
transaction and preserve the financial snapshot.

| Writer | Protected-group policy |
|---|---|
| `POST /trips/{id}/expenses` | Permanent expense mutation UUID and roster preconditions; store authoritative revision atomically. No legacy create without reviewed idempotency preconditions. |
| `PATCH /trips/{id}/expenses/{expense}` | Financial changes accept `CorrectionCreate`; unchanged echoed values and harmless description/category/time updates use `harmless_updates`. |
| `POST .../expenses/{expense}/reconvert`, `DELETE .../expenses/{expense}` | Reviewed replacement/tombstone correction only; path and operation are bound inside the mutation transaction. |
| `POST/DELETE .../expenses/{expense}/receipt` | Stage a new blob, then version the visible pointer. Preserve older blobs/inline evidence and references. No destructive protected cascade. |
| `POST .../payments`, `POST .../settle`, `POST .../settlements` | `ReviewedWrite` delegates to one settlement intent, with separate report/receipt/allocation states. It does not fabricate receipt approval. |
| `PATCH .../settlements/{settlement}` | A reviewed pending transition binds the original row to the intent and keeps it as a noneffective pending alias. Financial changes to effective history require a source correction. |
| `PATCH/DELETE .../payments/{payment}` | Note-only updates remain possible. Amount/removal accepts a path-bound source correction; original confirmed receipt remains immutable. |
| Payment handoff preview; `POST .../payment-attempts` | Old protected starts are blocked. New sending begins through reviewed quotes/intents. |
| `PATCH .../payment-attempts/{attempt}/sender` or `/recipient` | Settlement-bound attempts delegate with mutation/version/hash checks. Unknown legacy attempts stay guarded review evidence; their old action contract is blocked. |
| Settlement quotes/intents/leg actions/approvals | Current share, source, reservation, party, recipient revision, and approval checks. Exact reported money survives stale allocation. Offset viewing/quoting has no financial effect. |
| Correction preview/create/action | Bind exact operation/targets/effects/hash; creator/admin uncovered change, current admin financial correction, person quorum or reasoned admin offset reversal. Reversal is a new compensation. |
| Reconciliation preview/apply | Current admin explicitly maps retained sources or a conserving offset. No new cash; no automatic acceptance of a recommendation. |
| Members create/PATCH/DELETE; family-submember DELETE | Reviewed roster corrections. Bulk arrays cannot bypass gross blockers or remove the wrong person. Past shares remain frozen; retrospective reallocation is separate. |
| Join/claim/clean-stub replacement; join-request approval | Legacy protected identity replacement is blocked. Admins use reviewed `add_member`/`link_person` while retaining the stable person ID. New links inherit no earlier consent. |
| Join request create/cancel/reject, invites/reset/revoke | Request/invite metadata only. They grant no membership or financial authority. |
| Admin grant/revoke and ownership transfer | Reviewed owner/super-admin actions. Authority version changes invalidate affected pending work; applied approvals remain evidence. |
| Membership leave | Reviewed `leave_group`; gross shares, credits, reports, reservations and durable review cases block removal even at zero net. Owner transfers ownership first. Last-person dissolution must be explicit. |
| Account DELETE | Requires reviewed departure from every protected group first. Legacy financial scrubbing excludes protected records and permanent retry evidence. |
| Trip DELETE | Reviewed archival after gross financial blockers clear. Retain revisions, cash, attachments and history; no protected cascade. |
| UPI profile PATCH | Increment recipient-account revision and invalidate pending bindings in the same required transaction. Retain reported/confirmed work and original recipient evidence. |
| Mobile profile/claim helpers | Required transactions for protected linked groups; claim projection never changes historical identity/allocations. Startup repair skips protected groups. |
| Group name/budget/date, activity, auth credentials, chat, push devices | Explicit harmless/exempt policies. Immutable group currency, person IDs, cash and allocations cannot be changed through these contracts. |

## Background writers and administrative tools

| Writer | Policy |
|---|---|
| Settlement-intent expiry | Expire only entirely unreported starts; preserve report/receipt work indefinitely. Required transaction, group version, system action and notification outbox. |
| Legacy expired sent-report recovery | Recover protected evidence inside a required transaction. Preserve a newer attempt's unique pair key; retain duplicate-payment blockers and attributed system action. |
| Financial binding invalidation | Called inside the parent transaction. Cancel/release entirely unreported bundles; retain reported money for review. Audit and notification commit together. |
| Startup financial/identity backfills | Exclude protected groups from expense currency, settlement status, admin-list, version, family-ID and family-account rewrites. No v2 installation/backfill/activation at startup. |
| Startup auth/display/activity work | Credential retirement, authentication flags, monotonic activity and display-date housekeeping do not rewrite financial evidence. Operator promotion writes the same user document serialized by final financial approval. |
| Whole-unit migration apply/revert; income migration apply/revert; legacy reallocation | Reject protected markers. Use reviewed corrections or the explicit historical workflow. |
| Historical reconciliation tool | Explicit target variable/database/group, dry-run default, reviewed hash/current actor/reason, resumable staging and final snapshot. Separate authorization for nonloopback reads, index changes, migration application and activation. |
| Index installers | Additive creation only. Inspect definitions/duplicate/malformed keys first. Never silently replace the old incompatible UPI quote index. |
| GridFS helpers | Immutable protected staging; legacy replacement/cascades only in unprotected branches. Failed staging can leave an unreferenced blob; retention cleanup must first prove it is unreferenced by all evidence. |
| Audit/outbox delivery, FX caches, transaction probes | Evidence or operational metadata only; no allocation/cash mutation. Delivery uses current access. |

The inventory is a maintenance guard, not proof that a writer is safe. Authenticated route tests,
real transaction races/rollback checks, and the accounting conservation tests verify the policies.
Activation must also quiesce legacy writers during migration/index maintenance and review the exact
deployed build; an older server cannot safely operate a version-2 ledger.
