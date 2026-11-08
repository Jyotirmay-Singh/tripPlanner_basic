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

## Multiple currencies and saved exchange rates

Each group has one fixed ledger/report currency. An expense may originate in another supported
currency, but its approved converted `amount` is saved in the group currency. Balances, report
totals and category shares use that saved amount. Exporting never fetches a new rate, reloads a quote,
or recalculates an old expense at today's rate. Different expenses in the same original currency
may retain different approved historical rates.

The existing `whole_unit_v1` policy is retained by explicit user choice: source money is rounded
half-up to a whole original-currency unit before conversion, and converted money is rounded half-up
to a whole group-currency unit. Rates retain their stored decimal precision. Multiplication uses
enough Decimal precision to avoid crossing a whole-unit midpoint before the money rounding step.
For example, `10 * 0.1499999999999999999999999999999999` rounds to `1`, and the corresponding refund
rounds to `-1`. Rates that cannot be represented by BSON Decimal128 return a validation/provider
error instead of an internal storage exception.

When exchange evidence is needed, Transactions displays Original currency, Original amount and
Stored rate in expanded columns J:L. Expense totals and shares follow in M:N, with Effective rate
date in O. Rate provider, rate mode, requested rate date, original exact allocations and internal
expense IDs are omitted from this tab. Monetary headings state the group currency, and the stored
rate heading states the group-currency amount per original unit.
Missing original currency with conversion evidence displays `Not recorded`; it is not reconstructed
from the group currency. Legacy records without any FX evidence retain the group-currency fallback.

XLSX, PDF and JSON reports reject an included expense, payment or recorded settlement explicitly
tagged with a different canonical currency, returning HTTP 409 for review before presenting totals.
Original foreign currency metadata is allowed. Historical records without a canonical currency tag
continue to inherit the group currency; pending legacy settlements remain excluded. This safeguard
does not change stored financial records or silently reconvert them.

### FX verification (7 November 2026)

The exchange-rate repair regression run passed **398 tests** across quotes, conversion services/routes,
report generation/downloads, currency precision, currency lock, balances, split allocation, payment
handoffs and effective-ledger corrections. A separate frontend run passed **24 tests** covering the
quote hook, conversion panel, currency picker, offline conversion and expense payloads.

- Four reporting currencies (INR, EUR, AED and KWD) exercise automatic quotes, manual rates, manual
  final amounts, signed refunds, Per-Person/Per-Family/Exact splits and saved report totals.
- A ten-source-currency scenario reconciles INR, USD, EUR, GBP, AED, JPY, KRW, KWD, BHD and OMR into
  the register and balance calculations.
- Real authenticated HTTP flows against disposable loopback MongoDB replica sets create INR/AED
  groups and expenses, change a cached reference rate, edit an old description and repeatedly
  download XLSX/PDF/JSON reports. Saved amounts/rates/versions remain unchanged. Incorrect canonical
  currency fixtures produce HTTP 409. No production financial records are used.
- Read-only live Frankfurter requests succeeded for historical USD/INR, EUR/AED and JPY/KWD pairs.
  Failure/retry/cache/weekend behavior is covered separately by controlled provider fixtures.
- The mixed-currency workbook and its expanded FX headers were rendered and visually reviewed.
  Native desktop Excel refresh remains unverified because Excel automation is unavailable on this
  machine; the preview does not establish native Excel acceptance.

### Automatic Excel layout selection

`services/report_excel_layout.py` defines `ExcelReportType` and a pure
`select_excel_report_type(ReportData)` selector. The export selects its layout once from the
reconciled included allocations, before preparing the Excel-only display copy:

- `single_currency`: every included original currency matches the group currency.
  Exchange columns are omitted from Transactions and its named
  table. Legacy group-currency expenses and empty groups use this layout.
- `multi_currency`: any original currency differs from the group currency, or the historical source
  currency is unknown. This includes a group containing expenses in just one foreign source
  currency. Original currency, original amount and stored rate are visible in the expanded J:L
  group, with Effective rate date in O. No columns in Transactions are hidden by default.

Both layouts use the same reconciled financial model and worksheet builders. Transactions retains
its existing styling and numeric formats. Selection performs no database/provider
access and does not revalue expenses. All four sheets, public download URLs, signed whole-unit
amounts and existing scope labels are retained. Workbook subject metadata records format 7 and
the selected layout.

Transactions has 11 source columns for the compact layout or 15 for the detailed layout.
The static Summary category
matrix is built independently from reconciled allocations and is identical for equivalent financial
inputs in either currency layout. Print areas include the original currency, amount, rate and effective date
columns in the detailed Transactions layout. A later export switches back to compact automatically
when the last included foreign expense is removed.

### Automatic layout verification (7 November 2026)

The final combined report/financial regression suite passed **538 tests**, with no failures or skips.
This includes **140 new layout tests** plus the existing FX, report, balance, split, payment-handoff
and effective-ledger correction checks. The existing multipart dependency emitted one deprecation
warning. Python compilation and `git diff --check` also passed.

- All 26 supported group currencies exercise legacy and saved identity expenses, mixed currencies
  and a single foreign source currency. Both layouts cover Per-Person, Per-Family and Exact family
  splits, refunds, empty groups, included zero rows, duplicate IDs, missing dates and literal text.
- Reopened workbooks verify table/filter widths, visible and grouped columns, print areas, frozen
  headers, complete pivot cache records, field references and independent category totals. Every
  generated XML part parses. Large deterministic scenarios cover 120 signed expenses across 13
  categories with both debt-routing modes and recorded payments.
- Authenticated INR/AED HTTP tests against disposable local replica sets download compact reports,
  add foreign expenses, download detailed reports, remove the foreign expenses and download compact
  reports again. Their saved rates and totals remain consistent; incorrect canonical currencies
  still return HTTP 409. No production financial data is written.
- Both sample workbooks were rendered. The affected worksheets were visually reviewed, including
  the visible rate headings and whole original amounts. Historical fractional amounts are preserved
  by round-trip tests. Members & Families and Payments render identically for identical financial
  inputs in either layout.
- Native Excel refresh/filter/drill-through acceptance remains unverified because a working desktop
  Excel installation is unavailable. The XML/cache and preview checks do not replace that acceptance.

## Excel implementation

`services/report_xlsx.py` writes four tabs: Summary, Members & Families, Transactions and Payments.
There is no Expense Register or Adjustments tab. `services/report_formatting.py` provides branding,
semantic colours, currency symbols and numeric Indian grouping. All financial values come from the
existing reconciled report model; this presentation change does not change PDF/JSON behavior,
download URLs, authentication, database schemas, or rounding policy. Workbook subject metadata
records format 7 and the automatic currency layout.

### Static category summary

`services/report_summary_table.py` builds the normal Excel Table `ReportCategoryShares` beneath
Summary's spending measures and account funding. It aggregates signed allocation shares by stable
account/person IDs and category, using current account/family roster order. Historical people follow
in deterministic name/ID order. Each participating person appears once, with the family/account
repeated on every row. Genuine zero participants remain; nonparticipants are not fabricated.

Columns are Family / account, Person, one column per included category, and Grand Total. Missing
person/category combinations are numeric zero. There are no family subtotal rows. One dark-green
Grand Total footer uses full-report category totals and net spending and sits outside the table's
filter range. A bold Grand Total column and alternating green/white detail rows distinguish the
matrix. Refund shares are green and negative; cost shares do not imply payment instructions.

All cells contain saved values, without cell formulas, cross-sheet calculation references, pivot
parts, caches, connections, refresh controls or drill-through machinery. The date and entry-type
pivot selectors are removed. Ordinary table sorting/filtering is enabled, with the explicit caption:
“Filters hide table rows only. Grand totals and headline figures cover the full report.” Filtering
hides rows without recalculating the footer. Changes to app data require a fresh export; editing
Transactions inside a downloaded file does not rebuild the independent Summary snapshot.

Category headings are unique under Excel's case-insensitive comparison and respect a 255 UTF-16
unit limit without splitting surrogate pairs. Reserved-heading collisions receive category suffixes;
long headings are shortened with an ellipsis. When a heading changes, its comment retains the full
prepared category name. Category-to-value mapping and original financial amounts are preserved.
The obsolete `report_pivot.py` adapter and its pivot-specific formatting are removed.

### Members & Families

The eight columns are Name, Expense share, Net funded, Before settlements, Settlements paid,
Settlements received, Balance now and Action. Each family, individual and historical account has
a highlighted, bold summary row. Family members follow their account in plain rows, with names
indented in the same Name column. Person actions say Within family total or Historical share only.

Person expense shares and available within-family balances retain their existing values. Funding,
before-settlement and payment amounts belonging to a family account remain blank on person rows;
they are never invented or redistributed. Account-level funding and settlements are shown on the
highlighted account rows. The dark-green Total footer is calculated from authoritative accounts,
so family totals and member details are not counted twice. Balance/refund colours apply above
the final footer, which keeps bold white text matching the headers. The compact table ends at
the footer, without extra captions, blank spacer rows or merged cells.

### Shared layout and detail sheets

All four tabs use individual, unmerged cells. Titles and wide captions flow across blank cells;
table text wraps, with row heights capped at Excel's 409.5 points. Summary remains unfrozen; all
other tabs freeze their first two rows. Print areas and repeated headers cover the finished tables.
The category matrix starts after both spending and funding tables, including large account lists.
Empty reports show a meaningful message without dummy summary or allocation tables. All worksheet
tabs have an explicit brand colour. Payments retains its suggested transfers and recorded history
and omits the Routing / payment-plan caption.

Transactions remains the detailed expense table `ReportAllocations`. Expense share is additive;
Expense total repeats for participating people, so group by Expense No when checking whole-expense
totals. Included zeros and distinct records with duplicate/missing historical IDs retain their report
numbers. Foreign-currency layouts show original currency, original amount and stored rate
in expanded columns J:L, monetary totals in M:N and Effective rate date in O; compact layouts end at K.
Monetary headings use the group currency. Expense IDs and other conversion metadata are omitted
from Transactions.

XLSX uses an export-only copy of the reconciled model. Unsupported XML text is replaced, line endings
are normalized, and cell text is limited to 32,767 characters with visible truncation. Distinct names
and categories remain distinct after preparation. Literal strings beginning with = remain text.
Internal identities and financial amounts are untouched. Numeric amounts stay numeric, with Indian
number formats. Unicode download names use the standard UTF-8 filename parameter and strip path/header
delimiters. Existing downloaded workbooks must be replaced after release.

### Static-table verification (8 November 2026)

The combined report and financial regression suite passed **587 tests**, including 49 new checks for
variable dates/categories, reserved/long Unicode headings, flat family details, historical records,
zero shares and fixed-value filtering. The retained currency matrix covers all 26 supported group
currencies, single foreign source currencies, saved rates, refunds, Per-Person/Per-Family/Exact splits
and both debt-routing modes. Independent checks reconcile every saved person/category amount against
Transactions and verify full-report footer totals and authoritative Members account totals.

Authenticated HTTP checks on disposable local MongoDB replica sets exercise both currency layouts,
adding/removing foreign expenses, effective-ledger corrections and XLSX/PDF/JSON downloads. XLSX readers
and raw package checks confirm normal filter ranges, no merged cells, no pivot definitions/caches or
relationships, no external calculation connections and no worksheet formulas. Production financial
records are not used for these tests. The existing multipart dependency emits one deprecation warning.

Both currency layouts were rendered, including 36-category examples and 20-family/41-person examples.
All four tabs and the wide headings, funding/table boundary and final total regions were reviewed.
Native desktop Excel interaction remains unverified on this machine; package, reader and preview checks
do not establish a native no-repair opening. Pivot refresh is no longer part of the export behavior.

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

## Previous pivot and expense-register verification (7 November 2026)

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

For native Excel acceptance, open a fresh format-7 report and confirm no repair prompt. Verify normal
category-table filters and sorting, the fixed Grand Total footer outside that table, independent
Summary values, unmerged cells, readable headings and consistent saved amounts. There should be no
PivotTable field list, refresh connection or pivot drill-through. Local workbook analysis makes no
app-data changes.
