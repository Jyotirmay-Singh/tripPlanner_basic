# Spec: Attaching Bill's Image  (Step 22)

> **Roadmap note:** The `CLAUDE.md` Implementation Roadmap currently ends at Step 21. Step 22 is a
> **new Phase 7 (Post-Launch Hardening)** item. As part of this step, add the checkbox line to
> `CLAUDE.md` and flip it to `[x]` on completion (see *Files to change* / *Definition of Done*).

## Overview
Today a receipt/bill image is embedded as a base64 `data:image/...;base64,...` string directly on
the expense document (`expense.receipt_base64`), and `GET /trips/{id}/expenses` returns **every
receipt blob inline** with no projection to strip them. A single photographed bill at `quality:0.4`
is hundreds of KB of base64; a trip with dozens of receipts makes the expense-list response balloon
to multiple MB and risks the 16 MB MongoDB document ceiling. Step 22 promotes "attaching a bill's
image" into a proper, scalable upload pipeline: the picked/captured image is uploaded over a
dedicated **multipart** endpoint into **MongoDB GridFS**, the expense stores only a lightweight
`receipt_id` (UUID string), and the image is streamed back on demand from a separate `GET` endpoint.
The expense-list endpoint stops shipping image bytes entirely. This builds directly on the on-device
acquisition/viewer work from Step 20 (camera + library picker, `ReceiptViewer`, save-to-gallery) and
keeps full backward compatibility with any legacy `receipt_base64` receipts already in the database.

## Depends on
- **Step 10** — `_expense_modify_or_403` (creator-or-admin RBAC) gates attach/replace/remove.
- **Step 16 / Step 17** — the dual split-mode selector and RBAC-driven `canModify` gating already
  live in `add-expense.tsx` / `edit-expense.tsx`, the two screens this step rewires.
- **Step 20** — the on-device acquisition chooser (`takePhoto` / `pickFromLibrary`), the
  `ReceiptViewer` modal, and the `parseDataUri` helper (`frontend/src/receipt.ts`). Step 22 changes
  *where the image is stored*, not how it is captured or saved to the gallery.

## Data Model Changes (MongoDB/Pydantic)
- **GridFS bucket**: introduce a `receipts` GridFS bucket via Motor
  `AsyncIOMotorGridFSBucket(db, bucket_name="receipts")` (creates `receipts.files` / `receipts.chunks`).
  Files are written with `upload_from_stream_with_id(gen_id(), filename, source, metadata=...)` so the
  GridFS file `_id` is a **UUID string** (honoring the project's "UUID strings, not ObjectIds" rule),
  and `metadata = {"trip_id", "expense_id", "content_type", "uploaded_by", "uploaded_at"}`.
- **`backend/models/expense.py`**:
  - Add `receipt_id: Optional[str] = None` to **both** `ExpenseIn` and `ExpenseUpdate`.
  - Keep `receipt_base64: Optional[str] = None` on both models for **read** back-compat with legacy
    rows (new uploads no longer populate it). Document with a comment that it is legacy/deprecated.
- **Expense document**: now carries `receipt_id` (UUID string referencing the GridFS file) instead of
  an inline blob. Legacy documents may still have `receipt_base64` and must keep working.
- **Indexes**: add `await db["receipts.files"].create_index("metadata.expense_id")` in `server.py`
  startup so receipt lookup/cleanup by expense is indexed. All queries continue to use `{"_id": 0}`
  projections where returning app documents.

## Backend API & Services (FastAPI)
A new router module **`backend/routes/receipts.py`** (registered in `server.py` alongside the others),
plus a small service **`backend/services/receipts.py`** holding the GridFS read/write/delete helpers
and pure validation so the route stays thin and the logic is unit-testable.

New endpoints (all under the existing `/api` prefix):

1. **`POST /trips/{trip_id}/expenses/{expense_id}/receipt`** — multipart upload.
   - Body: `file: UploadFile` (form field `file`).
   - **RBAC:** `_expense_modify_or_403(trip_id, expense_id, user["id"])` — only the expense creator or
     a trip admin may attach/replace.
   - **Validation (pure, in `services/receipts.py`):** content-type ∈ {`image/jpeg`, `image/png`,
     `image/webp`}; size ≤ `MAX_RECEIPT_BYTES` (5 MB) → `400` otherwise.
   - Deletes any pre-existing GridFS file for this expense (replace semantics), stores the new bytes,
     sets `expense.receipt_id = <uuid>` and clears legacy `expense.receipt_base64` (`$set receipt_id`,
     `$unset receipt_base64`). Returns `{"receipt_id": "<uuid>"}`.

2. **`GET /trips/{trip_id}/expenses/{expense_id}/receipt`** — stream the image.
   - **Auth:** trip membership (any trip member may view). Accept the JWT via **either** the
     `Authorization: Bearer` header **or** a `?token=` query param — mirroring the
     `report.xlsx` pattern — so React Native `<Image>` and plain browser links both work.
   - Resolves the expense; if it has a `receipt_id`, opens the GridFS stream and returns a
     `StreamingResponse` with the stored `content_type` and `Cache-Control: private, max-age=...`.
   - **Legacy fallback:** if the expense has no `receipt_id` but has `receipt_base64`, decode the data
     URI and stream those bytes (so old receipts render through the same URL). `404` if neither exists.

3. **`DELETE /trips/{trip_id}/expenses/{expense_id}/receipt`** — remove the receipt.
   - **RBAC:** `_expense_modify_or_403`. Deletes the GridFS file (if any), `$unset receipt_id` and
     `$unset receipt_base64`. Returns `{"ok": true}`. Idempotent (no-op `200` if already absent).

Changed endpoint:

4. **`GET /trips/{trip_id}/expenses`** (`routes/expenses.py`) — change the projection to
   `{"_id": 0, "receipt_base64": 0}` so image bytes are **never** returned in the list. Add a derived
   `has_receipt` boolean to each row (`bool(e.get("receipt_id"))` OR legacy `receipt_base64` present)
   so the client can show a thumbnail/affordance without downloading bytes. Keep returning `receipt_id`.

5. **`POST /trips/{trip_id}/expenses`** and **`PATCH .../{expense_id}`** — stop persisting
   `receipt_base64` from the request body for new writes (the field is ignored on create; receipts now
   arrive via the upload endpoint). `PATCH` continues to accept `receipt_id` only if a flow needs to
   detach by setting it null, but the canonical detach path is the `DELETE` endpoint above. Deleting an
   expense (`DELETE .../{expense_id}`) must also delete its GridFS receipt (cleanup, no orphans).

`services/report_builder.py` / `report.xlsx` need **no change** — they never embedded receipt bytes
and the new projection does not affect the fields they read (the `report_xlsx` query may keep its own
projection; ensure it does not depend on `receipt_base64`).

## App Screens & UI (Expo React Native)
- **Modify:**
  - `frontend/app/trip/[id]/add-expense.tsx` — keep picking/capturing locally (preview from the local
    asset uri). On **Save**, first `POST` the expense (no `receipt_base64` in the body), then — if a
    receipt was attached — `uploadReceipt(tripId, newExpenseId, asset)` to the multipart endpoint before
    navigating back. Surface an `Alert` if the image upload fails but the expense saved.
  - `frontend/app/trip/[id]/edit-expense.tsx` — load the existing receipt by rendering the remote
    `receiptUrl(...)` when the loaded expense reports `has_receipt`/`receipt_id`. **Attach/replace** →
    `uploadReceipt`; **Remove** → `DELETE` receipt endpoint. Keep the existing `canModify` gating on the
    Remove / re-attach affordances exactly as in Step 17/20 (read-only members can still view/save).
  - `frontend/src/ReceiptViewer.tsx` — accept a **remote `http(s)` URI** in addition to a `data:`/
    `file:` URI. Extend the save-to-gallery flow: for a remote URL, `FileSystem.downloadAsync(uri,
    cacheFile)` then `MediaLibrary.saveToLibraryAsync(cacheFile)`; the existing data-URI branch (via
    `parseDataUri`) stays for freshly-picked, not-yet-uploaded images. Preserve all existing `testID`s
    (`receipt-view`, `receipt-save`, `receipt-close`).
- **Create:** none required (no new screens).

## State & API Integration
- **`frontend/src/api.ts`**:
  - Add `uploadReceipt(tripId, expenseId, asset: { uri: string; mimeType?: string })` that builds a
    `FormData`, appends `file` as `{ uri, name, type }`, and `fetch`es the multipart `POST` with the
    bearer token. **Do not** set `Content-Type` manually — let RN set the multipart boundary.
  - Add `deleteReceipt(tripId, expenseId)` (thin wrapper over `api(..., { method: 'DELETE' })`).
  - Add `receiptUrl(tripId, expenseId, token)` — mirrors `xlsxUrl`: returns
    `${BASE}/api/trips/${tripId}/expenses/${expenseId}/receipt?token=${encodeURIComponent(token)}` for
    use as an `<Image source={{ uri }}>` (the `?token=` query satisfies the GET endpoint's auth).
- **`frontend/src/receipt.ts`** — unchanged (`parseDataUri` still used for the not-yet-uploaded
  data-URI save path); `ReceiptViewer` adds the remote-download branch around it.
- No `AuthContext` / `ThemeContext` / `AsyncStorage` changes.

## Files to change
- `backend/models/expense.py` — add `receipt_id`; annotate `receipt_base64` as legacy/read-only.
- `backend/routes/expenses.py` — list projection drops `receipt_base64` + adds `has_receipt`; stop
  persisting inline blobs on create/update; cascade-delete GridFS receipt on expense delete.
- `backend/server.py` — register the new `receipts` router; add `receipts.files` index on startup.
- `backend/requirements.txt` — add `python-multipart` (see *New Dependencies*).
- `frontend/app/trip/[id]/add-expense.tsx` — upload receipt after expense create; drop `receipt_base64`.
- `frontend/app/trip/[id]/edit-expense.tsx` — render remote receipt; upload/replace/remove via endpoints.
- `frontend/src/api.ts` — `uploadReceipt`, `deleteReceipt`, `receiptUrl` helpers.
- `frontend/src/ReceiptViewer.tsx` — support remote `http(s)` URIs in the save-to-gallery flow.
- `CLAUDE.md` — add the **Step 22** roadmap line under a new Phase 7 entry and flip `- [ ]` → `- [x]`
  when complete, tested, and committed.

## Files to create
- `backend/routes/receipts.py` — the three receipt endpoints (`POST` / `GET` / `DELETE`).
- `backend/services/receipts.py` — GridFS put/get/delete helpers + pure validation
  (`validate_receipt_upload(content_type, size) -> None | raises`, `MAX_RECEIPT_BYTES`, allowed types).
- `backend/tests/test_receipts.py` — integration tests for upload → fetch → RBAC → delete + legacy
  fallback (follows the live-server `requests` pattern in `conftest.py`).

## New Dependencies
- **Backend:** add `python-multipart` to `backend/requirements.txt` (required by FastAPI/Starlette to
  parse `UploadFile`/`multipart/form-data`). GridFS ships with the existing `motor==3.3.1` /
  `pymongo==4.5.0` — no new package needed for storage. No image-processing lib (Pillow) is required;
  validation is by declared content-type + byte size.
- **Frontend:** no new dependencies. `expo-image-picker`, `expo-media-library`, and `expo-file-system`
  (from Step 20) cover capture, gallery save, and the remote-download branch.

## Rules for Implementation
- Respect the strict dual split-mode logic (`PER_CAPITA` vs `PER_FAMILY`) from Section 5 of `CLAUDE.md`.
  This step must **not** alter any split / `weight_snapshots` / balance logic in the expense screens or
  routes — only the receipt storage/transport path changes.
- All UUID tracking and MongoDB `{"_id": 0}` projection queries must remain intact. The GridFS file id
  **must be a `gen_id()` UUID string** (use `upload_from_stream_with_id`), not a raw ObjectId.
- Enforce RBAC on the backend before any destructive receipt action: attach/replace/remove run through
  `_expense_modify_or_403` (creator or trip admin). Viewing/streaming a receipt requires only trip
  membership; never weaken `_trip_or_404`.
- Maintain backward compatibility: existing `receipt_base64` rows must still render (via the GET
  legacy-fallback) and must not be corrupted. Do not run a destructive bulk migration in this step.
- Validate uploads server-side (content-type allow-list + size cap); reject anything else with `400`.
- Follow the frontend design-system tokens (`SPACING`, `RADIUS`, `CONTROL`, `colors` from
  `ThemeContext`/`theme.ts`); the receipt UI must keep working in light **and** dark mode and must not
  hardcode colors. Preserve existing `testID`s and the `ae-*` / `ee-*` / `receipt-*` naming.
- Keep changes strictly scoped to Step 22; do not refactor unrelated code.

## Definition of Done
- [ ] `pip install -r backend/requirements.txt` installs `python-multipart`; the backend boots and the
  `receipts` router is mounted under `/api`.
- [ ] **Add transaction:** picking/capturing a bill, then saving, creates the expense **and** uploads
  the image; the expense doc has a `receipt_id` and **no** `receipt_base64`; the GridFS `receipts`
  bucket contains the file.
- [ ] `GET /trips/{id}/expenses/{eid}/receipt` streams the image with the correct content-type for
  **both** header-auth (`Authorization: Bearer`) and `?token=` query auth; a non-member gets `403`,
  a missing receipt gets `404`.
- [ ] `GET /trips/{id}/expenses` no longer returns any `receipt_base64` bytes and includes a
  `has_receipt` flag; payload size for a trip with several receipts is dramatically smaller than before.
- [ ] **Edit transaction:** an existing receipt renders from the remote URL; **Replace** swaps the
  GridFS file; **Remove** deletes it (`receipt_id` cleared) — and these affordances stay hidden for a
  user who fails `canModify`, while **Save to gallery** still works for any viewer.
- [ ] A **legacy** expense that has only `receipt_base64` still renders through the GET endpoint
  (fallback path) and can be saved to the gallery via `ReceiptViewer`.
- [ ] Deleting an expense also removes its GridFS receipt (no orphaned `receipts.files`/`.chunks`).
- [ ] `ReceiptViewer` renders and saves both a freshly-picked data-URI receipt and a remote-URL receipt,
  in light and dark mode, without crashing on permission denial.
- [ ] `cd backend && pytest` is green, including the new `backend/tests/test_receipts.py`
  (upload → fetch → RBAC 403 → delete → legacy fallback). Existing expense/RBAC/report tests still pass.
- [ ] `cd frontend && yarn lint` passes with no new warnings/errors in the changed files; `yarn test`
  (jest) remains green.
- [ ] `CLAUDE.md` Roadmap shows the new **Step 22** line flipped from `- [ ]` to `- [x]`.
