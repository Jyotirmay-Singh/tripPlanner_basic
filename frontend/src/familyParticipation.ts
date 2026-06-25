// Intra-family member participation (Model A) — pure, display/payload helpers shared by the
// add/edit expense screens and unit-tested in src/__tests__/familyParticipation.test.ts.
//
// A family's TOTAL share is unchanged; only the INTERNAL per-member division changes. Unchecking a
// member sends a `family_participants` entry (family id -> participating member ids). Absent / all
// checked => nothing sent => backend default "everyone participates" (exact back-compat).

export type FPMember = {
  id: string;
  kind: string;
  family_members: string[];
  family_member_ids?: string[] | null;
};

// One row of the structured family-roster editor. `id` is the stable member id (null for a row the
// user just added — the backend mints one and preserves it for past-expense participation).
export type FamilyRow = { id: string | null; name: string };

/** Editor rows -> the member PATCH/POST payload: parallel name + id arrays built from the SAME
 *  non-empty rows (so a removed/blank row drops its id and arrays stay aligned). */
export function rowsToPayload(rows: FamilyRow[]): { family_members: string[]; family_member_ids: (string | null)[] } {
  const kept = rows.filter((r) => r.name.trim());
  return {
    family_members: kept.map((r) => r.name.trim()),
    family_member_ids: kept.map((r) => r.id),
  };
}

/** Stored family -> editor rows (parallel names + ids; missing id -> null). */
export function familyToRows(
  family_members?: string[] | null,
  family_member_ids?: (string | null)[] | null,
): FamilyRow[] {
  const names = family_members || [];
  const ids = family_member_ids || [];
  return names.map((name, i) => ({ id: ids[i] ?? null, name }));
}

/** Stable member ids parallel to family_members; pads with synthetic index ids for any family not
 *  yet backfilled (mirrors backend services/member_breakdown.family_member_ids). */
export function familyMemberIds(m: FPMember): string[] {
  const names = m.family_members || [];
  const ids = (m.family_member_ids || []).map(String);
  if (ids.length >= names.length) return ids.slice(0, names.length);
  return names.map((_, i) => ids[i] ?? `${m.id}:${i}`);
}

/** Total humans for PER_CAPITA (mirrors backend resolve_weights + split_per_capita denominator). */
export function perCapitaHumans(
  members: FPMember[],
  splitSel: string[],
  weightOverrides: Record<string, number>,
): number {
  let H = 0;
  for (const sid of splitSel) {
    const m = members.find((x) => x.id === sid);
    if (m && m.kind === 'family') H += weightOverrides[sid] ?? Math.max(1, (m.family_members || []).length);
    else H += 1;
  }
  return H;
}

/** family_participants payload: family id -> participating ids, ONLY for genuine proper-subset
 *  restrictions; null when nothing is restricted (=> backend default "all participate"). Built for
 *  both PER_CAPITA and PER_FAMILY (in either mode it only redistributes a family's share among its
 *  participants; the family's entity total is unchanged). */
export function buildFamilyParticipants(
  members: FPMember[],
  splitSel: string[],
  splitMode: string,
  familyExcluded: Record<string, string[]>,
): Record<string, string[]> | null {
  if (splitMode !== 'PER_CAPITA' && splitMode !== 'PER_FAMILY') return null;
  const out: Record<string, string[]> = {};
  for (const sid of splitSel) {
    const m = members.find((x) => x.id === sid);
    if (!m || m.kind !== 'family') continue;
    const ids = familyMemberIds(m);
    const excl = new Set(familyExcluded[sid] || []);
    const included = ids.filter((id) => !excl.has(id));
    if (ids.length > 1 && included.length > 0 && included.length < ids.length) out[sid] = included;
  }
  return Object.keys(out).length ? out : null;
}

/** Seed the edit screen's excluded map from a stored family_participants (roster id - participants). */
export function excludedFromParticipants(
  members: FPMember[],
  familyParticipants?: Record<string, string[]> | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (!familyParticipants) return out;
  for (const m of members) {
    if (m.kind !== 'family') continue;
    const participants = familyParticipants[m.id];
    if (!participants) continue;
    const inc = new Set(participants.map(String));
    const excl = familyMemberIds(m).filter((id) => !inc.has(id));
    if (excl.length) out[m.id] = excl;
  }
  return out;
}

/** Per-participant share of one family for the live preview (display only; matches Model A).
 *  PER_FAMILY: the family's flat per-entity share (amount / entities) split among participants.
 *  PER_CAPITA: the family's per-human share (per_human * size) split among participants. */
export function familyShareEach(
  amount: number,
  members: FPMember[],
  splitSel: string[],
  weightOverrides: Record<string, number>,
  famId: string,
  includedCount: number,
  splitMode: string,
): number {
  const m = members.find((x) => x.id === famId);
  if (!m || !Number.isFinite(amount) || amount <= 0 || includedCount <= 0) return 0;
  if (splitMode === 'PER_FAMILY') {
    const E = splitSel.length; // each selected member (family or individual) is one entity
    if (E <= 0) return 0;
    return amount / E / includedCount;
  }
  const H = perCapitaHumans(members, splitSel, weightOverrides);
  if (H <= 0) return 0;
  const famWeight = weightOverrides[famId] ?? Math.max(1, (m.family_members || []).length);
  return ((amount / H) * famWeight) / includedCount;
}
