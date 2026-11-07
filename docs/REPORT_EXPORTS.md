# Excel and PDF report exports

The existing `/api/trips/{trip_id}/report.xlsx?token=...` and
`/api/trips/{trip_id}/report.pdf?token=...` downloads share one reporting pipeline. The Reports
screens, authentication, response types and `<group_name>_report` filename convention are unchanged.
The JSON report endpoint retains its existing response shape and aggregation.

## Data flow and financial boundaries

`routes/reports.py` authorises the requester and loads the trip, all expenses, eligible legacy
settlements, all recorded payments and the migration vector once per export. It creates a
`ReportSnapshot`; `services/report_model.py` produces typed report metadata, allocations, account
summaries, family member positions, settlement events, adjustments and suggested transfers.

The original authoritative calculation was extracted into `services/balance_snapshot.py`.
`utils/balances.py` still loads records for the existing balances API and delegates to that pure
function. Ledger rules, direct/simplified routing, locked currency conversions and whole-unit
rounding were not redesigned.

For each settlement account:

```
Balance now = Net funded - Expense share + Settlements paid - Settlements received + Adjustments
```

- Expense shares come from `expense_entity_shares_scaled`, not backwards from final balances.
  Whole-unit account allocations use the existing apportionment policy. Family amounts are divided
  within the same account using the existing allocation helpers and explicit Exact allocations.
- Genuine zero participants remain in the allocation source. Nonparticipants do not get fabricated
  transaction rows. Child share and final-position columns have different meanings; family funding
  and payment history are never assigned to children.
- Departed Exact participants retain their saved person-to-family mapping. Historical names are
  labelled using stable IDs rather than invented personal names. Missing individual attribution is
  explicit. An unresolved historical ledger position returns the existing ledger-review error.
- Each eligible settlement/payment source row is included once. Distinct records with matching
  parties, amounts or timestamps are retained. Gross paid and received measures are separate.
  Pending legacy settlements and suggested transfers are excluded from recorded history.
- Migration vector entries are separate adjustments. A historical precision bridge is allowed only
  when fractional source evidence exists, the independent source components match the scaled ledger,
  and the final position matches the authoritative joint whole-unit projection. Whole-unit records
  cannot acquire a balancing adjustment. Unexplained differences return HTTP 409 before a download.
- Still to settle is the sum of the selected transfer instructions. Direct repayment can require
  more gross transfers than the sum of positive net balances.
- Trip dates, included expense dates and settlement dates are distinct. Summary metadata omits member
  counts, share code, the separate currency field and export time. It also omits the snapshot caption.
  Missing transaction times display as dates without an invented midnight. Financial updates require
  a fresh app export.

The original private reference workbook is neither an application template nor a test fixture.
Its historical differences are not used as compensating values in the ledger or reports.

## Excel implementation

`services/report_xlsx.py` writes five tabs: Summary, Members & Families, Expense Register,
Transactions and Payments. The presentation omits adjustment columns, reconciliation commentary, payment notes and
the optional Financial Review appendix. Supporting adjustments and correction evidence remain in the
shared model and source ledger, with unchanged final balances and reconciliation checks. There is no
Adjustments tab or dangling worksheet hyperlink. `services/report_formatting.py` holds shared
branding, semantic colours, currency symbols and Indian grouping.

`services/report_pivot.py` is a dedicated adapter for the pinned openpyxl 3.1.5 OOXML types. It writes
the pivot definition, cache definition, complete cache records and matching initial worksheet cells.
The named Excel Table `ReportAllocations` supplies account/person rows, category columns and summed
signed Expense share. Date and entry-type report filters are native fields. All source fields remain
available for analysis and drill-through. Cached results do not require refresh on opening.
The cache identifies the Transactions source sheet explicitly. Its type flags describe the stored
items, including text, long descriptions, missing values and mixed date/text evidence.

The pivot uses a custom forest-green style, account subtotals and one grand total. Its page filters
use matching label/value styles in both the saved cells and native style definition. Displayed
categories and people follow the order of their native field items; axis references point to field-item
positions rather than assuming cache encounter order. Saved measure and grand-total captions match
the native definitions, and tabular account labels appear once per group. Children are
already included in account subtotals and never counted twice. Numeric conditional formats choose
the correct Indian grouping magnitude when pivot filters change a total. Custom number-format IDs
are registered explicitly rather than reusing General's built-in ID. The rules are bound to the
native pivot data area, including totals, rather than just the original cell rectangle. Money-back shares are green;
cost shares do not imply a payment instruction. Source text is stored literally, including strings
beginning with `=`. Transactions omits Account ID and Person ID columns from both the source table and
pivot cache. Stable identities remain internal, with disambiguated display names in the report.
The expense ID and original-currency/rate evidence in Transactions are grouped in columns L:T. Monetary headings use
the trip's currency; original-currency evidence retains its recorded currency.

XLSX presentation uses a separate copy of the reconciled model. Unsupported XML characters are
replaced, line endings are normalised, and text is limited to Excel's 32,767-character cell limit
with an ellipsis on truncation. Distinct category/account/person labels remain distinct after these
conversions and under Excel's case-insensitive comparisons. The source table and pivot cache use the
same prepared values. Internal account/person IDs and all financial amounts remain unchanged.
Row heights respect Excel's 409.5-point maximum. Download headers support Unicode group names through
the standard UTF-8 filename parameter and remove path/header delimiters.

Summary presents its four spending measures vertically in a Measure/Amount table, alongside account
funding. The person/category pivot follows immediately below the fixed tables, leaving its expansion
area clear. It has bold account/grand totals and a
bold Grand Total column, including a native last-column style. A scope label above the two native
filters states that only the pivot is filtered. There are no charts
or chart helper columns. Summary remains unfrozen. Members & Families, Transactions and Payments freeze
the first two rows through their main headers. Payments omits the Routing / payment-plan caption row.
Headers follow titles directly, row heights fit their
content, hidden detail does not inflate visible rows, and unused spacer rows/columns are omitted.
The final Total row in Members & Families matches the dark green header with bold white text;
balance and refund colour rules apply only to the detail rows above it.
Pivot filters affect only the pivot; headline figures continue to represent the complete export.
Empty reports show a meaningful message and contain no dummy allocation rows or pivot.

Expense Register contains one row per included expense, with report number, sortable date, category,
description, entry type, payer, split method and signed amount. The named table `ReportExpenses` supports
column filters and sorting. Full-export gross, money-back and net totals reconcile to Summary, with
filter scope stated beside them. Money back is negative in the register; it is shown as a positive
deduction in the top spending totals. Expense IDs and original-currency/rate evidence are grouped in
columns I:Q. Included zero amounts and distinct records with matching or missing historical IDs are
retained by report number. Transactions remains the participant-allocation source for the pivot; use
Expense Register when summing full expense amounts to avoid counting the same expense per participant.
The register has a forest-green table style, repeated print headers and frozen rows above its data.
All five worksheet tabs have an explicit brand colour.

## PDF implementation

`services/report_pdf.py` consumes the same finished report data. It uses A4 landscape, embedded
Noto Sans (included under `backend/assets/fonts` with its OFL licence), 10.5-point table text,
repeated headers and page numbers. Category matrices use up to four categories per band, with
identifiers repeated and bold all-category totals in the final band. Transactions are expense groups
with structured expense metadata, participant allocations and source IDs beneath them.
Long text can wrap and table rows can split across pages. Extra pages preserve readable type.
Every financial column uses the trip's currency. Spending measures are vertical, with compact table
padding and no charts, adjustment columns or report notes. FX source evidence remains structured data.

## Reproducing review samples

### Production startup compatibility

Older production databases have a unique, nonpartial `payment_attempts.quote_id_1` index. With
`EXPENSE_SETTLEMENT_ENABLED=false`, startup retains that exact legacy index so report releases can
run without activating or migrating the newer settlement workflow. Startup does not drop or replace
the index, and existing payment-attempt records remain unchanged. Unexpected key, uniqueness,
sparse, collation or TTL definitions still fail closed.

Enabling the newer workflow still requires its separately reviewed partial-index compatibility
upgrade. Its default installer continues to reject an incompatible index. Report deployment does
not authorize or perform that database maintenance. A real local replica-set regression exercises
startup, authenticated XLSX/PDF downloads, retained history and duplicate-quote rejection with both
fresh and legacy index definitions.

### Synthetic review files

From `backend`, run:

```
python scripts/generate_report_samples.py --output <review-directory>
```

This uses synthetic data only and does not connect to a database. The sample includes multiple split
modes, partial families, refunds, zero allocations, duplicate names, historical people/accounts,
locked FX evidence, legacy settlements, distinct matching payments and migration adjustments.

## Pivot and expense-register verification (7 November 2026)

The focused report/model/layout/PDF/download suite passes 147 tests. A further 116 financial and
database integration checks cover allocation, conversion, settlement, retained corrections, and
actual server startup/downloads against a private loopback replica set. Regression checks resolve saved
axis references back to cache values and compare them with displayed captions and amounts. They also
verify cache type flags, page-filter styles, pivot-scoped conditional rules and custom format IDs in the actual XLSX
parts, plus register totals, unique expense rows, literal text, refunds, zero rounding, historical IDs,
missing dates, empty exports, Unicode filenames, unsupported/long text, and large funding/category layouts.
The 20 download checks use synthetic
data and mocked storage; local loopback access is needed by the Windows test event loop.

All five sample workbook tabs were rendered and visually reviewed. Desktop Excel refresh, filtering,
drill-through and no-repair opening remain unverified because Excel automation is unavailable on this
machine (`0x80040154`, Class not registered). openpyxl's reader drops native pivot conditional-format
metadata and rebases cell number-format IDs, so raw exported XML is the source of truth for those
assertions. Existing downloaded reports must be replaced by a fresh export after release.

## Compact-layout verification (3 November 2026)

The focused report/model/layout checks passed 116 unique tests, including the final PDF grouping check.
Authenticated download contract checks and
the effective-ledger correction regression suite passed a further 36 tests against an isolated local
replica set. The checks confirm cached person/category shares, unchanged final balances, no frozen
panes or chart parts, transposed spending measures, omitted adjustment columns/notes, and bold totals.
These are synthetic tests; no production financial records or private workbook are used.
All four final workbook tabs and all 13 sample PDF pages were visually reviewed. Native desktop
Excel interaction remains unverified; this presentation revision has not yet been deployed.

## Previous verification record

The final focused export suite passed 54 tests, including AED/EUR currency and compact-layout checks.
The wider offline financial regression run passed 241 tests before the additional PDF continuation
and presentation checks were added. All four revised sample workbook tabs and all 16 final PDF pages
were visually reviewed.

- Offline report, balance, settlement, direct-routing, split and currency tests cover arithmetic,
  source completeness, unchanged authoritative results, literal text, cache/source consistency,
  account/child boundaries, missing dates, empty groups, wide category sets and financial parity.
- Local ASGI HTTP tests exercise the unchanged download URLs, required token, streamed response
  types, filenames, access failures and reconciliation failures using synthetic database doubles.
- Generated workbooks are reopened and their XML parts, cached pivot records, person/category totals,
  named tables and styles are checked. All workbook tabs are rendered with the bundled preview tool.
- Every page of the representative PDF is rendered for visual review. Text extraction additionally
  checks totals, source identities, repeated page numbers, embedded fonts and the rupee glyph.
- Native desktop Excel was attempted, but this machine's Excel fails to start with `0xc0000142`
  before it reads the workbook. No-repair opening, native field-list behaviour, expansion/collapse,
  filtering, refresh, drill-through and effective native number formats therefore remain unverified.
  The bundled preview is not a substitute for these acceptance checks.
- The older live-server tests require a running disposable API/database; no server was listening at
  localhost:8000 during this run. The offline HTTP tests do not claim live-database coverage.

Before release, open a freshly generated workbook in a working desktop Excel installation. Confirm
no repair prompt, inspect the field list, collapse/expand a family, filter to small and large totals,
refresh from `ReportAllocations`, and double-click a value to inspect contributing rows. Confirm the
saved values before refresh match the PDF, and that local analysis makes no app-data changes.
