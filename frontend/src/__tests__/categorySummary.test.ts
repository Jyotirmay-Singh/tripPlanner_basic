import { buildCategorySummary } from '../categorySummary';
import { CATEGORIES } from '../categories';
it('produces exactly two gross slices and keeps fully refunded/refund-only categories', () => {
  const result = buildCategorySummary([
    { category: 'Food', amount: 1000 }, { category: 'Travel', amount: 500 },
    { category: 'Travel', amount: -500 }, { category: 'Bank Fees & Interest', amount: -200 },
  ]);
  expect(result).toMatchObject({ gross: 1500, refunds: 700, net: 800 });
  expect(result.slices.map((row) => [row.key, row.value])).toEqual([['Food', 1000], ['Travel', 500]]);
  expect(result.rows).toContainEqual({ name: 'Travel', gross: 500, refunds: 500, net: 0 });
  expect(result.rows).toContainEqual({ name: 'Bank Fees & Interest', gross: 0, refunds: 200, net: -200 });
});
it('handles empty, zero, refund-only and over-refunded data', () => {
  expect(buildCategorySummary([]).slices).toEqual([]);
  expect(buildCategorySummary([{ category: 'Other', amount: 0 }]).rows).toEqual([]);
  expect(buildCategorySummary([{ category: 'Pets', amount: -50 }])).toMatchObject({ slices: [], refunds: 50, net: -50 });
  expect(buildCategorySummary([{ category: 'Pets', amount: 10 }, { category: 'Pets', amount: -50 }])).toMatchObject({ net: -40, slices: [{ key: 'Pets', value: 10 }] });
});
it('keeps category colours stable across ranking changes and supports all 30 and historical strings', () => {
  const first = buildCategorySummary([{ category: 'Food', amount: 5 }, { category: 'Travel', amount: 10 }]);
  const second = buildCategorySummary([{ category: 'Food', amount: 20 }, { category: 'Travel', amount: 10 }]);
  expect(first.slices.find((row) => row.key === 'Food')?.color).toBe(second.slices[0].color);
  expect(buildCategorySummary(CATEGORIES.map((category) => ({ category, amount: 1 }))).slices).toHaveLength(30);
  expect(buildCategorySummary([{ category: 'Historical', amount: 3 }]).slices[0].label).toBe('Historical');
});
it('includes oldest-only categories and refunds in 1001 and 5001 complete fixtures', () => {
  for (const size of [999, 1000, 1001, 5001]) {
    const rows = Array.from({ length: size - 2 }, () => ({ category: 'Food', amount: 1 }));
    rows.push({ category: 'Travel', amount: 10 }, { category: 'Travel', amount: -2 });
    expect(buildCategorySummary(rows)).toMatchObject({ gross: size + 8, refunds: 2, net: size + 6 });
  }
});
