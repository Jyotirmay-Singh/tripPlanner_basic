import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import useExpenseSettlement from '../useExpenseSettlement';
import { coverage, requireFinancialConnection } from '../financialReview';
import { coverageFixture } from './expenseSettlement.fixtures';
jest.mock('../api', () => ({ getToken: async () => 'scoped-token', api: jest.fn() }));
jest.mock('../financialReview', () => ({ coverage: jest.fn(), requireFinancialConnection: jest.fn(async () => {}) }));
jest.mock('../offlineStore', () => ({ offlineStore: { getReadSnapshot: jest.fn(async () => null), putReadSnapshot: jest.fn(), removeTripReadData: jest.fn() } }));
const mockCoverage = coverage as jest.Mock;
let current!: ReturnType<typeof useExpenseSettlement>;
function Harness({ accountId = 'hook-account', tripId = 'hook-trip', offline = false }: { accountId?: string; tripId?: string; offline?: boolean }) {
  current = useExpenseSettlement({ accountId, tripId, sessionMode: offline ? 'offline' : 'online', active: true, preferCache: offline });
  return null;
}
beforeEach(() => { jest.clearAllMocks(); mockCoverage.mockResolvedValue(coverageFixture({ details: {} })); });
test('one summary request, selected-expense details bound to the snapshot, and no per-card requests', async () => {
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<Harness />); });
  expect(mockCoverage).toHaveBeenCalledTimes(1);
  mockCoverage.mockResolvedValueOnce(coverageFixture());
  await act(async () => { await current.refresh('dinner'); });
  expect(mockCoverage.mock.calls[1]).toEqual(['hook-trip', ['dinner'], expect.objectContaining({ snapshot: 'snapshot-1', authToken: 'scoped-token' })]);
  expect(current.data?.details?.dinner.participants).toHaveLength(4);
  await act(async () => tree.unmount());
});
test('offline cache retains its confirmation time while removing all action authority', async () => {
  let tree!: ReactTestRenderer;
  mockCoverage.mockResolvedValue(coverageFixture());
  await act(async () => { tree = TestRenderer.create(<Harness accountId="saved-account" />); });
  const calls = mockCoverage.mock.calls.length;
  await act(async () => { tree.update(<Harness accountId="saved-account" offline />); });
  expect(mockCoverage).toHaveBeenCalledTimes(calls);
  expect(current.source).toBe('cache'); expect(current.data?.generated_at).toBe('2026-10-07T09:00:00Z');
  expect(current.data?.availability.new_starts_available).toBe(false);
  expect(current.data?.details?.dinner.participants[1].actionable_amount).toBeNull();
  await act(async () => tree.unmount());
});
test('account switch suppresses obsolete sign-in/read results and never exposes another account cache', async () => {
  let resolve!: (value: unknown) => void;
  mockCoverage.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<Harness accountId="old-account" />); });
  await act(async () => tree.update(<Harness accountId="new-account" offline />));
  await act(async () => resolve(coverageFixture()));
  expect(current.data).toBeNull(); expect(current.source).toBe('unavailable');
  await act(async () => tree.unmount());
});
test('snapshot conflict renews the complete basis without mixing old participant details', async () => {
  let tree!: ReactTestRenderer;
  mockCoverage.mockResolvedValueOnce(coverageFixture());
  await act(async () => { tree = TestRenderer.create(<Harness accountId="changed-account" />); });
  mockCoverage.mockRejectedValueOnce({ detailCode: 'coverage_snapshot_changed' })
    .mockResolvedValueOnce(coverageFixture({ snapshot_id: 'new-snapshot', details: {} }))
    .mockResolvedValueOnce(coverageFixture({ snapshot_id: 'new-snapshot' }));
  await act(async () => { await current.refresh('dinner'); });
  expect(current.data?.snapshot_id).toBe('new-snapshot');
  expect(mockCoverage.mock.calls.at(-1)?.[2]).toEqual(expect.objectContaining({ snapshot: 'new-snapshot' }));
  await act(async () => tree.unmount());
});
test('authoritative access denial invalidates saved progress instead of falling back to it', async () => {
  let tree!: ReactTestRenderer;
  mockCoverage.mockResolvedValueOnce(coverageFixture());
  await act(async () => { tree = TestRenderer.create(<Harness accountId="denied-account" />); });
  mockCoverage.mockRejectedValueOnce({ code: 'http', status: 403 });
  await act(async () => { await current.refresh(); });
  expect(current.data).toBeNull(); expect(current.source).toBe('unavailable');
  await act(async () => tree.unmount());
});
test('reconnection does a live read; cached timestamp does not re-enable payments', async () => {
  let tree!: ReactTestRenderer;
  mockCoverage.mockResolvedValue(coverageFixture());
  await act(async () => { tree = TestRenderer.create(<Harness accountId="reconnect-account" />); });
  await act(async () => tree.update(<Harness accountId="reconnect-account" offline />));
  let resolve!: (value: unknown) => void;
  mockCoverage.mockImplementationOnce(() => new Promise(value => { resolve = value; }));
  await act(async () => tree.update(<Harness accountId="reconnect-account" />));
  expect(current.loading).toBe(true); expect(current.data?.availability.new_starts_available).toBe(false);
  await act(async () => resolve(coverageFixture()));
  expect(requireFinancialConnection).toHaveBeenCalled(); expect(current.source).toBe('live');
  await act(async () => tree.unmount());
});

test('a complete legacy payload without freshness metadata exposes no financial counts or authority', async () => {
  mockCoverage.mockResolvedValueOnce(coverageFixture({ protocol_version: undefined, generated_at: undefined }));
  let tree!: ReactTestRenderer;
  await act(async () => { tree = TestRenderer.create(<Harness accountId="legacy-metadata-account" />); });
  expect(current.data?.complete).toBe(false); expect(current.data?.expenses).toBeNull();
  expect(current.data?.availability.new_starts_available).toBe(false);
  await act(async () => tree.unmount());
});
