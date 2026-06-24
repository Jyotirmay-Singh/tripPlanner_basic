"""Duplicate-name disambiguation — DERIVED display labels (no data mutation).

Single source of truth for how member names are *shown* when a trip contains people who share a
name. The stored member documents, their UUIDs, and every splitting/balance/settlement value are
left untouched — only the displayed label changes. Mirrored client-side in
``frontend/src/displayNames.ts`` (kept byte-for-byte equivalent), following the existing
``utils/permissions.py`` ↔ ``permissions.ts`` pattern.

These are PURE functions (plain dicts/lists, no DB / FastAPI / Motor) so they unit-test exactly like
``services/report_builder.py``. The only import is the canonical ``normalize_name`` so collision
detection matches the rest of the app (trim + collapse whitespace, case-insensitive).

Rules (see CLAUDE.md §5 context):
  (a) Standalone INDIVIDUALS sharing a name -> name_1, name_2 ... (all duplicates suffixed).
  (b) A name among individuals AND inside a family roster: the two live in *different scopes*, so a
      lone individual stays plain; an individual only gets a suffix when 2+ individuals collide.
  (c) Duplicate names WITHIN one family roster -> name_familyName_1, name_familyName_2 ...
      (family name with spaces stripped).
  (+) Two families sharing a top-level name follow the SAME protocol as individuals (Sharma_1,
      Sharma_2); families and individuals share the single top-level scope, so an individual and a
      family with the same top-level name disambiguate together too.

Suffix order is the members' / roster's position in the stored array (= creation order), which is
stable across add/edit/delete because Mongo ``$push`` / ``$set`` / ``$pull`` preserve it.
"""

from typing import Dict, List

from utils.members import normalize_name


def _suffixed(items: List[str]) -> List[str]:
    """Given display bases in stable order, append _1.._n to every base whose normalized form
    repeats; a base that is unique (case/space-insensitively) is returned unchanged.

    Each item keeps its OWN typed casing/spacing as the label base; only the collision *detection*
    is normalized + lowercased.
    """
    counts: Dict[str, int] = {}
    for raw in items:
        key = normalize_name(raw).lower()
        counts[key] = counts.get(key, 0) + 1
    seen: Dict[str, int] = {}
    out: List[str] = []
    for raw in items:
        base = normalize_name(raw)
        key = base.lower()
        if counts.get(key, 0) > 1:
            seen[key] = seen.get(key, 0) + 1
            out.append(f"{base}_{seen[key]}")
        else:
            out.append(base)
    return out


def member_display_names(members: list) -> Dict[str, str]:
    """member_id -> disambiguated top-level display label (rules a + the family decision).

    Every member (individual OR family) is grouped by its normalized top-level name; any name shared
    by 2+ members gets ``name_N`` in array order, unique names are returned as-is.
    """
    labels = _suffixed([normalize_name(m.get("name", "")) for m in members])
    return {m["id"]: labels[i] for i, m in enumerate(members)}


def family_member_display_names(family: dict) -> List[str]:
    """One family's ``family_members`` roster -> display labels (rule c), parallel to the input list.

    A roster name that repeats within this family becomes ``{name}_{familyNameNoSpaces}_{N}`` in
    array order; a name unique within the roster stays plain.
    """
    roster = family.get("family_members", []) or []
    token = normalize_name(family.get("name", "")).replace(" ", "")
    counts: Dict[str, int] = {}
    for nm in roster:
        key = normalize_name(nm).lower()
        counts[key] = counts.get(key, 0) + 1
    seen: Dict[str, int] = {}
    out: List[str] = []
    for nm in roster:
        base = normalize_name(nm)
        key = base.lower()
        if counts.get(key, 0) > 1:
            seen[key] = seen.get(key, 0) + 1
            out.append(f"{base}_{token}_{seen[key]}")
        else:
            out.append(base)
    return out
