# Spec: Photo Asset Acquisition & Gallery Pipeline  (Step 20)

## Overview
Step 20 (the final Phase 6 item in the `CLAUDE.md` Roadmap) completes the receipt media
experience. Today users can only **pick** a receipt image from their photo library when adding
or editing a transaction; there is no way to **capture** a receipt with the camera and no way to
**save** an attached receipt back out to the phone's gallery. This step does two things:
(1) upgrades the `expo-image-picker` "Attach image" affordance into a proper acquisition action
that lets the user choose between **Take photo** (camera) and **Choose from library**, and
(2) adds a tappable receipt viewer modal with a **Save to gallery** download trigger backed by
`expo-media-library`, so a receipt stored on a transaction can be written back into the device's
local camera roll. This is purely a frontend/media step — the backend already persists the
receipt as `receipt_base64` on each expense document, so no API or data-model changes are required.

## Depends on
- Step 16 (Dual Split Mode Selector) and Step 17 (RBAC-Driven Component Hiding) — both already
  complete and live in `add-expense.tsx` / `edit-expense.tsx`, the screens this step touches.
- The existing `receipt_base64` field on the Expense model (present since the pre-refactor
  single-file backend; see `backend/models/expense.py`). No further backend steps are required.

## Data Model Changes (MongoDB/Pydantic)
No data model changes. The `receipt_base64: Optional[str]` field already exists on both
`ExpenseIn` and `ExpenseUpdate` in `backend/models/expense.py`, and is already persisted/returned
by the expense routes. Receipts continue to be stored as a `data:image/...;base64,...` URI string.

## Backend API & Services (FastAPI)
No backend changes. Acquisition (camera/library) and gallery write-back are entirely on-device
client concerns. The existing `POST /trips/{trip_id}/expenses` and
`PATCH /trips/{trip_id}/expenses/{expense_id}` already accept and return `receipt_base64`, and
RBAC on edit/delete is already enforced by `_expense_modify_or_403` (Step 10). Nothing new is
sent to or required from the server.

## App Screens & UI (Expo React Native)
- **Create:**
  - `frontend/src/ReceiptViewer.tsx` — a reusable, theme-aware modal component that displays a
    receipt full-screen (zoomable not required) over a dimmed backdrop, with a **Save to gallery**
    download button and a **Close** button. Accepts `{ uri: string | null; visible: boolean;
    onClose: () => void }`. The download button drives the `expo-media-library` save flow described
    in *State & API Integration*. Shows an inline saving spinner and a success/failure `Alert`.
- **Modify:**
  - `frontend/app/trip/[id]/add-expense.tsx` — replace the single-purpose `pickReceipt` (library
    only) with an acquisition chooser: tapping **Attach image** opens an `Alert`/action sheet with
    **Take photo**, **Choose from library**, and **Cancel**. Add a `takePhoto` path using
    `ImagePicker.launchCameraAsync` (with `requestCameraPermissionsAsync`). Keep `quality: 0.4`,
    `base64: true`, and the `data:image/jpeg;base64,` prefixing so the stored payload format is
    unchanged. Make the existing receipt preview `<Image>` tappable to open `ReceiptViewer`.
  - `frontend/app/trip/[id]/edit-expense.tsx` — same acquisition-chooser upgrade and the same
    tap-to-open `ReceiptViewer` on the receipt preview. The viewer's **Save to gallery** trigger is
    the primary "download" affordance for an already-saved receipt. Respect existing RBAC: the
    **Save to gallery** action is available to any viewer (read-only users may still download), but
    the **Remove**/re-attach affordances stay gated by `canModify` exactly as they are today.
  - `frontend/app.json` — add native permission config (see *New Dependencies*): the
    `expo-media-library` config plugin with save permission copy, an iOS
    `NSPhotoLibraryAddUsageDescription` and `NSCameraUsageDescription`, a `cameraPermission` string
    on the existing `expo-image-picker` plugin block, and the Android write/media permissions.

## State & API Integration
- No changes to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`.
- **New media helper** — add a small pure utility (e.g. `frontend/src/receipt.ts`) exporting
  `parseDataUri(uri: string): { mime: string; base64: string; ext: string } | null` that splits a
  `data:<mime>;base64,<payload>` string into its parts and maps the mime to a file extension
  (`image/jpeg` → `jpg`, `image/png` → `png`, default `jpg`). This is the unit-testable core of the
  save flow.
- **Save-to-gallery flow** (inside `ReceiptViewer.tsx`, using the helper):
  1. Call `MediaLibrary.requestPermissionsAsync()` (write access); bail with an `Alert` if denied.
  2. `parseDataUri` the receipt; if the receipt is already a `file://`/remote URI (not a data URI),
     save it directly.
  3. For a data URI, write the base64 payload to a cache file via
     `FileSystem.writeAsStringAsync(<cacheDir>/receipt-<id>.<ext>, base64, { encoding: 'base64' })`.
  4. `MediaLibrary.saveToLibraryAsync(fileUri)` to write it into the camera roll, then surface a
     success `Alert` ("Saved to your gallery").
  5. Best-effort cleanup of the temp cache file.

## Files to change
- `frontend/app/trip/[id]/add-expense.tsx` — acquisition chooser (camera + library); tap-to-view receipt.
- `frontend/app/trip/[id]/edit-expense.tsx` — acquisition chooser (camera + library); tap-to-view receipt with Save to gallery.
- `frontend/app.json` — camera + media-library permission strings/plugins (iOS infoPlist, Android permissions, plugin config).
- `frontend/package.json` — new dependencies (added via `npx expo install`, see below).
- `CLAUDE.md` — flip Step 20's `- [ ]` to `- [x]` after the step is complete, tested, and committed.

## Files to create
- `frontend/src/ReceiptViewer.tsx` — full-screen receipt modal with Save-to-gallery download trigger.
- `frontend/src/receipt.ts` — `parseDataUri` data-URI parsing/extension-mapping helper.
- `frontend/src/__tests__/receipt.test.ts` — jest unit tests for `parseDataUri`.

## New Dependencies
Frontend (install with `npx expo install` so versions match Expo SDK 54):
- `expo-media-library` — required for writing receipts into the device camera roll.
- `expo-file-system` — required to materialize a base64 data URI into a local file that
  `MediaLibrary.saveToLibraryAsync` can consume (it needs a file URI, not a data URI).

No new Python dependencies (no backend changes).

## Rules for Implementation
- Respect the strict dual split mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. (Untouched by this step — do not alter any split/weight-snapshot logic in the two
  expense screens while editing the receipt code.)
- All UUID tracking and MongoDB projection queries (`{"_id": 0}`) must remain intact. (No backend
  edits — leave the expense routes/models exactly as they are.)
- Enforce Role-Based Access Control (RBAC) on the backend before executing destructive
  edits/deletes — already handled by `_expense_modify_or_403`; do not weaken it. On the client,
  keep the existing `canModify` gating for Remove/re-attach; **Save to gallery** is read-only and
  may be available to all viewers.
- Follow the frontend design system tokens (`SPACING`, `RADIUS`, `CONTROL`, `colors` from
  `ThemeContext`/`theme.ts`); the receipt viewer and chooser must support dynamic light/dark mode
  and must not hardcode colors.
- Preserve the stored receipt payload format (`data:image/jpeg;base64,<...>`, `quality: 0.4`) so
  existing receipts and the XLSX export pipeline continue to work unchanged.
- Keep changes strictly scoped to this step; do not refactor unrelated code in the expense screens
  or anywhere else.
- Add `testID`s to new interactive elements (e.g. `receipt-view`, `receipt-save`,
  `receipt-take-photo`, `receipt-pick-library`) consistent with existing `ae-*` / `ee-*` naming.

## Definition of Done
- [ ] `npx expo install expo-media-library expo-file-system` succeeds and both appear in
  `frontend/package.json` at SDK-54-compatible versions.
- [ ] In **Add transaction**, tapping **Attach image** offers **Take photo** / **Choose from
  library**; both paths attach a working receipt preview, and the camera path requests camera
  permission on first use.
- [ ] In **Edit transaction**, the same chooser works, and the existing **Remove** affordance is
  still hidden for users who fail `canModify`.
- [ ] Tapping a receipt preview (add or edit screen) opens the full-screen `ReceiptViewer` modal,
  rendered correctly in both light and dark mode.
- [ ] The viewer's **Save to gallery** button requests media-library permission, writes the receipt
  into the device camera roll, and shows a success confirmation; the saved image opens in the OS
  Photos/Gallery app.
- [ ] A denied permission (camera or media library) surfaces a clear `Alert` and does not crash.
- [ ] `frontend/src/__tests__/receipt.test.ts` passes: `parseDataUri` correctly splits valid JPEG
  and PNG data URIs, maps extensions, and returns `null` for malformed input. `yarn test` (jest)
  is green.
- [ ] `cd backend && pytest` is green — confirming this frontend-only step introduces **no backend
  regressions** (the existing expense/receipt tests continue to pass).
- [ ] `cd frontend && yarn lint` passes with no new warnings/errors in the changed files.
- [ ] `CLAUDE.md` Roadmap Step 20 is flipped from `- [ ]` to `- [x]`.
