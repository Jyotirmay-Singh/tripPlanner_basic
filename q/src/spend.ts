// Pure, dependency-free helpers for the Spend Ranking bar chart (Phase 12). Mirrors the backend
// services/spend_summary.aggregate_spend payload and ranks it for display. Kept side-effect-free
// so the sort/scale logic is unit-testable without a component render (like src/settlements.ts and
// src/composition.ts). NOTHING here touches balances/settlement math — it only ranks gross paid.

export type SpendEntity = {
  entity_id: string;
  entity_type: 'individual' | 'family';
  name: string;
  paid: number;
  expense_count: number;
};

/** Shape of GET /trips/{id}/spend-summary. `currency` is added by the route. */
export type SpendSummary = {
  total: number;
  count: number;
  currency?: string;
  entities: SpendEntity[];
};

/** A spend entity with its rank + a 0..1 scale fraction for bar length AND shade intensity. */
export type RankedBar = SpendEntity & { rank: number; fraction: number };

/**
 * Rank entities DESCENDING by gross `paid` for the bar chart. Re-derived on every call (so the
 * chart re-sorts on every data change) and never mutates the input. Ties break deterministically
 * by name (case-insensitive) then entity_id, so equal spenders keep a stable order across renders.
 *
 * `fraction = paid / maxPaid` (0 when the top spender is <= 0), driving BOTH the bar length and the
 * single-hue shade intensity in SpendBarChart — the top spender is 1.0 (longest + deepest). Negative
 * paids cannot occur (the backend sums positives only) but are clamped to 0 defensively.
 */
export function rankSpend(entities: SpendEntity[] | null | undefined): RankedBar[] {
  const list = [...(entities ?? [])];
  list.sort((a, b) => {
    if (b.paid !== a.paid) return b.paid - a.paid;
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    if (an !== bn) return an < bn ? -1 : 1;
    return a.entity_id < b.entity_id ? -1 : a.entity_id > b.entity_id ? 1 : 0;
  });
  const max = list.reduce((m, e) => Math.max(m, e.paid), 0);
  return list.map((e, i) => ({
    ...e,
    rank: i,
    fraction: max > 0 ? Math.max(0, e.paid) / max : 0,
  }));
}
