// Phase 26 — pure helpers for the create-trip "who am I?" step. At creation the owner declares
// whether they're a standalone individual (default, full back-compat) or ONE member inside a family
// they set up here (name + member rows + which row is "me"). The server attaches the login email +
// account to the chosen member slot; the family entity itself carries no email. These helpers only
// validate the form and build the extra POST /trips body fields — the backend stays authoritative.

export type SelfKind = 'individual' | 'family';

export type IdentityInput = {
  self_kind: SelfKind;
  familyName: string;
  memberNames: string[]; // raw rows (may contain blanks)
  selfIndex: number;     // index into the raw rows marking "this is me"
};

// The extra fields merged into the create-trip request body.
export type IdentityFields =
  | { self_kind: 'individual' }
  | { self_kind: 'family'; family_name: string; family_members: string[]; self_index: number };

/**
 * Validation for the identity step. Returns a user-facing error message, or null when valid.
 * Individual is always valid. Family requires a non-blank name, ≥1 non-blank member, and the
 * "me" row to be a real (non-blank) member.
 */
export function identityIssue(input: IdentityInput): string | null {
  if (input.self_kind === 'individual') return null;
  if (!input.familyName.trim()) return 'Family name is required';
  const cleaned = input.memberNames.map((n) => n.trim()).filter(Boolean);
  if (cleaned.length === 0) return 'Add at least one family member';
  const self = input.memberNames[input.selfIndex];
  if (self === undefined || !self.trim()) return 'Select which member is you';
  return null;
}

/**
 * Build the identity fields for the POST /trips body. Trims + drops blank member rows and remaps
 * self_index to the chosen row's position within the cleaned list (so filtering never mis-points
 * "me"). Assumes `identityIssue` already passed; defaults self_index to 0 defensively.
 */
export function buildIdentityFields(input: IdentityInput): IdentityFields {
  if (input.self_kind === 'individual') return { self_kind: 'individual' };
  const cleaned: string[] = [];
  let selfIndex = 0;
  input.memberNames.forEach((n, i) => {
    const t = n.trim();
    if (!t) return;
    if (i === input.selfIndex) selfIndex = cleaned.length;
    cleaned.push(t);
  });
  return {
    self_kind: 'family',
    family_name: input.familyName.trim(),
    family_members: cleaned,
    self_index: selfIndex,
  };
}
