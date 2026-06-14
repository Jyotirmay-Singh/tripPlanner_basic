# Spec: Unique Family & Individual Mapping  (Step 03)

## Overview
This step hardens the per-trip member roster so that **no two members (individual or family)
can share a name, and no two members can share a linked email** inside the same trip. It maps
directly to Roadmap **Phase 1, Step 3** in `CLAUDE.md` ("Unique Family & Domain Mapping —
guarantee unique `linked_email` addresses and prevent identical naming conventions inside a single
trip context"). Today these checks exist, but only as **ad-hoc, duplicated `for`-loops inside
`routes/members.py`**, and they are **completely bypassed by the `join_trip` flow** in
`routes/trips.py` (a user joining via code can silently create a second member with a colliding
name or email). This step extracts the validation into one centralized, reusable normalization +
uniqueness layer, applies it uniformly across **every** member-creation/mutation path (add, update,
join, and the family-merge branch), and locks the behavior down with dedicated `pytest` coverage.
It is a prerequisite for the later split-mode math (Steps 6–8) and the join wizard (Steps 12–13),
which all assume member names and linked emails are unambiguous keys within a trip.

## Depends on
- **Step 1 — Modularize Backend** (`- [x]`): the `models/`, `routes/`, `utils/` layout this spec
  edits and extends already exists.
- **Step 2 — Trip RBAC Infrastructure** (`- [x]`): `admin_ids` / `_trip_admin_or_403` exist; this
  spec keeps member mutations gated by existing trip-membership access (`_trip_or_404`) and does
  not change the RBAC surface (admin-only locks are Step 11, out of scope here).

## Data Model Changes (MongoDB/Pydantic)
The member document remains an **embedded sub-document inside the `trips` collection** (members are
elements of `trip.members[]`), so its identity stays a UUID string `id` via `gen_id()` — no Mongo
ObjectIds, no new top-level collection.

**Field-naming decision (explicit):** the roadmap calls the field `linked_email`. The codebase
already stores this exact concept as the member field **`email`** (used by the UI label "Linked
email", the auto-link-on-join logic in `join_trip`, and the family-merge branch in `add_member`).
To honor "keep changes strictly scoped; do not refactor unrelated code," **`email` remains the
canonical stored key and IS the `linked_email` from the roadmap.** We will NOT rename the stored
field (a rename would ripple through `trips.py`, the frontend, and existing documents). Pydantic
gains a `linked_email` **input alias** so payloads using either key are accepted, while the stored
document key stays `email`.

Pydantic model changes in `backend/models/member.py`:
- `MemberIn`
  - `name`: add a validator that trims and collapses internal whitespace; reject empty-after-trim.
  - `email`: keep `Optional[EmailStr]`; add an alias so `linked_email` is also accepted; normalize
    to `lower().strip()` or `None`.
- `MemberUpdate`
  - `name`: same trim/collapse validator (when provided).
  - `email`: promote from plain `str` to a normalized optional field that still permits an **empty
    string to clear** the link (preserve current "can be empty string to clear" semantics); accept
    `linked_email` alias. (Keep it lenient — not `EmailStr` — so a member can clear their email.)
  - `reweight_past`: unchanged.

No new Pydantic model files. No new persisted fields.

**Index note:** MongoDB **cannot enforce uniqueness across array elements within a single
document**, so uniqueness of names/emails *inside one trip's `members[]`* is enforced
**application-side** (the centralized helper below), not via a unique index. No new index is added;
existing `trips`/`users` indexes are untouched.

## Backend API & Services (FastAPI)
**New centralized validation module: `backend/utils/members.py`** (pure, dependency-free helpers,
unit-testable in isolation):
- `normalize_name(name: str | None) -> str` — trim + collapse runs of internal whitespace to a
  single space. Returns `""` for `None`/blank.
- `normalize_email(email: str | None) -> Optional[str]` — `lower().strip()`; returns `None` when
  blank.
- `name_exists(members: list[dict], name: str, exclude_id: str | None = None) -> bool` —
  case-insensitive, normalized comparison across **all** members regardless of `kind` (an
  individual and a family may not share a name).
- `email_exists(members: list[dict], email: str | None, exclude_id: str | None = None) -> bool` —
  case-insensitive normalized comparison; `None`/blank email never collides.
- `assert_unique_name(members, name, exclude_id=None)` — raises `HTTPException(400, "A member named
  '<name>' already exists in this trip")` on collision.
- `assert_unique_email(members, email, exclude_id=None)` — raises `HTTPException(400, "A member
  with email '<email>' already exists in this trip")` on collision.

**Routes refactored to call the helper (no new endpoints, no signature changes):**
- `routes/members.py` → `add_member` (POST `/api/trips/{trip_id}/members`): replace the inline
  duplicate-name loop (current lines ~20–22) and duplicate-email loop (~31–36) with
  `assert_unique_name` / `assert_unique_email`, honoring the existing `merge_target` exclusion
  (when an email matches an existing individual that will be merged in place, that member is
  excluded from the email-collision check via `exclude_id`).
- `routes/members.py` → `update_member` (PATCH `.../members/{member_id}`): replace the
  self-excluding duplicate loops (~73–75, ~88–90) with the helper calls passing
  `exclude_id=member_id` (renaming a member to its own current name must still succeed). Email
  normalization routed through `normalize_email` so clearing-by-empty-string still works.
- `routes/trips.py` → `join_trip` (POST `/api/trips/join`): **close the bypass.** When the join
  does **not** match a linkable family (the `linked_family is None` branch that auto-creates a new
  individual member from the joining user), run the new member's `name` and `email` through
  `assert_unique_name` / `assert_unique_email` against the trip's existing `members[]`. On a name
  collision, **deterministically disambiguate** the auto-created member's display name (e.g. append
  a short suffix derived from the user — `"<name> (<email-local-part>)"`, re-checked for
  uniqueness) rather than 400-ing the join, so a legitimate user is never blocked from joining a
  trip merely because their display name matches an existing member. Email collisions in the
  auto-create branch keep the existing link-or-add semantics (the family-link branch already
  handles the matching-email case). All `{"_id": 0}` projections preserved.

**RBAC:** unchanged in this step. Member add/update/delete continue to require trip membership via
`_trip_or_404`. (Admin-only member mutation locks are Roadmap Step 11 and are explicitly out of
scope here.) No destructive edit/delete behavior is added or weakened.

## App Screens & UI (Expo React Native)
- **Create:** none.
- **Modify (light, optional UX polish only — no behavioral dependency):**
  - `frontend/app/trip/[id]/add-member.tsx` — already surfaces backend errors via `Alert.alert`.
    Optionally normalize the typed name (trim) before submit and keep showing the backend 400
    message verbatim. No new screen logic required for correctness; the backend is the source of
    truth.
  - `frontend/app/trip/[id]/edit-member.tsx` — same: continue surfacing backend 400 messages for
    duplicate name/email on save.

The uniqueness guarantee is enforced **server-side**; the frontend changes are presentation-only
and must not attempt to replace backend validation.

## State & API Integration
No changes required to `frontend/src/api.ts`, `AuthContext`, `ThemeContext`, or `AsyncStorage`. The
existing `api()` wrapper already normalizes FastAPI `detail` errors into `Error.message`, which the
member screens already display. Request/response shapes for the member endpoints are unchanged
(payloads may now optionally use `linked_email`, but existing `email` payloads keep working).

## Files to change
- `backend/models/member.py` — name/email normalization validators on `MemberIn` / `MemberUpdate`;
  `linked_email` input alias.
- `backend/routes/members.py` — `add_member` and `update_member` call the centralized helper
  instead of inline loops.
- `backend/routes/trips.py` — `join_trip` auto-create branch enforces name/email uniqueness with
  deterministic name disambiguation.
- `frontend/app/trip/[id]/add-member.tsx` — (optional) trim name before submit; keep surfacing
  backend errors.
- `frontend/app/trip/[id]/edit-member.tsx` — (optional) keep surfacing backend errors on save.
- `CLAUDE.md` — flip Roadmap **Step 3** checkbox `- [ ]` → `- [x]` after tests pass and the change
  is committed.

## Files to create
- `backend/utils/members.py` — centralized normalization + uniqueness helpers.
- `backend/tests/test_member_uniqueness.py` — pytest coverage for the new behavior.

## New Dependencies
No new dependencies. `EmailStr` requires `email-validator`, which is already implied by the
existing `MemberIn`/auth models using `EmailStr`; verify it is present in
`backend/requirements.txt` and add it **only if missing** (no other additions).

## Rules for Implementation
- Respect the strict dual split-mode logic (`PER_CAPITA` vs `PER_FAMILY`) defined in Section 5 of
  `CLAUDE.md`. This step does not implement split math, but member name/email uniqueness must not
  break the assumptions those modes rely on (members remain uniquely identifiable within a trip).
- All UUID tracking (`gen_id()`) and MongoDB projection queries (`{"_id": 0}`) must remain intact;
  members stay embedded in `trip.members[]` — do **not** introduce a separate members collection or
  a Mongo unique index across array elements.
- Uniqueness is **case-insensitive and whitespace-normalized** for names, and **case-insensitive +
  trimmed** for emails, applied across **all** members regardless of `kind`.
- Enforce validation on **every** write path: `add_member`, `update_member`, the `add_member`
  family-merge branch, and `join_trip`'s auto-create branch. The join path must **disambiguate**
  rather than reject so a real user is never locked out of a trip.
- Keep RBAC behavior exactly as-is (trip membership via `_trip_or_404`); do not add or relax
  admin/creator checks here — that is Step 11.
- Preserve `MemberUpdate.email == ""` "clear the link" semantics.
- Follow the frontend design-system tokens and dynamic light/dark mode via `ThemeContext` for any
  UI touch-ups; do not hardcode colors.
- Keep changes strictly scoped to this step; do not refactor unrelated code, rename the stored
  `email` field, or alter the split/settlement engine.

## Definition of Done
- [ ] `backend/utils/members.py` exists with `normalize_name`, `normalize_email`, `name_exists`,
      `email_exists`, `assert_unique_name`, `assert_unique_email`.
- [ ] `POST /api/trips/{id}/members` rejects a duplicate **individual** name (case-insensitive,
      e.g. `"priya"` vs `"  Priya "`) with HTTP 400.
- [ ] `POST /api/trips/{id}/members` rejects a duplicate **family** name, and rejects an individual
      whose name equals an existing family's name (cross-kind collision) with HTTP 400.
- [ ] `POST /api/trips/{id}/members` rejects a duplicate **linked email** (case-insensitive) with
      HTTP 400, and still allows the documented email-merge-into-family branch.
- [ ] `PATCH /api/trips/{id}/members/{member_id}` rejects renaming to another member's name, but
      **allows** saving a member with its own unchanged name/email (self-exclusion works).
- [ ] `PATCH` with `email: ""` still clears the linked email (no false 400).
- [ ] `POST /api/trips/join` no longer creates a colliding member: a user whose name matches an
      existing member joins successfully with a **deterministically disambiguated** display name,
      and the trip never ends up with two members sharing a name or a non-empty email.
- [ ] Payloads using `linked_email` are accepted equivalently to `email` (alias works); stored
      document still uses the `email` key.
- [ ] New tests in `backend/tests/test_member_uniqueness.py` cover all of the above and **`pytest`
      passes** (run `pytest` and `pytest backend/tests/test_member_uniqueness.py`); the existing
      `pytest backend/tests/test_members.py` suite still passes (no regressions).
- [ ] `CLAUDE.md` Roadmap Step 3 checkbox flipped to `- [x]` and the work committed on
      `feature/unique-family-individual-mapping`.
