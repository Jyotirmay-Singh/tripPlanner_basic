import { categoryAccent, categoryOrder } from './categories';
import { fromCurrencyUnits, toCurrencyUnits } from './currencies';
export type CategoryTotal = { name: string; gross: number; refunds: number; net: number };
/** Canonical, confirmed expense amounts only. Payments and pending mutations are never inputs. */
export function buildCategorySummary(expenses: readonly { category: string; amount: number }[], currency = 'INR', mode: 'light' | 'dark' = 'light') {
  const grouped = new Map<string, { gross: number; refunds: number }>();
  for (const expense of expenses) {
    if (!Number.isFinite(expense.amount)) continue;
    const amount = toCurrencyUnits(expense.amount, currency);
    if (!amount) continue;
    const row = grouped.get(expense.category) ?? { gross: 0, refunds: 0 };
    if (amount > 0) row.gross += amount; else row.refunds -= amount;
    grouped.set(expense.category, row);
  }
  const rows: CategoryTotal[] = Array.from(grouped, ([name, row]) => ({ name,
    gross: fromCurrencyUnits(row.gross, currency), refunds: fromCurrencyUnits(row.refunds, currency),
    net: fromCurrencyUnits(row.gross - row.refunds, currency) }));
  const order = (a: CategoryTotal, b: CategoryTotal) => categoryOrder(a.name) - categoryOrder(b.name) || a.name.localeCompare(b.name);
  rows.sort(order);
  const slices = rows.filter((row) => row.gross > 0).sort((a, b) => b.gross - a.gross || order(a, b))
    .map((row) => ({ key: row.name, label: row.name, value: row.gross, color: categoryAccent(row.name, mode) }));
  const gross = fromCurrencyUnits(Array.from(grouped.values()).reduce((sum, row) => sum + row.gross, 0), currency);
  const refunds = fromCurrencyUnits(Array.from(grouped.values()).reduce((sum, row) => sum + row.refunds, 0), currency);
  return { rows, slices, gross, refunds, net: fromCurrencyUnits(toCurrencyUnits(gross, currency) - toCurrencyUnits(refunds, currency), currency) };
}
