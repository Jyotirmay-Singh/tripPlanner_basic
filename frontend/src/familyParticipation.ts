// Intra-family member participation — pure, display/payload helpers shared by the add/edit expense
// screens and unit-tested in src/__tests__/familyParticipation.test.ts.
//
// Unchecking a member sends a `family_participants` entry (family id -> participating member ids).
// Absent / all checked => nothing sent => backend default "everyone participates" (exact back-compat).
// PER_CAPITA: a restricted family counts as its INVOLVED-member count, so its share IS reduced and
// each involved member owes the per-human cost (CLAUDE.md §5-A) — mirrored by perCapitaHumans /
// familyInvolvedWeight / familyShareEach. PER_FAMILY: the family's flat per-entity TOTAL is unchanged;
// only its internal per-member division honors participation.

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

/** A family's PER_CAPITA human-count weight — mirrors backend `resolve_weights` precedence: an
 *  explicit numeric override wins; else the INVOLVED-member count when participation is a proper,
 *  non-empty restriction (CLAUDE.md §5-A: the same count that divides the share among members); else
 *  the full registered size. */
export function familyInvolvedWeight(
  m: FPMember,
  override?: number,
  excluded?: string[],
): number {
  const size = Math.max(1, (m.family_members || []).length);
  if (override != null) return override;
  const ids = familyMemberIds(m);
  const excl = new Set(excluded || []);
  const included = ids.filter((id) => !excl.has(id)).length;
  return included > 0 && included < ids.length ? included : size;
}

/** Total humans for PER_CAPITA (mirrors backend resolve_weights + split_per_capita denominator).
 *  `familyExcluded` (family id -> excluded member ids) lets a partially-attending family count as its
 *  involved-member count, exactly like the ledger. */
export function perCapitaHumans(
  members: FPMember[],
  splitSel: string[],
  weightOverrides: Record<string, number>,
  familyExcluded: Record<string, string[]> = {},
): number {
  let H = 0;
  for (const sid of splitSel) {
    const m = members.find((x) => x.id === sid);
    if (m && m.kind === 'family') H += familyInvolvedWeight(m, weightOverrides[sid], familyExcluded[sid]);
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

/** Per-participant share of one family for the live preview (display only).
 *  PER_FAMILY: the family's flat per-entity share (amount / entities) split among participants
 *  (display-only — the family's entity total is unchanged).
 *  PER_CAPITA: each involved member owes the per-human cost C = amount / H, because the family is now
 *  sized by its INVOLVED count (CLAUDE.md §5-A) — the same count it is divided by. `familyExcluded`
 *  (family id -> excluded member ids) feeds H so every partially-attending family counts correctly. */
export function familyShareEach(
  amount: number,
  members: FPMember[],
  splitSel: string[],
  weightOverrides: Record<string, number>,
  famId: string,
  includedCount: number,
  splitMode: string,
  familyExcluded: Record<string, string[]> = {},
): number {
  const m = members.find((x) => x.id === famId);
  // amount may be negative (money back) -> the per-share preview is correspondingly negative.
  if (!m || !Number.isFinite(amount) || amount === 0 || includedCount <= 0) return 0;
  if (splitMode === 'PER_FAMILY') {
    const E = splitSel.length; // each selected member (family or individual) is one entity
    if (E <= 0) return 0;
    return amount / E / includedCount;
  }
  const H = perCapitaHumans(members, splitSel, weightOverrides, familyExcluded);
  if (H <= 0) return 0;
  // Involved count sizes the family share AND divides it -> each participant owes exactly amount / H.
  const famWeight = weightOverrides[famId] ?? includedCount;
  return ((amount / H) * famWeight) / includedCount;
}
