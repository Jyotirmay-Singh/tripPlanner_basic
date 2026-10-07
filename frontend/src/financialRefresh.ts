export type FinancialChange = { accountId: string; tripId: string; reason: string };
const listeners = new Set<(event: FinancialChange) => void>();
export function publishFinancialChange(event: FinancialChange) {
  // Deliver after the initiating component has consumed its accepted response.
  setTimeout(() => listeners.forEach(listener => listener(event)), 0);
}
export function subscribeFinancialChanges(listener: (event: FinancialChange) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function publishFinancialScope(scope: string, reason: string) {
  try {
    const [accountId, tripId] = JSON.parse(scope);
    if (typeof accountId === 'string' && typeof tripId === 'string') publishFinancialChange({ accountId, tripId, reason });
  } catch { /* A scope is never inferred from an untrusted route or another account. */ }
}
