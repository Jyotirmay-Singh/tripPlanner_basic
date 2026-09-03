import type { Transfer } from './settlements';

export type SettlementStatus = 'open' | 'settled_exactly' | 'settled_within_rounding';

export type SettlementProjection = {
  enabled: boolean;
  currency: string;
  increment: string;
  balance_scale: number;
  policy_version: string;
  status: SettlementStatus;
  precise_net: Record<string, string>;
  rounded_net: Record<string, number>;
  rounding_adjustments: Record<string, string>;
  rounding_algorithm: string;
  tie_break: string;
  routing: {
    algorithm: 'exact_dfs_v1' | 'greedy_heap_v1';
    optimal: boolean;
    states_explored: number;
    fallback_reason: 'entity_limit' | 'state_limit' | null;
    transfer_count_bound: number;
  };
};

export type BalanceResponse<Member = unknown> = {
  net: Record<string, number>;
  transfers: Transfer[];
  members: Member[];
  currency: string;
  settlement_projection?: SettlementProjection;
};

export function usesWholeUnits(projection: SettlementProjection | null | undefined): boolean {
  return projection?.enabled === true && projection.increment === '1';
}

/** Format an API fixed-decimal string without first making it a JS floating-point number. */
export function formatPreciseMoney(value: string | undefined, currency: string): string {
  if (value === undefined) return `${currency} —`;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) return `${currency} ${value}`;
  const sign = match[1];
  const grouped = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const rawFraction = match[3] ?? '';
  const fraction = rawFraction.replace(/0+$/, '');
  const shownFraction = fraction.length > 0 ? fraction : '00';
  return `${currency} ${sign}${grouped}.${shownFraction}`;
}

export function currentSuggestedAmount(
  transfers: Transfer[] | null | undefined,
  fromId: string,
  toId: string,
): number {
  return transfers?.find(
    (transfer) => transfer.from_member_id === fromId && transfer.to_member_id === toId,
  )?.amount ?? 0;
}
