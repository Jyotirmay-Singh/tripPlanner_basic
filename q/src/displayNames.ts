// Duplicate-name disambiguation — DERIVED display labels (no data mutation).
//
// Exact client-side mirror of backend/utils/display_names.py: the single source of truth lives
// server-side and is re-derived here so labels match the XLSX report and every screen. Stored member
// names/IDs and all splitting/balance/settlement values stay untouched — only the displayed label
// changes. Follows the existing permissions.ts / composition.ts / bill.ts pure-helper pattern.
//
// Rules (CLAUDE.md §5 context):
//   (a) Standalone individuals sharing a name -> name_1, name_2 ... (all duplicates suffixed).
//   (b) Individuals and family rosters are separate scopes, so a lone individual stays plain even if
//       a family roster also has that name; an individual is suffixed only when 2+ individuals collide.
//   (c) Duplicate names within ONE family roster -> name_familyName_1 ... (family name spaces stripped).
//   (+) Two families sharing a top-level name follow the same protocol as individuals; families and
//       individuals share the single top-level scope.
// Suffix order = position in the stored array (creation order), stable across add/edit/delete.

export type DisplayMember = {
  id: string;
  name: string;
  kind?: string;
  family_members?: string[] | null;
};

// Canonical normalizer — must match backend utils/members.py::normalize_name
// (trim + collapse internal whitespace). Collision detection additionally lowercases.
function normalizeName(name?: string | null): string {
  return (name ?? '').trim().replace(/\s+/g, ' ');
}

/**
 * Given display bases in stable order, append _1.._n to every base whose normalized form repeats;
 * a base that is unique (case/space-insensitively) is returned unchanged. Each item keeps its own
 * typed casing/spacing as the label base.
 */
function suffixed(items: string[]): string[] {
  const counts: Record<string, number> = {};
  for (const raw of items) {
    const key = normalizeName(raw).toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const seen: Record<string, number> = {};
  return items.map((raw) => {
    const base = normalizeName(raw);
    const key = base.toLowerCase();
    if ((counts[key] ?? 0) > 1) {
      seen[key] = (seen[key] ?? 0) + 1;
      return `${base}_${seen[key]}`;
    }
    return base;
  });
}

/**
 * member_id -> disambiguated top-level display label (rule a + the family decision). Every member
 * (individual or family) is grouped by normalized top-level name; a name shared by 2+ members gets
 * `name_N` in array order, unique names are returned as-is.
 */
export function memberDisplayNames(members?: DisplayMember[] | null): Record<string, string> {
  const list = members ?? [];
  const labels = suffixed(list.map((m) => normalizeName(m.name)));
  const out: Record<string, string> = {};
  list.forEach((m, i) => {
    out[m.id] = labels[i];
  });
  return out;
}

/**
 * One family's `family_members` roster -> display labels (rule c), parallel to the input list. A
 * roster name repeated within this family becomes `{name}_{familyNameNoSpaces}_{N}` in array order;
 * a name unique within the roster stays plain.
 */
export function familyMemberDisplayNames(family: DisplayMember): string[] {
  const roster = family.family_members ?? [];
  const token = normalizeName(family.name).replace(/\s+/g, '');
  const counts: Record<string, number> = {};
  for (const nm of roster) {
    const key = normalizeName(nm).toLowerCase();
    counts[key] = (counts[key] ?? 0) + 1;
  }
  const seen: Record<string, number> = {};
  return roster.map((nm) => {
    const base = normalizeName(nm);
    const key = base.toLowerCase();
    if ((counts[key] ?? 0) > 1) {
      seen[key] = (seen[key] ?? 0) + 1;
      return `${base}_${token}_${seen[key]}`;
    }
    return base;
  });
}
