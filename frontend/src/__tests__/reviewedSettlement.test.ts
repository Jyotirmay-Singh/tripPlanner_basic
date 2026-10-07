import { api } from '../api';
import { createReviewedQuote, hasUnresolvedSubmission, reviewedMutation, retryReviewedMutation } from '../reviewedSettlement';
jest.mock('../api', () => ({ api: jest.fn() }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'permanent-retry-id') }));
const mockApi = api as jest.Mock;
beforeEach(() => mockApi.mockReset());
test('direct gross payment sends exact shares without consulting the recommendation-limited endpoint', async () => {
  mockApi.mockResolvedValue({ id: 'quote' });
  await createReviewedQuote('trip', { mode: 'direct', method: 'upi', expected_snapshot_id: 'snapshot',
    shares: [{ share_id: 'share', amount: '100' }], parties: [{ from_member_id: 'b', to_member_id: 'a', payer_person_id: 'b', recipient_person_id: 'a' }] }, 'captured-token');
  expect(mockApi).toHaveBeenCalledWith('/trips/trip/settlement-quotes', expect.objectContaining({ body: expect.objectContaining({ shares: [{ share_id: 'share', amount: '100' }] }) }));
});
test('lost replies retain exact UUID/body; another payment is blocked until identical retry resolves', async () => {
  const scope = 'lost-response';
  mockApi.mockRejectedValueOnce({ code: 'timeout' }).mockResolvedValueOnce({ id: 'accepted' });
  await expect(reviewedMutation(scope, '/create', { quote_id: 'q', quote_hash: 'h' }, 'token', () => true)).rejects.toEqual({ code: 'timeout' });
  expect(hasUnresolvedSubmission(scope)).toBe(true);
  await expect(reviewedMutation(scope, '/create', { quote_id: 'different' }, 'token', () => true)).rejects.toThrow('previous submission');
  await retryReviewedMutation(scope, 'token', () => true);
  expect(mockApi.mock.calls[0]).toEqual(mockApi.mock.calls[1]);
  expect(hasUnresolvedSubmission(scope)).toBe(false);
});
test('double taps share one in-flight operation and revoked scope performs no write', async () => {
  let resolve!: (value: unknown) => void;
  mockApi.mockImplementation(() => new Promise(value => { resolve = value; }));
  const one = reviewedMutation('double-tap', '/create', { quote_id: 'q' }, 'token', () => true);
  const two = reviewedMutation('double-tap', '/create', { quote_id: 'q' }, 'token', () => true);
  await new Promise(done => setTimeout(done, 0));
  expect(mockApi).toHaveBeenCalledTimes(1); resolve({ id: 'accepted' }); await Promise.all([one, two]);
  await expect(reviewedMutation('revoked-scope', '/create', {}, 'old-token', () => false)).rejects.toThrow('no longer open');
  expect(mockApi).toHaveBeenCalledTimes(1);
});
