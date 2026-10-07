// Browser recovery is tab-scoped. This store is separate from financial read caches and outboxes.
const serverMemory = new Map<string, string>();
const key = (scope: string) => `financial_recovery_v1:${scope}`;
export async function readRecovery(scope: string): Promise<string | null> {
  return typeof sessionStorage === 'undefined' ? serverMemory.get(scope) ?? null : sessionStorage.getItem(key(scope));
}
export async function writeRecovery(scope: string, value: string): Promise<void> {
  if (typeof sessionStorage === 'undefined') { serverMemory.set(scope, value); return; }
  sessionStorage.setItem(key(scope), value);
  if (sessionStorage.getItem(key(scope)) !== value) throw new Error('Payment recovery could not be saved. No request was sent.');
}
export async function removeRecovery(scope: string): Promise<void> {
  if (typeof sessionStorage === 'undefined') serverMemory.delete(scope);
  else sessionStorage.removeItem(key(scope));
}
