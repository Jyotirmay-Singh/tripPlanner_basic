# Fixed category expansion — five-session handoff

Approved scope: exactly 30 fixed categories, one category string per expense. The seven original names and Food default are preserved. Implementation was authorized after the Session 1 read-only assessment. This document records the approved design, implementation boundaries, and local verification; it does not authorize a release.

## Baseline and references

Inspection baseline on 3 October 2026: `dfc7d370c20b8400ca7a11751620dd0d1db550d3`. No tracked changes existed at the start; the unrelated untracked `.claude/settings.local.json` is preserved. Applicable AGENTS/RTK instructions and root CLAUDE.md were read. RTK was unavailable, so commands used a disclosed native-command fallback. The frontend-design skill guided the existing identity, typography, and restrained interaction design.

The prior assessment at `C:/Users/JYOTIRMAY/Documents/Codex/2026-10-02/i-want-to-evaluate-the-feasibility/outputs/category-system-feasibility.md` was used as a source map and checked against current code. Its dynamic catalog, ID migration, and multiple-category recommendations are excluded.

Public Realbyte references actually inspected in Session 1:

- [Official website](https://realbyteapps.com/): published light/dark screenshot galleries, compact transaction category fields, charts, legends, and filtering examples.
- [Android category guide](https://help.realbyteapps.com/hc/en-us/sections/360007273413-Category).
- [How to enable sub-category](https://help.realbyteapps.com/hc/en-us/articles/360015963374-How-to-enable-sub-category): article text and published settings/category-list images.

No installed Realbyte app was exercised. Published screenshots include older examples. Borrow compact category entry and the clear relationship between categories and statistics. Grouped tiles, aliases, accessibility layout, and refunds/net presentation are Trip Splitter decisions.

## Impact matrix

Locations below are repository-relative and describe current implementation boundaries. Corresponding `q/` category consumers receive a selective mirror.

| Area | Impact | Source and treatment |
|---|---|---|
| Definitions | Change | `shared/category-catalog.json`, `scripts/generate_categories.py`, `backend/category_names.py`, both `src/categoryCatalog.generated.ts`, `backend/config.py`, both `src/theme.ts`: exact ordered names and packaged metadata |
| Metadata/validation | Change definitions; verify protocol | `backend/routes/meta.py`, `backend/routes/expenses.py`: ordered string array, existing unsupported-category errors |
| Models/storage | Verification-only | `backend/models/expense.py`, expense persistence: category remains string; no category IDs or classification migration |
| Add/Edit | Change selection; verify payloads | Both `app/trip/[id]/add-expense.tsx` and `edit-expense.tsx`: reusable picker; Food default; ordinary/EXACT payloads, rehydration, money and FX retained |
| UI primitives | Change | Both `src/ui/Icon.tsx`, `Sheet.tsx`, `IconButton.tsx`, `ListRow.tsx`, `CategoryPicker.tsx`, `CategoryBadge.tsx`: explicit glyphs, additive accessibility and opt-in wrapping |
| Visible labels | Change presentation | Both trip index, pending-expense, Trips queue, category, member, and spending-period screens: full labels and category badges; captured intent unchanged |
| Routing | Verification-only | Both `src/categoryRoute.ts`, `app/_layout.tsx`: existing encoded name routes |
| Charts | Change | Both `src/categorySummary.ts`, `CategorySpendingChart.tsx`, `DonutChart.tsx`, trip Summary: positive-gross slices, stable colours, refunds/net |
| Complete reads | Change | `backend/routes/expenses.py`, `spend.py`, `server.py`; both `src/api.ts`, `offlineReads.ts`, detail loaders: remove caps and require explicit completeness |
| Offline snapshots | Change JSON handling; verify adapter | Both `offlineReads.ts`, existing `offlineStore.android.ts` and shared contracts: versioned envelope in existing read kind, legacy preservation; no SQL migration |
| Drafts/sync/retries | Verification-only | Both `offlineExpenses.ts`, `syncWorker.ts`; `backend/services/expense_idempotency.py`: protocol v1, mutation UUIDs and fingerprints unchanged |
| Reports/exports | Verification-only | `backend/routes/reports.py`, `services/report_builder.py`, `report_pdf.py`: JSON by-category remains signed net; text-only export labels and existing gross/reimbursement/net reconciliation |
| Notifications | Verification-only | Expense routes and `services/push_notifications.py`: text labels, sanitization, heading limits, snapshots and one-event behavior |
| Accounting/FX | Unaffected; regression verification | `utils/balances.py`, `services/settlement_engine.py`, `expense_conversion.py`, expense shares: no redesign |
| Expense search/trend scope | Unaffected | Both `expenseSearch.ts`, `expenseTrend.ts`: chooser aliases do not alter transaction search or category-chart scope |
| QA app | Selective change | `q/` is tracked independent QA app; its `com.tripsplitter.app.qa` identity, native config, and unrelated drift are retained |
| Tests/docs | Change | Category, form, chart, API, read/cache, screen and backend tests; `USER_GUIDE.md`, `docs/APP_FEATURE_INVENTORY.md`, this handoff |

## Packaging and public contracts

Backend Docker builds use `backend/` as context. `frontend/` and `q/` are independent Expo packages; root is not a workspace and Metro has no root-catalog runtime import configured. EAS may archive from the Git root, while web builds run from the frontend package.

Use development-time generation and checked-in package-local outputs:

1. `shared/category-catalog.json` is canonical: approved name/order, section, semantic icon, light/dark accent, aliases.
2. `scripts/generate_categories.py` produces `backend/category_names.py` and local TypeScript catalogs for frontend/q. `--check` verifies parity without writing. Invoke with an available Python interpreter; no new runtime dependency is required.
3. Backend imports only its packaged names. Frontend/q import only their local generated metadata. `theme.ts` re-exports compatible `CATEGORIES`.
4. Lucide imports are explicit; do not dynamically import the whole icon package.

`q` is a maintained QA application with independent native/config files and source history, not a disposable build output. No automatic synchronization workflow was found. Frontend remains authoritative. Review selective category changes and tests individually; retain unrelated QA typography, queue, payment and navigation differences.

Public interfaces:

- `/api/meta/categories`: exactly the 30 approved strings in approved order.
- Expense create/update and database identity: unchanged `category: string`.
- Expense-create protocol and fingerprints: unchanged version 1.
- `CategoryName`: literal union for chooser selections; persisted/read expense types remain `string`.
- `CategoryPicker`: `value: string`, `onChange(CategoryName)`, optional `disabled`, `testID`.
- Historical unknown names remain visible with a neutral Tag icon/colour; no silent rewrite.
- Expense-list body stays an array; successful complete reads add `X-Expense-List-Complete: true`, exposed through CORS.

No catalog management, selectable section parents, category IDs, multiple categories, recents-based default, allocation editor, classification migration, pagination API redesign or release work belongs to this scope.

## Design specification

### Section grouping

Sections are navigation labels only. Each category appears once; relative approved order is retained within each section. API order stays the approved 30-name order.

| Section | Categories |
|---|---|
| Travel & transport | Travel; Accommodation; Local Transportation; Local Sightseeing; Fuel; Parking & Tolls |
| Food & home | Food; Groceries; Rent; Utilities; Phone & Internet; Household Supplies; Repairs & Maintenance |
| Personal & family | Healthcare; Personal Care; Education & Training; Pets |
| Shopping & leisure | Shopping; Electronics & Equipment; Entertainment & Hobbies; Gifts & Donations; Subscriptions & Memberships |
| Money & obligations | Insurance; Taxes & Government Fees; Bank Fees & Interest |
| Work & business | Office Supplies; Professional Services; Advertising & Marketing; Shipping & Delivery |
| Other | Other |

### Icons, colours and aliases

Use Lucide at existing 1.5 stroke width. Colours are stable per category and independent of spending rank. Semantic registry keys below resolve to explicit installed Lucide glyphs.

| Approved category | Lucide symbol / key | Light / dark accent | Search aliases |
|---|---|---|---|
| Travel | Plane / `plane` | `#315C9B` / `#88B4EF` | flight, airfare, train, rail, intercity |
| Accommodation | BedDouble / `bed-double` | `#756044` / `#D2B38A` | hotel, hostel, lodging, stay |
| Local Transportation | BusFront / `bus-front` | `#2F6E81` / `#7EC2D4` | taxi, cab, auto, rickshaw, metro, bus |
| Local Sightseeing | Landmark / `landmark` | `#6C5A91` / `#B7A1D6` | attraction, museum, monument, tour |
| Food | Utensils / `utensils` | `#9A5631` / `#E2A27D` | meal, dining, restaurant, lunch, dinner, coffee |
| Groceries | ShoppingBasket / `shopping-basket` | `#447448` / `#9BC69D` | grocery, supermarket, produce |
| Fuel | Fuel / `fuel` | `#925541` / `#DCA28D` | petrol, diesel, gasoline, charging |
| Parking & Tolls | CircleParking / `circle-parking` | `#65743C` / `#B6C882` | parking, toll, highway, fastag |
| Rent | KeyRound / `key` | `#80663E` / `#D9B987` | lease, tenancy, housing rent |
| Utilities | Lightbulb / `lightbulb` | `#847120` / `#D5C36C` | electricity, power, water, gas bill |
| Phone & Internet | Wifi / `wifi` | `#386F91` / `#85BDDE` | mobile, broadband, wifi, data, recharge |
| Household Supplies | SprayCan / `spray-can` | `#427A71` / `#8BC9BE` | cleaning, detergent, home supplies |
| Repairs & Maintenance | Wrench / `wrench` | `#7D6456` / `#C9AA96` | repair, servicing, upkeep, plumbing |
| Shopping | ShoppingBag / `shopping-bag` | `#925471` / `#D99AB7` | clothes, apparel, retail |
| Electronics & Equipment | Laptop / `laptop` | `#555C97` / `#A1A9E7` | computer, laptop, device, appliance, equipment |
| Healthcare | HeartPulse / `heart-pulse` | `#9B4D55` / `#E3A0A8` | medical, doctor, hospital, medicine, pharmacy |
| Personal Care | Scissors / `scissors` | `#876087` / `#CEA4CB` | salon, haircut, grooming, cosmetics |
| Education & Training | GraduationCap / `graduation-cap` | `#4C6594` / `#94AFDD` | school, tuition, course, workshop, learning |
| Pets | PawPrint / `paw-print` | `#687645` / `#BBC98C` | pet, vet, veterinary, dog, cat |
| Entertainment & Hobbies | Gamepad2 / `gamepad-2` | `#77539B` / `#BA95DE` | cinema, movie, game, concert, hobby |
| Gifts & Donations | Gift / `gift` | `#9B526B` / `#E0A0B8` | gift, present, charity, donation |
| Subscriptions & Memberships | Repeat / `repeat` | `#516F84` / `#95BDD5` | subscription, membership, streaming, renewal |
| Insurance | ShieldCheck / `shield-check` | `#4A6D5E` / `#93BDAB` | premium, cover, policy |
| Taxes & Government Fees | Building2 / `building-2` | `#806048` / `#CFA98A` | tax, govt, government, gst, vat, permit |
| Bank Fees & Interest | CreditCard / `credit-card` | `#66705E` / `#B4C0A6` | bank charge, service fee, interest, overdraft |
| Office Supplies | Paperclip / `paperclip` | `#686693` / `#B4B0D7` | stationery, paper, printer ink |
| Professional Services | BriefcaseBusiness / `briefcase-business` | `#466879` / `#92B5C7` | consultant, accountant, legal, freelancer |
| Advertising & Marketing | Megaphone / `megaphone` | `#985342` / `#DEA08F` | advert, promotion, campaign, marketing |
| Shipping & Delivery | Truck / `truck` | `#477377` / `#8EC3C8` | courier, postage, freight, parcel, delivery |
| Other | Ellipsis / `ellipsis` | `#636D68` / `#A8B7AF` | miscellaneous, misc |

Badge backgrounds blend accent into theme surface: 8% light, 16% dark. Names use `textMain`, never category accent as body text. The design assessment calculated minimum icon contrast of 4.36:1 light and 5.59:1 dark; verify rendered states too. Main/muted text must meet 4.5:1; icon/control boundaries at least 3:1. Selected state includes checkmark, border and accessibility state beyond colour.

### Compact row

Keep the existing form position and Category label. Default Food. Full-width trigger: minimum 56dp height, 16dp horizontal/8dp vertical padding, 8dp gaps, 12dp radius. Leading 40dp badge/22dp icon and trailing chevron. Value uses Figtree Medium 16sp, native scaling and unrestricted wrapping. Long labels grow the row; no ellipsis, horizontal scrolling or shrinking. Screen-reader label: “Category, Food”; hint: “Opens category chooser.”

### Chooser

Existing bottom-sheet foundation, maximum 92% height/640dp width, safe areas respected. Title and search remain visible while options scroll. Outfit SemiBold title 20sp; Figtree SemiBold section headings 14sp; Figtree search 16sp. Placeholder “Search categories.” Outer gutters 24dp, section gaps 24dp, tile gaps 8dp.

Normal layout has two columns, three at usable content width >=552dp. Tile minimum height 96dp, padding/radius 12dp, 40dp badge/24dp glyph, Figtree Medium 14sp label. Rows have equal-height tiles with unrestricted text. Selected options have a visible checkmark, 2dp primary border, stronger weight, and radio/checked accessibility state.

Any nonblank query switches to full-width icon-and-name results: minimum 64dp height, 40dp badge, full name 16sp, section subtitle 13sp, selected checkmark. No keyboard autofocus on touch devices.

Search is immediate/local. Normalize case, whitespace, punctuation and ampersand/“and”. Require all query words to match combined name/alias terms. Rank exact name, name prefix, remaining name matches, then alias matches; ties use approved order. Aliases never replace visible/submitted names. Debounce only result-count announcements by approximately 250ms.

No results: “No categories found” / “Try another name, such as taxi or groceries.” Include a >=48dp Clear search action.

### Selection, large text and navigation

Immediate single selection closes the sheet, including tapping the existing value. It never saves/submits the expense. Opening, search, cancellation and selection preserve other form state: amount, description, date, receipt, payer, participants, split and FX.

Close button, scrim, Escape and hardware Back preserve selection. Clear search on close; reopening reveals the current selection. Native Back dismisses a visible keyboard first, then the sheet. Announce opening; return focus to the trigger. Web Tab/Shift+Tab are contained in the modal; Enter/Space activate controls; Escape closes. Decorative glyphs do not announce twice.

At native fontScale >=1.3 or usable width <264dp, use grouped full-width list rows. Native scale is applied once by Text, not multiplied in JavaScript. Row height grows with unrestricted wrapping. Every category, close, clear, legend and breakdown action has an actual >=48dp target.

Sheet additions are opt-in: category close label “Close category chooser,” 48dp control, focus containment and reduced-motion handling. Opening motion <=200ms, no bounce; reduced motion immediate. No new chart animation.

Unknown historical strings are displayed verbatim with neutral Tag glyph; they are not extra chooser options. Saving an unsupported edit requires an explicit approved choice while retaining the form. Full names wrap in trip/pending/detail/member/period screens, confirmations and chart legends. `ListRow` wrapping is opt-in to preserve unrelated consumers. Category detail has a wrapping in-page heading where native title space is insufficient.

## Wireframes

Glyph names in brackets mean Lucide icons, not exported symbols.

### Form

```text
Category
┌────────────────────────────────────┐
│ [Utensils]  Food                 ˅ │
└────────────────────────────────────┘
┌────────────────────────────────────┐
│ [Repeat]    Subscriptions &         │
│             Memberships          ˅ │
└────────────────────────────────────┘
```

### Grouped chooser

```text
Choose category                 [×]
[Search categories                 ]
Travel & transport
┌─────────────────┐ ┌───────────────┐
│ [Plane]         │ │ [BedDouble]   │
│ Travel          │ │ Accommodation │
└─────────────────┘ └───────────────┘
│ [BusFront]        │ [Landmark]
│ Local             │ Local
│ Transportation    │ Sightseeing
  Fuel                Parking & Tolls
Food & home
╔═════════════════╗ ┌───────────────┐
║ [Utensils]  ✓   ║ │ [Basket]      │
║ Food            ║ │ Groceries     │
╚═════════════════╝ └───────────────┘
Remaining sections scroll
```

### Search

```text
Choose category                 [×]
[Search] taxi                   [×]
1 category found
┌────────────────────────────────────┐
│ [BusFront] Local Transportation    │
│            Travel & transport      │
└────────────────────────────────────┘
```

### Large text

```text
Choose category                 [×]
[Search categories                 ]
Money & obligations
┌────────────────────────────────────┐
│ [Building2] Taxes & Government      │
│             Fees                   │
└────────────────────────────────────┘
┌────────────────────────────────────┐
│ [CreditCard] Bank Fees &            │
│              Interest              │
└────────────────────────────────────┘
```

### Gross/refund/net

```text
Spending by category
       Gross spending
          INR 1,500
       [two-slice pie]
[Food]  Food      66.7%  1,000 >
[Plane] Travel    33.3%    500 >
Gross spending           1,500
Refunds                    700
Net spending               800
Refunds and net by category
Category               Refunds    Net
Food                         0  1,000 >
Travel                     500      0 >
Bank Fees & Interest       200   −200 >
```

Exactly two slices/legend entries. Fully refunded Travel retains positive gross. Refund-only Bank Fees & Interest belongs in breakdown, not pie.

## Chart and complete-data contract

Use canonical confirmed expense amounts in the existing chart scope:

- Gross = sum of positive whole-unit amounts by category.
- Refunds = absolute sum of negative whole-unit amounts.
- Net = gross minus refunds, retaining negative signs.
- Slice/legend only for positive gross; legend derives from slices, never catalog.
- Sort slices descending gross, ties by catalog order; unknown-name ties deterministic.
- Breakdown includes categories with gross or refunds. Stable accents retain identity when rank changes.
- Exclude payments/settlements, pending mutations and review drafts.
- Use existing whole-unit currency helpers; no new FX or accounting rules.

Category pie remains whole-trip. Existing description search and trend period/payer controls do not filter it. Keep native chart touch handling and reliable accessible legend actions. Center/outside-center label is Gross spending; totals move outside the ring at large text. Show gross/refunds/net separately. Expand breakdown initially when refunds exist; otherwise collapsed.

Refund-only: “No positive spending in this view,” no pie/legend, retain refunds/net. Empty: “No spending yet.” Unverified: “Category totals need a complete refresh,” no complete-data chart claim. Other expense-derived statistics/budget/chart totals must also avoid reporting unverified rows as complete; show Needs refresh while retaining transactions.

Narrow complete-data solution:

1. Expense-list and payer-summary cursors are unbounded, replacing 1,000/5,000 caps. Receipt bytes remain excluded; authorization, shares and response bodies remain intact.
2. Expense-list success sets/exposes `X-Expense-List-Complete: true`.
3. Internal `readExpenses` returns `{ items, complete }`; general API helper remains compatible. Missing header means unverified, regardless of list size.
4. Trip bundle, category/member/period/edit loaders consume the helper. Category totals publish only complete confirmed data.
5. Existing expenses read kind stores `{ version: 2, complete: true, items: [...] }` and normalizes to arrays for screen consumers.
6. Legacy array snapshots remain readable, completeness false; preserve every outbox item and intent.
7. Refresh replaces cache only when existing complete-bundle conditions succeed. Failed/markerless refresh retains an earlier verified complete bundle.

No SQLite table migration, new SQL read kind, category DB migration, accounting rewrite or pagination API. Measure 1,001/5,001 fixtures; all-at-once transfer/memory cost is a bounded tradeoff, not an unlimited scalability claim.

## Five-session boundaries

| Session | Work | Exit condition |
|---|---|---|
| 1 Inspection/design | Read-only sources, working tree, Realbyte, packaging/q, completeness, tests/previews | Concrete handoff, no application writes |
| 2 Catalog/backend | Save handoff, manifest/generation, validation/meta, uncapped reads/header | Exact names/protocol and boundary tests |
| 3 Picker/forms | Icons/helpers, row, grouped/search/large-text, accessibility, Add/Edit; selective q mirror | One canonical selection; other state and ordinary/EXACT payloads retained |
| 4 Charts/labels/offline | Gross/refund/net, stable accents/full names, helper/envelope/legacy handling; q mirror | Two-slice rule, refund-only rows, intact drafts/replay |
| 5 Verification/docs | Focused/full tests, isolated Mongo/API, web QA, exports, docs/parity evidence | Local acceptance evidence and explicit device limitations; no release |

Across sessions preserve unrelated edits. Do not stage, commit, push, create PRs, build APK/AAB/native Android, deploy, publish, or send notifications externally.

## Test strategy and environment

| Area | Required scenarios |
|---|---|
| Catalog | Exactly 30 unique approved names/order; original seven/Food; generated parity; icon keys |
| Payload/validation | All categories create/update; invalid strings/arrays; ordinary/EXACT one-string payload; category-only edit retains money and locked FX |
| Picker | Each option once; select/cancel/reopen/clear/current/disabled; aliases/case/punctuation/ampersands; no results; Back/keyboard |
| Accessibility/layout | 320/360/390/768dp; font scales 1/1.3/2; longest names; >=48dp; checked radio state; web focus/return; light/dark/reduced motion |
| Charts | Empty/one/two/all30; full/over refunds; refund-only/zero/unknown; rank-independent colours; existing filter scope |
| Complete reads | 999/1000/1001/5001; oldest-only category/refund; marker absence; failed refresh; retained complete cache; legacy arrays; confirmed zero vs unavailable |
| Offline/idempotency | Original/new drafts; lost response/interrupted replay; unchanged UUID/fingerprint; account isolation; pending exclusion; envelope adapter |
| Routes/labels | All names route round-trip; long/ampersand labels; all affected screens; description fallback/notification sanitization |
| Reports/money | Signed JSON totals; PDF/XLSX text/financial reconciliation; longest labels; shares/balances/transfers/FX preserved |
| QA parity | Generated equality, corresponding category tests, reviewed selective mirror and untouched QA config |

Use existing category, DonutChart, form/detail, offline/store/sync, report/notification, conversion, split and idempotency suites plus dedicated picker/Edit/trip chart tests. Start focused, then proportional broader tests; no production mutation tests.

Backend environment: `backend/.venv` Python 3.11.3 is usable; no dependency repair required. Do not use inaccessible root `.venv`. Smallest integration setup is existing local Mongo replica set on loopback 27018 and `backend/scripts/run_isolated_tests.py`. Runner uses a fresh database, local API 18081, disables external push/Resend credentials, checks protocol readiness, and stops its API. Preview API must use disposable DB explicitly.

Expo web preview uses installed package dependencies and a local disposable API. Unauthenticated component harness can verify chooser/chart without credentials. Expo Go cannot prove SQLCipher/custom-native Android offline correctness. Existing compatible QA installation may support device review; new native builds are excluded. Record TalkBack/native keyboard/SQLCipher as unverified where tooling cannot exercise changed source. PDF/XLSX scratch artifacts are verification outputs, not release builds.

## Acceptance checklist

- [x] Exactly 30 approved metadata/catalog strings in order; original seven/Food retained.
- [x] One category string; protocol v1/UUID/fingerprint unchanged.
- [x] Full names across affected UI/export, neutral unknown fallback.
- [x] >=48dp targets, checkmark/border/checked state, name/alias search with canonical submission.
- [ ] Native acceptance: actual font scales 1.3/2.0, TalkBack, keyboard/Back and reduced-motion behavior on a compatible device. Layout decisions/Back handler pass unit tests; web focus/light/dark/list behavior is verified. No native build was authorized.
- [x] Positive gross only in slices/legend; two spending categories exactly two entries.
- [x] Refund-only rows retained; gross/refunds/net reconcile complete confirmed data.
- [x] >1000 list and >5000 payer reads include oldest category/refund.
- [x] Legacy snapshots preserved and totals unverified; failed refresh retains complete cache.
- [x] Drafts/outbox/replay, allocations and locked FX preserved.
- [x] PDF/XLSX text labels and financial calculations retained.
- [ ] Native Excel workbook rendering in an accessible session.
- [x] Reviewed q mirror with QA identity intact.
- [x] Documentation records implementation and device gaps.
- [x] Unrelated changes preserved; prohibited release/external actions absent.

Implementation evidence and remaining device gates follow below. A device gate is not marked passed solely because unit tests or web rendering passed.


## Earlier implementation and verification evidence — 3 October 2026

This section records the earlier implementation run. Its broad results are retained history, not a fresh broad run against the final completion source. Current results and remaining gates are recorded in [category-expansion-progress.md](category-expansion-progress.md).

Sessions 2–5 source changes are implemented locally after explicit implementation authorization. Application, test and documentation edits are uncommitted. No release or external notification action was taken.

### Implemented

- Canonical 30-name manifest, deterministic package-local generation and compatible theme re-exports; exact string API identity and Food default.
- Shared compact/grouped/searchable category picker in Add/Edit; static Lucide registry, stable theme accents, full-name wrapping, neutral historical fallback, explicit unsupported-edit selection guard.
- Additive Sheet accessibility/focus/close/reduced-motion behavior and opt-in ListRow wrapping. Category detail icons use their assigned accents.
- Positive-gross trip chart with separate refunds/net, refund-only breakdown, stable colours, accessible wrapping legends and no unused catalog entries.
- Complete expense and payer reads; explicit list header/CORS exposure; internal helper and versioned JSON envelope. Legacy rows remain visible with totals withheld; complete cached bundles survive failed/markerless refresh.
- Selective corresponding changes and tests in q. New catalog/helper/picker/chart modules have byte-for-byte parity; QA native identity/configuration and unrelated differences remain intact.
- User guide and feature inventory updated. Database models, allocation logic, accounting/FX engine, create protocol/fingerprints, report math and notification delivery code retain existing behavior.

### Automated checks

| Check | Result |
|---|---|
| Frontend full Jest | 128 suites, 1,057 tests passed |
| q full Jest | 126 suites, 1,033 tests passed |
| Final affected picker/forms/detail/cache/Android-adapter rechecks | 8 suites, 48 tests passed in each package after final presentation/mock cleanups |
| TypeScript | `--noEmit` passed in frontend and q after final source changes |
| ESLint | All changed TypeScript/TSX files passed in both packages with zero warnings/errors |
| Catalog and whitespace | Generator `--check`, generated QA parity and `git diff --check` passed |
| Isolated backend regression | 391 tests passed using fresh loopback Mongo/API databases; includes all30 metadata/create/update, uncapped reads, reports, exact splits/shares, conversion, balances, notification mocks and transaction idempotency |
| Additional category-only FX regression | All 30 approved category-only edits preserve locked money/rate/version and only mutate the category. Conversion route suite passed 40 tests including these 30 additions |

The backend union includes 421 verified test cases: the isolated 391 plus 30 new FX-category cases. The 40-test conversion rerun overlaps 10 already included cases. The only backend warning was the existing `python_multipart` deprecation. A frontend test timed out under concurrent full-package load; the affected suite and subsequent standalone full frontend run passed. No production HTTP mutation tests were used.

### Browser and accessibility evidence

The earlier unauthenticated local harness used actual frontend picker/chart components and synthetic expenses; it made no backend calls. The rejection described in this historical paragraph does not describe the newly authorized completion run: normal local sign-in and account switching now pass, as recorded in category-expansion-progress.md. Real Expo web preview was started against a disposable local API. Browser sign-in was rejected by automatic approval review because it treated the fake test-account login as unauthorized credential submission. No alternative credential injection or protected-screen bypass was used. Authenticated API behavior was checked through the isolated HTTP tests instead.

Browser inspection covered widths 320, 360, 390 and 768dp, plus 300dp to exercise the narrow full-width list fallback. At 768dp the sheet capped at 640dp with three columns. At 320dp it used equal-height two-column rows with no horizontal page overflow. All 30 names remained untruncated. Local search for taxi returned one Local Transportation row; empty search and Clear search worked; selection closed and returned focus; reopen showed the checked selection.

Measured actual web targets: close 48×48, clear 48×48, compact trigger approximately 57.6dp high, legend rows 56dp high, search result approximately 67.6dp high, grouped list minimum approximately 65.6dp, tiles at least approximately 97.6dp. Web `aria-checked` was verified on selected Food. Tab/Shift+Tab contained focus, Escape closed, and focus returned to the category trigger. Light/dark views and selected checkmark/border were inspected. Two positive categories produced two slices and two legend actions with gross1500/refunds700/net800; refund-only data kept the signed breakdown and no pie. Unverified data showed the refresh notice without totals.

RN Web reports fontScale1 and refuses Dimensions.set; its harness toggle could not simulate real native text scaling. Unit tests verify the 1.3/2.0 list decision and unrestricted labels, and the narrow browser view verifies the list layout. Native TalkBack, true scaled text rendering, hardware Back/keyboard integration, reduced-motion preference, SQLCipher runtime and offline force-stop remain device gates. No new APK/AAB or native Android build was performed.

### Complete-data measurements

| Records | List response ms | Response bytes | Python parse peak bytes | Gross / refunds / net |
|---:|---:|---:|---:|---|
| 999 | 169.0 | 580,470 | 2,577,837 | 1007 / 2 / 1005 |
| 1,000 | 295.2 | 581,051 | 2,573,099 | 1008 / 2 / 1006 |
| 1,001 | 173.3 | 581,632 | 2,568,889 | 1009 / 2 / 1007 |
| 5,001 | 720.4 | 2,905,632 | 12,904,993 | 5009 / 2 / 5007 |

Fixtures used n−2 Food +1 rows, oldest Shipping & Delivery +10, and oldest Bank Fees & Interest −2. All rows, oldest category and refund were included; list header was true, receipts excluded, and payer/report controls reconciled. These are single-run local response timings and Python parsing memory, not mobile heap, production latency or proof of arbitrary-scale performance. All-at-once array reads remain the documented tradeoff.

### Export inspection

Generated local all30-category PDF/XLSX fixtures preserve exact text labels and existing financial calculations. All eight PDF pages were rendered and inspected; labels/amounts do not overlap. Existing narrow PDF transaction columns split some long words, and a pre-existing section heading can land at a page bottom; the category text and financial values remain present.

XLSX text, column widths, wrap settings and row heights were checked. Imported read-only with the bundled artifact renderer, Summary A20:D40, Split Math A10:H25 and Transactions A5:F16 were rendered and inspected. Subscriptions & Memberships and other longest labels fit/wrap with amounts readable. The workbook was not rewritten by that renderer. Native Excel behavior was not exercised.

### Remaining gates and preservation

Remaining acceptance includes native Android verification and native Excel rendering. The earlier broad results and export renders are retained evidence. Final completion source has its own targeted automated and authenticated web results in category-expansion-progress.md; no unverified native gate is marked passed. Test databases and preview files were disposable local fixtures; external push and email delivery were disabled. Temporary preview/API/harness/Mongo processes are stopped after verification. The original `.claude/settings.local.json` remains untracked and untouched; no stage, commit, push, PR, release artifact, deployment or publication occurred.


## Completion pass — final evidence

The bounded completion pass fixes account/trip request isolation, including failed-switch retry ownership, strengthens normal chooser borders with textMuted, stops superseded Sheet animations and adds direct chart/form/offline/replay/HTTP/shared-consumer regression coverage. Final checks pass **10 suites/140 frontend tests**, **10/139 QA tests**, both type checks and zero-warning affected-file lint, plus **20 isolated backend tests**. The earlier1057/1033/391 results and additional30 category-only FX cases remain separately labelled retained evidence.

Authenticated browser review now passes through normal UI sign-in, A/B totals and navigation, populated Add/Edit chooser preservation and a second-account switch. Both-theme screenshots, measured control contrast and labelled reconstructed HEAD comparisons are saved. Web measurements do not establish real native text scaling, TalkBack, hardware Back, SQLCipher/restart or native Excel behavior. Native Android and Excel gates remain open.

See [the final progress and evidence record](category-expansion-progress.md) for the requirement matrix, exact commands, final per-file inventory, formal React review, screenshot locations, recovered failures and acceptance checklist. No native build/release/deployment or prohibited external action was performed.

## Backend-first future rollout and rollback

This is guidance for a future authorized rollout; no rollout was performed.

1. Deploy backend catalog acceptance and compatible reads first. All30 exact stored/queued category strings must be accepted by create/update validation and returned as strings before a client exposes new choices. `/meta/categories` remains an ordered string array; expense/payment create protocols remain1. Expense lists retain public arrays and expose a truthful completeness marker; payer summaries and signed JSON reports must include oldest categories/refunds without the old caps.
2. Verify old and new clients against that backend before exposing new choices. Older clients may still offer only their original choices and retain their old visual/accounting behavior; compatible response bodies let them read stored new labels. Do not rewrite a new or historical label to Food/Other to accommodate an older picker. Check older client rendering/edit behavior directly rather than claiming that it was tested in this pass.
3. Roll out clients with the internal complete-read adapter and version-2 cache reader before relying on verified cached totals. Legacy array caches remain readable but unverified. Failed/markerless refresh must retain an earlier verified complete bundle. The JSON envelope stays in the existing read kind; no SQL schema migration, new cache key or destructive rewrite is required.
4. Preserve every immutable queued draft throughout rollout. Its original category, mutation UUID, approved/frozen payload, fingerprint, rate evidence and receipt remain unchanged. New-name drafts queued by one client remain acceptable when replayed after an upgrade or UI rollback. Pending intent never contributes to confirmed totals.
5. Roll back the client UI only to a build that can read both legacy arrays and version-2 envelopes and preserve new-name drafts. A binary that expects only arrays is not a safe reader for existing v2 snapshots. Retain a compatible reader patch or choose a compatible rollback artifact; do not clear caches/outboxes to force compatibility.
6. Backend rollback must continue accepting all names already stored or queued, even if visible client choices are reduced. Keep compatible public bodies, metadata/read semantics, durable idempotency receipts and protocol1. Never mark a truncated list complete. If a marker is unavailable, new clients must withhold derived totals as unverified; avoid introducing an incompatible cache reader or invalidating frozen replay identity.

Future rollout gates include complete/stale cache fixtures, old/new-client reads, an immutable new-name queued draft replay after rollback, stored-label reports and native device acceptance. Do not disable ordinary-build offline safeguards until their separate native gates pass.

