import { familyMemberIds } from './familyParticipation';
import { formatAccessibleMoney } from './format';
import type { StoredOutboxItem } from './offlineStore.shared';

type DisplayMember = { id: string; name?: string; kind?: string; family_members?: string[];
  family_member_ids?: string[] | null };
export type DisplayTrip = { name?: string; currency?: string; members?: DisplayMember[] };
export type PendingDisplaySnapshot = { tripName?: string; memberNames: Record<string, string> };

export function pendingPayload(item: StoredOutboxItem): Record<string, unknown> {
  return item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
    ? item.payload as Record<string, unknown> : {};
}

/** Local display context only. Never include this in a mutation payload. */
export function capturePendingDisplay(trip: DisplayTrip, relevantIds: string[]): PendingDisplaySnapshot {
  const selected = new Set(relevantIds);
  const memberNames: Record<string, string> = {};
  for (const member of trip.members ?? []) {
    if (!selected.has(member.id)) continue;
    if (member.name?.trim()) memberNames[member.id] = member.name.trim();
    if (member.kind === 'family') {
      familyMemberIds({ ...member, kind: member.kind, family_members: member.family_members ?? [] })
        .forEach((id, index) => {
          const name = member.family_members?.[index]?.trim();
          if (name) memberNames[id] = name;
        });
    }
  }
  return { ...(trip.name?.trim() ? { tripName: trip.name.trim() } : {}), memberNames };
}

function savedDisplay(item: StoredOutboxItem): PendingDisplaySnapshot | undefined {
  const precondition = item.precondition as { display?: PendingDisplaySnapshot } | null;
  return precondition?.display;
}

export function pendingMemberName(item: StoredOutboxItem, id: string, trip?: DisplayTrip | null): string {
  const saved = savedDisplay(item)?.memberNames?.[id];
  if (typeof saved === 'string' && saved.trim()) return saved;
  const current = capturePendingDisplay(trip ?? {}, (trip?.members ?? []).map((member) => member.id));
  return current.memberNames[id] || 'Member unavailable';
}

export function pendingDisplay(item: StoredOutboxItem, trip?: DisplayTrip | null) {
  const payload = pendingPayload(item);
  const payment = item.operation === 'manual_payment_create';
  const identity = payment
    ? `${pendingMemberName(item, String(payload.from_member_id), trip)} → ${pendingMemberName(item, String(payload.to_member_id), trip)}`
    : typeof payload.description === 'string' && payload.description.trim() ? payload.description
      : typeof payload.category === 'string' && payload.category.trim() ? payload.category : 'Transaction';
  // A converted foreign intent still represents the originally captured amount.
  const rawValue = payment ? payload.amount : payload.original_amount ?? payload.amount;
  const value = typeof rawValue === 'number' || (typeof rawValue === 'string' && rawValue.trim())
    ? Number(rawValue) : Number.NaN;
  const rawCurrency = payment ? payload.expected_currency
    : payload.original_currency ?? payload.currency ?? trip?.currency;
  const currency = typeof rawCurrency === 'string' ? rawCurrency : '';
  const amount = Number.isFinite(value)
    ? formatAccessibleMoney(value, { currency }) : 'Amount unavailable';
  const tripName = savedDisplay(item)?.tripName || trip?.name || 'Group unavailable';
  return { identity, amount, tripName, actionLabel: (action: string) => `${action}: ${identity}, ${amount}, ${tripName}` };
}
