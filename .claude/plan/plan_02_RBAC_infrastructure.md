# Production Plan — Step 02: Trip RBAC Infrastructure

Implements CLAUDE.md Roadmap **Phase 1 → Step 2** per `specs/02-rbac-infrastructure.md`,
on branch `feature/rbac-infrastructure`.

## Context
The app currently has no concept of a *trip administrator*. A trip document
(`db.trips`) distinguishes only `owner_id` (used in exactly one place —
`delete_trip` at `backend/routes/trips.py:58`) from a flat `user_ids` membership
array; `_trip_or_404` (`backend/utils/deps.py:19`) gates everything on membership
alone. Step 2 requires an explicit `admin_ids` string array with the creating user
seeded as the **root admin**. This is foundational: Steps 10 (expense edit/delete
locks) and 11 (member-admin locks) will consume the guard built here. Per the
roadmap, Phase 1 is backend-only — enforcement on expense/member routes and any
admin UI are explicitly **later** steps and out of scope now.

## Scope (this step only)
1. Add `admin_ids: List[str]` to trip docs; seed `[owner_id]` on create.
2. Backfill `admin_ids` onto pre-existing trips at startup.
3. Add a reusable admin guard (`is_trip_admin`, `_trip_admin_or_403`) — **built but
   not yet wired into expense/member routes**.
4. Add minimal admin-management endpoints (list / promote / demote) so the admin set
   is mutable and testable, with the root admin undemotable.
5. Tests + flip CLAUDE.md Step 2 checkbox.

## Out of scope (do NOT touch)
- Attaching `_trip_admin_or_403` to expense/member mutation routes → **Step 10/11**.
- Any frontend / admin UI → **Step 14** (no shared `Trip` TS interface exists; types
  are inline per screen, e.g. `frontend/app/trip/[id]/index.tsx:14`).
- Split-mode (`PER_CAPITA`/`PER_FAMILY`) and balance math → Steps 4–8.

## Design decisions
- **Root admin = existing `owner_id`.** No new `root_admin_id` field. Invariant:
  `owner_id ∈ admin_ids` always; `owner_id` can never be demoted. Reuses the field
  already present, so `delete_trip`'s owner check stays valid.
- **Admins managed via dedicated endpoints only**, never the generic
  `PATCH /trips/{id}` — `TripUpdate` (`backend/models/trip.py:13`) has no `admin_ids`
  field, so it already cannot be escalated through the generic update path. Keep it
  that way.
- **Membership precondition:** a user must already be in `user_ids` before promotion.
- **No new index** — `admin_ids` is only ever read from an already-fetched trip doc.
- Reuse existing helpers: `gen_id`/`now_utc` (`backend/utils/common.py`),
  `_trip_or_404` + `get_current_user` (`backend/utils/deps.py`), `db` (`database.py`).

## Implementation

### 1. `backend/utils/deps.py` — add the guard (reuses `_trip_or_404`)
```python
def is_trip_admin(trip: dict, user_id: str) -> bool:
    return user_id in trip.get("admin_ids", [])

async def _trip_admin_or_403(trip_id: str, user_id: str) -> dict:
    trip = await _trip_or_404(trip_id, user_id)   # 404 if missing, 403 if not a member
    if not is_trip_admin(trip, user_id):
        raise HTTPException(403, "Admin privileges required")
    return trip
```
`.get("admin_ids", [])` keeps it safe against any legacy doc the backfill missed.

### 2. `backend/models/trip.py` — request body
```python
class AdminGrant(BaseModel):
    user_id: str
```

### 3. `backend/routes/trips.py`
- **`create_trip`** — add `"admin_ids": [user["id"]]` to the inserted `doc`
  (alongside `owner_id`/`user_ids`, ~`trips.py:26`). Response gains `admin_ids`.
- **New endpoints** (import `AdminGrant`, `is_trip_admin`, `_trip_admin_or_403`).
  A small helper builds the response payload by resolving admin `user_id`s against
  the trip's `members` array (best-effort: an admin user_id with no matching member
  doc is still returned by id):
  ```python
  def _admin_payload(trip: dict) -> dict:
      by_uid = {m.get("user_id"): m for m in trip.get("members", []) if m.get("user_id")}
      admins = [
          {"user_id": uid, "id": (by_uid.get(uid) or {}).get("id"),
           "name": (by_uid.get(uid) or {}).get("name"),
           "email": (by_uid.get(uid) or {}).get("email")}
          for uid in trip.get("admin_ids", [])
      ]
      return {"owner_id": trip["owner_id"], "admin_ids": trip.get("admin_ids", []), "admins": admins}
  ```
  - `GET  /trips/{trip_id}/admins` — guard `_trip_or_404` (any member). Return `_admin_payload`.
  - `POST /trips/{trip_id}/admins` body `AdminGrant` — guard `_trip_admin_or_403`.
    `400 "User is not a member of this trip"` if `body.user_id not in trip["user_ids"]`;
    else `$addToSet: {admin_ids: body.user_id}` (idempotent); re-fetch `{"_id":0}`; return payload.
  - `DELETE /trips/{trip_id}/admins/{user_id}` — guard `_trip_admin_or_403`.
    `400 "Cannot remove the root admin"` if `user_id == trip["owner_id"]`;
    else `$pull: {admin_ids: user_id}`; re-fetch `{"_id":0}`; return payload.

### 4. `backend/server.py` — startup backfill (idempotent, pipeline update)
Inside `startup()` after index creation:
```python
await db.trips.update_many(
    {"$or": [{"admin_ids": {"$exists": False}}, {"admin_ids": None}, {"admin_ids": []}]},
    [{"$set": {"admin_ids": ["$owner_id"]}}],   # aggregation-pipeline update copies owner_id
)
```
Pipeline form is required to set a field from another field; supported by Motor/Mongo 4.2+.

## Tests
- **`backend/tests/test_trips.py`** — in `test_create_trip`, assert
  `data["admin_ids"] == [data["owner_id"]]` and `owner_id == test_user["user"]["id"]`.
- **`backend/tests/test_rbac.py`** (new) — HTTP integration style, reuse `conftest`
  fixtures `api_client` + `test_user`; create a second user and join via
  `POST /api/trips/join` (pattern from `test_trips.py:121`):
  1. create → `admin_ids == [owner]`.
  2. `GET /admins` as owner → owner present; as a non-member → `403`.
  3. `POST /admins` (owner promotes joined member) → member in `admin_ids`.
  4. `POST /admins` with a non-member user_id → `400`.
  5. `POST /admins` by a non-admin caller → `403`.
  6. `DELETE /admins/{member}` (owner demotes) → removed from `admin_ids`.
  7. `DELETE /admins/{owner_id}` → `400 "Cannot remove the root admin"`.
  8. `DELETE /admins/{member}` by a non-admin caller → `403`.

## Files
**Change:** `backend/utils/deps.py`, `backend/models/trip.py`,
`backend/routes/trips.py`, `backend/server.py`, `backend/tests/test_trips.py`,
`CLAUDE.md` (flip Step 2 `[ ]`→`[x]`).
**Create:** `backend/tests/test_rbac.py`.
**New dependencies:** none.

## Verification (end-to-end)
Tests hit a live server + MongoDB (black-box, like all existing tests).
```bash
cd backend
uvicorn server:app --reload                 # terminal A (:8000); confirm clean startup logs
# PowerShell: $env:EXPO_PUBLIC_BACKEND_URL="http://localhost:8000"
export EXPO_PUBLIC_BACKEND_URL=http://localhost:8000   # terminal B
pytest                                       # full suite — must be green incl. test_rbac.py
pytest tests/test_rbac.py -v                 # focused RBAC run
```
Backfill spot-check: insert a trip doc without `admin_ids`, restart the server,
`GET /api/trips/{id}` → `admin_ids == [owner_id]`. Confirm `GET /openapi.json`
shows the 3 new `/trips/{trip_id}/admins` routes.

## Definition of Done
- [ ] `POST /api/trips` returns `admin_ids == [owner_id]`.
- [ ] Startup backfill sets `admin_ids=[owner_id]` on legacy trips (idempotent).
- [ ] List/promote/demote endpoints enforce: member-only read, admin-only mutate,
      member-precondition on promote, undemotable root admin.
- [ ] `is_trip_admin`/`_trip_admin_or_403` exist and are exercised by tests, and are
      **not** referenced by expense/member routes.
- [ ] `cd backend && pytest` fully green including `tests/test_rbac.py`.
- [ ] CLAUDE.md Roadmap Step 2 flipped `[ ]`→`[x]` in the same commit.

## Commit
Single commit on `feature/rbac-infrastructure`, e.g.
`Add Trip RBAC infrastructure: admin_ids + admin guard + admin endpoints (Step 2)`.
