// Pure, theme-agnostic helpers describing a trip's member composition.
//
// Follows the Section 5 (CLAUDE.md) definition of "total humans": a family
// contributes one human per listed member (at least one, even if the roster is
// empty), and a standalone individual contributes exactly one. Shared by Home
// (dashboard), the Trips tab, and trip Detail so the
// "[X] Individuals across [Y] Families & [Z] Singles" string has one source of truth.

export type MemberKind = 'individual' | 'family';
export type CompositionMember = { kind: MemberKind; family_members?: string[] | null };

export type Composition = { individuals: number; families: number; singles: number };

export function tripComposition(members?: CompositionMember[] | null): Composition {
  let individuals = 0;
  let families = 0;
  let singles = 0;
  for (const m of members ?? []) {
    if (!m) continue;
    if (m.kind === 'family') {
      families += 1;
      individuals += Math.max(1, (m.family_members ?? []).length);
    } else {
      singles += 1;
      individuals += 1;
    }
  }
  return { individuals, families, singles };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function compositionLabel(members?: CompositionMember[] | null): string {
  const { individuals, families, singles } = tripComposition(members);
  // With no families there is nothing to contrast against (singles === individuals),
  // so the redundant breakdown is omitted and we show just the human count.
  if (families === 0) {
    return plural(individuals, 'Individual', 'Individuals');
  }
  // Empty segments are omitted, so a trip of only families reads
  // "8 Individuals across 2 Families" (no "& 0 Singles").
  const parts = [plural(families, 'Family', 'Families')];
  if (singles > 0) parts.push(plural(singles, 'Single', 'Singles'));
  return `${plural(individuals, 'Individual', 'Individuals')} across ${parts.join(' & ')}`;
}
