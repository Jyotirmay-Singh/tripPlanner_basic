
export const groupA = [
  { id: 'a-food', category: 'Food', amount: 1000 },
  { id: 'a-travel', category: 'Travel', amount: 500 },
  { id: 'a-travel-refund', category: 'Travel', amount: -500 },
  { id: 'a-bank-refund', category: 'Bank Fees & Interest', amount: -200 },
].map((row) => ({ ...row, description: row.id, date: '03-10-26', currency: 'INR',
  paid_by_member_id: 'm1', split_member_ids: ['m1'] }));
export const groupB = [
  { id: 'b-groceries', category: 'Groceries', amount: 90 },
  { id: 'b-shipping', category: 'Shipping & Delivery', amount: 30 },
  { id: 'b-refund', category: 'Other', amount: -5 },
].map((row) => ({ ...row, description: row.id, date: '03-10-26', currency: 'INR',
  paid_by_member_id: 'm1', split_member_ids: ['m1'] }));
export function deferred<T = any>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
