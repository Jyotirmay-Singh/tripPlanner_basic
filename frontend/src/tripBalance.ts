export type BalanceMember = {
  id: string;
  name: string;
  kind: 'individual' | 'family';
  user_id?: string | null;
  family_member_ids?: string[] | null;
  family_member_user_ids?: (string | null)[] | null;
};

export type FamilyPersonBalance = {
  id: string;
  name: string;
  net: number;
};

export type PerPersonBalance = {
  member_id: string;
  net_per_person?: number;
  members?: FamilyPersonBalance[] | null;
};

export type TripBalancePayload = {
  net: Record<string, number>;
  members: BalanceMember[];
  currency: string;
  per_person?: PerPersonBalance[] | null;
};

export const BALANCE_COPY = {
  owed: "You're owed",
  owe: 'You owe',
  settled: 'Settled',
  unavailable: 'Balance unavailable',
} as const;

export type TripBalanceState =
  | { kind: 'owed'; label: typeof BALANCE_COPY.owed; amount: number; cents: number }
  | { kind: 'owe'; label: typeof BALANCE_COPY.owe; amount: number; cents: number }
  | { kind: 'settled'; label: typeof BALANCE_COPY.settled; amount: 0; cents: 0 }
  | { kind: 'unavailable'; label: typeof BALANCE_COPY.unavailable; amount: null; cents: null };

export type CurrencyBalance = {
  currency: string;
  cents: number;
  value: number;
};

/** Convert a finite money value to signed integer cents, normalizing negative zero. */
export function moneyCents(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const absolute = Math.round((Math.abs(value) + Number.EPSILON) * 100);
  if (absolute === 0) return 0;
  return value < 0 ? -absolute : absolute;
}

/**
 * Resolve the authenticated person's balance from the authoritative /balances payload.
 * Standalone users own an entity row; family-linked users own one stable per-person row.
 */
export function resolveUserTripBalance(
  balances: TripBalancePayload | null | undefined,
  userId: string | null | undefined,
): number | null {
  if (!balances || !userId) return null;

  const directMember = balances.members.find((member) => member.user_id === userId);
  if (directMember) {
    const value = balances.net[directMember.id];
    return Number.isFinite(value) ? value : null;
  }

  for (const family of balances.members) {
    if (family.kind !== 'family') continue;
    const personIndex = (family.family_member_user_ids ?? []).findIndex((id) => id === userId);
    if (personIndex < 0) continue;

    const familyBalance = (balances.per_person ?? [])
      .find((entry) => entry.member_id === family.id);
    if (!familyBalance) return null;

    const personId = family.family_member_ids?.[personIndex];
    const rows = familyBalance.members ?? [];
    const personBalance = personId
      ? rows.find((row) => row.id === personId)
      : rows[personIndex];
    const value = personBalance?.net ?? familyBalance.net_per_person;
    return Number.isFinite(value) ? (value as number) : null;
  }

  return null;
}

/** Map a rounded balance to its one unambiguous presentation state. */
export function tripBalanceState(value: number | null | undefined): TripBalanceState {
  if (value == null) {
    return { kind: 'unavailable', label: BALANCE_COPY.unavailable, amount: null, cents: null };
  }
  const cents = moneyCents(value);
  if (cents == null) {
    return { kind: 'unavailable', label: BALANCE_COPY.unavailable, amount: null, cents: null };
  }
  if (cents > 0) {
    return { kind: 'owed', label: BALANCE_COPY.owed, amount: cents / 100, cents };
  }
  if (cents < 0) {
    return { kind: 'owe', label: BALANCE_COPY.owe, amount: Math.abs(cents) / 100, cents };
  }
  return { kind: 'settled', label: BALANCE_COPY.settled, amount: 0, cents: 0 };
}

/** Group complete per-trip balances without ever adding unlike currencies together. */
export function groupBalancesByCurrency(
  rows: { currency: string; balance: number }[],
): CurrencyBalance[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    const cents = moneyCents(row.balance);
    if (cents == null) continue;
    const currency = row.currency || 'INR';
    totals.set(currency, (totals.get(currency) ?? 0) + cents);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, cents]) => ({ currency, cents, value: cents / 100 }));
}

export function netPositionMessage(groups: CurrencyBalance[]): string {
  const hasPositive = groups.some((group) => group.cents > 0);
  const hasNegative = groups.some((group) => group.cents < 0);
  if (!hasPositive && !hasNegative) return 'All settled up';
  if (hasPositive && hasNegative) return 'Balances vary by currency';
  return hasPositive ? 'You come out ahead' : 'You owe overall';
}
