/* eslint-disable @typescript-eslint/no-require-imports */
const mockRecords = new Map<string, string>();
const mockApi = jest.fn();
const mockWrite = jest.fn(async (scope: string, value: string) => { mockRecords.set(scope, value); });
const mockUuid = jest.fn(() => 'original-mutation-id');
jest.mock('../api', () => ({ api: (...args: unknown[]) => mockApi(...args) }));
jest.mock('expo-crypto', () => ({ randomUUID: () => mockUuid() }));
jest.mock('../financialRecoveryStorage', () => ({
  readRecovery: async (scope: string) => mockRecords.get(scope) ?? null,
  writeRecovery: (scope: string, value: string) => mockWrite(scope, value),
  removeRecovery: async (scope: string) => { mockRecords.delete(scope); },
}));
beforeEach(() => { jest.resetModules(); mockRecords.clear(); mockApi.mockReset(); mockWrite.mockClear(); mockUuid.mockClear(); });
test('process restart hydrates exact body and UUID; recovery reads known durable work before retrying', async () => {
  let client = require('../reviewedSettlement');
  const scope = '["payer","trip"]', body = { expected_intent_version: 0, plan_hash: 'plan', action: 'report_paid', note: 'private evidence' };
  mockApi.mockRejectedValueOnce({ code: 'timeout' });
  await expect(client.reviewedMutation(scope, '/trips/trip/settlement-intents/intent/legs/leg/actions', body, 'token', () => true)).rejects.toEqual({ code: 'timeout' });
  const original = mockApi.mock.calls[0];
  jest.resetModules(); client = require('../reviewedSettlement');
  await client.hydrateReviewedMutation(scope);
  expect(client.hasUnresolvedSubmission(scope)).toBe(true);
  expect(client.hasUnresolvedSubmission('["other","trip"]')).toBe(false);
  expect(mockApi).toHaveBeenCalledTimes(1); // Hydration submits nothing.
  mockApi.mockResolvedValueOnce({ id: 'intent', action_history: [] }).mockResolvedValueOnce({ id: 'intent' });
  await client.retryReviewedMutation(scope, 'token', () => true);
  expect(mockApi.mock.calls[1][0]).toBe('/trips/trip/settlement-intents/intent');
  expect(mockApi.mock.calls[2]).toEqual(original);
  expect(mockUuid).toHaveBeenCalledTimes(1);
  expect(mockRecords.size).toBe(0);
});
test('committed start with lost handoff reply is recovered without replaying its external launch', async () => {
  let client = require('../reviewedSettlement');
  const scope = '["payer","trip"]';
  mockApi.mockRejectedValueOnce({ code: 'http', status: 409 });
  await expect(client.reviewedMutation(scope, '/trips/trip/settlement-intents/intent/legs/leg/actions', { action: 'start' }, 'token', () => true)).rejects.toMatchObject({ status: 409 });
  jest.resetModules(); client = require('../reviewedSettlement');
  mockApi.mockResolvedValueOnce({ id: 'intent', action_history: [{ request: { client_mutation_id: 'original-mutation-id' } }] });
  await client.retryReviewedMutation(scope, 'token', () => true);
  expect(mockApi).toHaveBeenCalledTimes(2); expect(mockRecords.size).toBe(0);
});
test('storage failure prevents any server write, and an obsolete account cannot explicitly retry', async () => {
  const client = require('../reviewedSettlement');
  mockWrite.mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(client.reviewedMutation('scope', '/create', {}, 'token', () => true)).rejects.toThrow('Storage unavailable');
  expect(mockApi).not.toHaveBeenCalled();
  await expect(client.retryReviewedMutation('scope', 'token', () => false)).rejects.toThrow('no longer open');
  expect(mockApi).not.toHaveBeenCalled();
});
test('changed recipient with no committed start clears recovery after an explicit server reconciliation', async () => {
  const client = require('../reviewedSettlement'), scope = '["payer","trip"]';
  mockApi.mockRejectedValueOnce({ code: 'http', status: 409 });
  await expect(client.reviewedMutation(scope, '/trips/trip/settlement-intents/intent/legs/leg/actions', { action: 'start' }, 'token', () => true)).rejects.toMatchObject({ status: 409 });
  mockApi.mockResolvedValueOnce({ id: 'intent', action_history: [] }).mockRejectedValueOnce({ code: 'http', status: 409 })
    .mockResolvedValueOnce({ id: 'intent', action_history: [] });
  await expect(client.retryReviewedMutation(scope, 'token', () => true)).rejects.toMatchObject({ status: 409 });
  expect(client.hasUnresolvedSubmission(scope)).toBe(false); expect(mockRecords.size).toBe(0);
});
