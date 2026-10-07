/* eslint-disable @typescript-eslint/no-require-imports */
// Launched by backend/tests/test_payment_journey_client_mongo.py against a real disposable API.
// Native/host seams are stubbed; api, quotes, intents, approvals and coverage use actual HTTP.
import React from 'react';
import Renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { AppState, type AppStateStatus } from 'react-native';
import { api } from '../api';
import { completeCoverage, type ReviewedIntent } from '../financialReview';
import Flow, { type SettlementSelection } from '../ReviewedSettlementFlow';
import Panel from '../ReviewedIntentPanel';
import Hub from '../ReviewedSettlementHub';
import { publishFinancialChange } from '../financialRefresh';
import { createReviewedQuote, hasUnresolvedSubmission, reviewedMutation } from '../reviewedSettlement';
import { copyUpiId, copyAndLaunchUpiApp } from '../upiLauncher';
import { notificationHref } from '../notificationRouting';
import type { SettlementTrip } from '../expenseSettlement';

let mockToken = '';
jest.mock('../tokenStorage', () => ({ getStoredToken: async () => mockToken, setStoredToken: async () => {} }));
jest.mock('@react-native-community/netinfo', () => ({ __esModule: true, default: { fetch: async () => ({ isConnected: true, isInternetReachable: true }) } }));
jest.mock('expo-crypto', () => ({ randomUUID: () => require('node:crypto').randomUUID() }));
jest.mock('../upiLauncher', () => ({ discoverUpiApps: async () => ({ apps: [{ id: 'google-pay', label: 'Google Pay', packageName: 'fixture' }] }),
  copyUpiId: jest.fn(async () => ({ ok: true })), copyAndLaunchUpiApp: jest.fn(async () => ({ ok: true })) }));
jest.mock('../T', () => ({ __esModule: true, default: (p: any) => require('react').createElement('T', p, p.children) }));
jest.mock('../ui/Button', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Button', p) }));
jest.mock('../ui/Input', () => ({ __esModule: true, default: (p: any) => require('react').createElement('Input', p) }));

type Actor = 'payer' | 'receiver' | 'admin' | 'outsider' | 'secondPayer' | 'secondReceiver';
type Case = { trip: SettlementTrip; expenseId: string; payerWallet: string; receiverWallet: string; seededIntentId?: string };
const fixturePath = process.env.PAYMENT_JOURNEY_FIXTURE;
const fixture: { users: Record<Actor, { id: string; token: string }>; cases: Record<string, Case> } = fixturePath
  ? JSON.parse(require('node:fs').readFileSync(fixturePath, 'utf8')) : { users: {}, cases: {} };
const requests: { path: string; method: string; body: string }[] = [];
let loseResponseFor = '';
const actor = (who: Actor) => { mockToken = fixture.users[who].token; return fixture.users[who].id; };
const scope = (data: Case, who: Actor) => JSON.stringify([fixture.users[who].id, data.trip.id]);
const host = (tree: ReactTestRenderer, id: string) => tree.root.find(node => typeof node.type === 'string' && node.props.testID === id);
async function until(check: () => boolean, state = 'reviewed state') {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  }
  throw new Error(`Client did not reach ${state}`);
}
async function press(tree: ReactTestRenderer, id: string) {
  const control = host(tree, id);
  expect(control.props.disabled).not.toBe(true);
  await act(async () => { control.props.onPress(); await new Promise(resolve => setTimeout(resolve, 20)); });
}
async function progress(data: Case) {
  let result!: Awaited<ReturnType<typeof completeCoverage>>;
  await act(async () => { result = await completeCoverage(data.trip.id, { authToken: mockToken }); }); return result;
}
async function detail(data: Case, id: string) {
  let result!: ReviewedIntent;
  await act(async () => { result = await api<ReviewedIntent>(`/trips/${data.trip.id}/settlement-intents/${id}`, { authToken: mockToken }); }); return result;
}
async function create(data: Case, method: 'upi' | 'cash' | 'bank' | 'offset', mode: 'direct' | 'group' | 'offset' = 'direct', amount = '100', who: Actor = 'payer', override?: SettlementSelection) {
  const accountId = actor(who);
  const current = await progress(data);
  const share = current.details![data.expenseId].participants.find(row => row.person_id === data.payerWallet)!;
  const selection: SettlementSelection = override ?? (mode === 'group'
    ? { mode: 'group', transfer: { from_member_id: data.payerWallet, to_member_id: data.receiverWallet, amount } }
    : { mode, fromWallet: data.payerWallet, toWallet: data.receiverWallet, shares: [{ share_id: share.id, amount }] });
  let committed: ReviewedIntent | undefined;
  let tree!: ReactTestRenderer;
  await act(async () => { tree = Renderer.create(<Flow trip={data.trip} accountId={accountId} sessionMode="online"
    scope={scope(data, who)} selection={selection} snapshotId={current.snapshot_id!} live isAdmin={who === 'admin'}
    expenseNames={{ [data.expenseId]: 'Dinner' }} shareDescriptions={Object.fromEntries(current.details![data.expenseId].participants.map(row => [row.id, `Dinner · ${row.person_name}`]))}
    onComplete={() => {}} onBack={() => {}} onAdminReview={() => {}} onCommitted={row => { committed = row; }} />); });
  if (method === 'cash' || method === 'bank') await press(tree, `settlement-method-${method}`);
  await press(tree, 'settlement-preview');
  await until(() => tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'settlement-submit').length === 1
    || JSON.stringify(tree.toJSON()).includes('depends on other payments'), 'quote or dependent party selection');
  if (!tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'settlement-submit').length) await press(tree, 'settlement-preview');
  await until(() => tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'settlement-submit').length === 1);
  const text = JSON.stringify(tree.toJSON());
  expect(text).toContain('Proposed expense coverage');
  if (mode === 'group') expect(text).toContain('Proposed expense coverage');
  await press(tree, 'settlement-submit'); await until(() => !!committed);
  await act(async () => tree.unmount());
  return committed!;
}
async function panel(data: Case, id: string, who: Actor) {
  const accountId = actor(who);
  let row = await detail(data, id), tree!: ReactTestRenderer;
  const props = { trip: data.trip, accountId, sessionMode: 'online', isAdmin: who === 'admin', scope: scope(data, who), live: true,
    expenseNames: { [data.expenseId]: 'Dinner' }, onAdminReview: () => {}, onComplete: async () => {
      row = await api<ReviewedIntent>(`/trips/${data.trip.id}/settlement-intents/${id}`, { authToken: mockToken }); tree.update(<Panel {...props} row={row} />);
    } };
  await act(async () => { tree = Renderer.create(<Panel {...props} row={row} />); });
  const firstAction = row.action_history?.[0]?.operation;
  if (firstAction) await until(() => JSON.stringify(tree.toJSON()).includes(firstAction), 'authorized report history');
  return { tree, get row() { return row; } };
}
async function decide(data: Case, id: string, who: Actor, action: string, reason = '', personId?: string, legId?: string) {
  actor(who); const row = await detail(data, id);
  return reviewedMutation(scope(data, who), `/trips/${data.trip.id}/settlement-intents/${id}/approvals`, {
    expected_intent_version: row.version, plan_hash: row.plan.plan_hash, action, reason,
    ...(personId ? { person_id: personId } : row.cash_legs.length ? { leg_id: legId ?? row.cash_legs[0].id } : {}),
  }, mockToken, () => true);
}

// A fetch-compatible transport backed by node:http: every response comes from the real API.
beforeAll(() => {
  const records = new Map<string, string>();
  Object.defineProperty(global, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => records.get(key) ?? null, setItem: (key: string, value: string) => { records.set(key, value); },
    removeItem: (key: string) => { records.delete(key); },
  } });
  global.fetch = ((url: string, options: any = {}) => new Promise((resolve, reject) => {
    const target = new URL(url), path = target.pathname;
    requests.push({ path, method: options.method ?? 'GET', body: options.body ?? '' });
    const req = require('node:http').request(target, { method: options.method, headers: options.headers }, (res: any) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (part: string) => { body += part; });
      res.on('end', () => {
        if (loseResponseFor === path && options.method === 'POST') { loseResponseFor = ''; reject(new Error('Injected lost reply after commit')); return; }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body,
          headers: { get: (key: string) => res.headers[key.toLowerCase()] ?? null } } as unknown as Response);
      });
    });
    req.on('error', reject);
    options.signal?.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    if (options.body) req.write(options.body); req.end();
  })) as typeof fetch;
});

(fixturePath ? describe : describe.skip)('real reviewed client/API/database journey', () => {
  jest.setTimeout(60000);
  test('UPI launch failures and lost report reply preserve one intent; partial receiver approval leaves ₹60', async () => {
    const data = fixture.cases.upi;
    let row = await create(data, 'upi', 'direct', '40');
    expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
    const p = await panel(data, row.id, 'payer'), legId = row.cash_legs[0].id;
    (copyAndLaunchUpiApp as jest.Mock).mockResolvedValueOnce({ ok: false, message: 'Address copied; app launch failed. Check before sending again.' });
    await press(p.tree, `settlement-upi-open-${legId}-google-pay`);
    await until(() => p.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-action-submit-${row.id}`).length === 1);
    await press(p.tree, `settlement-action-submit-${row.id}`);
    await until(() => p.row.version === 1, 'first started version');
    expect(JSON.stringify(p.tree.toJSON())).toContain('launch failed');
    expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
    (copyUpiId as jest.Mock).mockResolvedValueOnce({ ok: false, message: 'Clipboard unavailable. App was not opened.' });
    await press(p.tree, `settlement-upi-copy-${legId}`);
    await until(() => p.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-action-submit-${row.id}`).length === 1);
    await press(p.tree, `settlement-action-submit-${row.id}`); await until(() => p.row.version === 2, 'second started version');
    expect(copyAndLaunchUpiApp).toHaveBeenCalledTimes(1);
    await press(p.tree, `settlement-report-${legId}`);
    await until(() => p.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-reference-${row.id}`).length === 1);
    await act(async () => { host(p.tree, `settlement-reference-${row.id}`).props.onChangeText('TEST-REF-40'); host(p.tree, `settlement-reason-${row.id}`).props.onChangeText('Bank history checked'); });
    loseResponseFor = `/api/trips/${data.trip.id}/settlement-intents/${row.id}/legs/${legId}/actions`;
    const before = requests.filter(req => req.path === loseResponseFor && req.method === 'POST').length;
    await press(p.tree, `settlement-action-submit-${row.id}`); await until(() => hasUnresolvedSubmission(scope(data, 'payer'))
      && p.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-retry-${row.id}` && !node.props.loading).length === 1, 'explicit retry after lost reply');
    await press(p.tree, `settlement-retry-${row.id}`); await until(() => p.row.cash_legs[0].receipt_status === 'awaiting_review', 'recovered paid report');
    expect(requests.filter(req => req.path.endsWith(`/legs/${legId}/actions`) && req.method === 'POST')).toHaveLength(before + 1);
    expect(hasUnresolvedSubmission(scope(data, 'payer'))).toBe(false);
    expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
    await expect(decide(data, row.id, 'payer', 'confirm_received')).rejects.toMatchObject({ status: 403 });
    await act(async () => p.tree.unmount());
    const reviewer = await panel(data, row.id, 'receiver');
    await until(() => JSON.stringify(reviewer.tree.toJSON()).includes('TEST-REF-40'));
    expect(JSON.stringify(reviewer.tree.toJSON())).toContain('Bank history checked');
    await press(reviewer.tree, `settlement-confirm-${legId}`);
    await until(() => reviewer.tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-action-submit-${row.id}`).length === 1);
    expect(JSON.stringify(reviewer.tree.toJSON())).toContain('01-10-26');
    await press(reviewer.tree, `settlement-action-submit-${row.id}`); await until(() => reviewer.row.allocation_status === 'applied');
    expect(JSON.stringify(reviewer.tree.toJSON())).toContain('Receiver confirmed');
    const final = await progress(data), bill = final.expenses!.find(item => item.expense_id === data.expenseId)!;
    expect(bill.remaining_amount).toBe('60'); expect(bill.settled_count).toBe(0);
    await act(async () => reviewer.tree.unmount());
  });
  test('successful slow UPI launch and app return keep receipt pending until reporting and receiver confirmation', async () => {
    const data = fixture.cases.happyUpi, row = await create(data, 'upi'), leg = row.cash_legs[0].id;
    const stateListeners = new Set<(state: AppStateStatus) => void>();
    const priorAppStateListener = AppState.addEventListener;
    AppState.addEventListener = (_event, listener) => {
      stateListeners.add(listener); return { remove: () => { stateListeners.delete(listener); } };
    };
    let launchStillCurrent = false, tree: ReactTestRenderer | undefined;
    (copyAndLaunchUpiApp as jest.Mock).mockImplementationOnce(async (_address, _app, dependencies) => {
      await new Promise(resolve => setTimeout(resolve, 400));
      launchStillCurrent = dependencies.isCurrent();
      return { ok: launchStillCurrent, message: 'Launch interrupted by obsolete review' };
    });
    try {
      await act(async () => { tree = Renderer.create(<Hub trip={data.trip} accountId={fixture.users.payer.id} sessionMode="online"
        isAdmin={false} expenseNames={{ [data.expenseId]: 'Dinner' }} focusIntentId={row.id} onChanged={() => {}} onAdminReview={() => {}} />); });
      await until(() => !!tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-upi-open-${leg}-google-pay` && !node.props.disabled).length,
        'live sending instructions');
      await press(tree!, `settlement-upi-open-${leg}-google-pay`);
      await until(() => !!tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-action-submit-${row.id}`).length);
      await press(tree!, `settlement-action-submit-${row.id}`);
      await until(() => JSON.stringify(tree!.toJSON()).includes('UPI address copied for'), 'successful slow launch');
      expect(launchStillCurrent).toBe(true);
      await act(async () => {
        stateListeners.forEach(listener => listener('background')); stateListeners.forEach(listener => listener('active'));
        await new Promise(resolve => setTimeout(resolve, 250));
      });
      await until(() => !!tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-report-${leg}` && !node.props.disabled).length,
        'returned payment report');
      expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
      expect((await detail(data, row.id)).cash_legs[0].receipt_status).toBe('initiated');
      await press(tree!, `settlement-report-${leg}`);
      await until(() => !!tree!.root.findAll(node => typeof node.type === 'string' && node.props.testID === `settlement-action-submit-${row.id}`).length);
      await press(tree!, `settlement-action-submit-${row.id}`);
      await until(() => JSON.stringify(tree!.toJSON()).includes('Awaiting approval'), 'pending receipt');
      expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
    } finally {
      if (tree) await act(async () => tree!.unmount());
      AppState.addEventListener = priorAppStateListener;
    }
    expect((await decide(data, row.id, 'receiver', 'confirm_received')).allocation_status).toBe('applied');
    expect((await progress(data)).expenses![0].remaining_amount).toBe('0');
  });
  test.each(['cash', 'bank', 'receiverReport'])('%s reporting and receipt remain separate; cross-trip and outsider access fail', async name => {
    const data = fixture.cases[name], who = name === 'receiverReport' ? 'receiver' : 'payer';
    const row = await create(data, name === 'bank' ? 'bank' : 'cash', 'direct', '100', who);
    expect(row.cash_legs[0].receipt_status).toBe('awaiting_review');
    expect((await progress(data)).expenses![0].remaining_amount).toBe('100');
    const evidence = await detail(data, row.id);
    expect(evidence.reports![0].reporting_actor_snapshot?.name).toBe(who === 'receiver' ? 'Receiver' : 'Payer');
    const reviewer = await panel(data, row.id, 'receiver');
    await until(() => JSON.stringify(reviewer.tree.toJSON()).includes('Reported payment:'), 'reported cash evidence');
    expect(JSON.stringify(reviewer.tree.toJSON())).toContain(who === 'receiver' ? 'Receiver' : 'Payer');
    await act(async () => reviewer.tree.unmount());
    await decide(data, row.id, 'receiver', 'confirm_received');
    expect((await progress(data)).expenses![0].remaining_amount).toBe('0');
    actor('outsider'); await expect(detail(data, row.id)).rejects.toMatchObject({ status: 403 });
    actor('receiver'); await expect(detail(fixture.cases.upi, row.id)).rejects.toMatchObject({ status: 404 });
  });
  test('gross direct ₹100 and simplified ₹20 are explained; cash waits for person consents', async () => {
    const data = fixture.cases.group; actor('payer'); const initial = await progress(data);
    const share = initial.details![data.expenseId].participants[0];
    const gross = await createReviewedQuote(data.trip.id, { mode: 'direct', method: 'cash', expected_snapshot_id: initial.snapshot_id!,
      shares: [{ share_id: share.id, amount: '100' }], parties: [{ from_member_id: data.payerWallet, to_member_id: data.receiverWallet,
        payer_person_id: data.payerWallet, recipient_person_id: data.receiverWallet }] }, mockToken);
    expect(gross.cash_legs[0].amount).toBe('100');
    const row = await create(data, 'cash', 'group', '20');
    let current = await decide(data, row.id, 'receiver', 'confirm_received');
    expect(current.allocation_status).toBe('awaiting_consent');
    expect((await progress(data)).expenses!.find(bill => bill.expense_id === data.expenseId)!.remaining_amount).toBe('100');
    for (const person of current.plan.required_person_ids) current = await decide(data, row.id, person === data.payerWallet ? 'payer' : 'receiver', 'consent', '', person);
    expect(current.allocation_status).toBe('applied');
    const final = await progress(data); expect(final.expenses!.every(bill => bill.remaining_amount === '0')).toBe(true);
    const dinner = final.details![data.expenseId].participants[0]; expect(dinner.coverage).toMatchObject({ group: '20', approved_offset: '80' });
    actor('payer'); await expect(createReviewedQuote(data.trip.id, { mode: 'direct', method: 'cash', expected_snapshot_id: final.snapshot_id!,
      shares: [{ share_id: dinner.id, amount: '100' }], parties: [{ from_member_id: data.payerWallet, to_member_id: data.receiverWallet,
        payer_person_id: data.payerWallet, recipient_person_id: data.receiverWallet }] }, mockToken)).rejects.toMatchObject({ status: 409 });
  });
  test('offsets transfer no money; admin needs reason; person decline requires withdrawal', async () => {
    const data = fixture.cases.offset, row = await create(data, 'offset', 'offset');
    const pending = await progress(data); expect(pending.expenses!.every(bill => bill.reserved_amount === '0')).toBe(true);
    await expect(decide(data, row.id, 'admin', 'admin_override')).rejects.toMatchObject({ status: 403 });
    const applied = await decide(data, row.id, 'admin', 'admin_override', 'All affected people agreed'); expect(applied.allocation_status).toBe('applied');
    const declinedData = fixture.cases.decline, proposal = await create(declinedData, 'offset', 'offset');
    await decide(declinedData, proposal.id, 'payer', 'decline_allocation', 'Prefer separate payments', declinedData.payerWallet);
    await expect(decide(declinedData, proposal.id, 'admin', 'admin_override', 'Override')).rejects.toMatchObject({ status: 409 });
    const withdrawn = await decide(declinedData, proposal.id, 'payer', 'cancel'); expect(withdrawn.status).toBe('canceled');
  });
  test('dispute preserves debt and claim; only explicit authorized unsent resolution releases it', async () => {
    const data = fixture.cases.dispute, row = await create(data, 'cash');
    let current = await decide(data, row.id, 'receiver', 'report_not_received', 'Bank history has no transfer');
    expect(current.status).toBe('needs_review');
    const pending = await progress(data); expect(pending.expenses![0].remaining_amount).toBe('100'); expect(pending.expenses![0].reserved_amount).toBe('100');
    await expect(decide(data, row.id, 'payer', 'resolve_not_sent', 'Not sent')).rejects.toMatchObject({ status: 403 });
    current = await decide(data, row.id, 'receiver', 'resolve_not_sent', 'Payer confirmed it was never sent'); expect(current.status).toBe('rejected');
    expect((await progress(data)).expenses![0].reserved_amount).toBe('0');
    const eventId = require('node:crypto').randomUUID(), attempt = current.cash_legs[0].payment_attempt_id;
    expect(notificationHref({ payloadVersion: 2, eventId, eventKey: `payment_attempt.review_closed:${eventId}`,
      eventType: 'payment_attempt.review_closed', tripId: data.trip.id, sourceId: attempt, paymentAttemptId: attempt, target: 'settle_up' }))
      .toBe(`/trip/${data.trip.id}/settle-up?paymentAttemptId=${attempt}`);
  });
  test('runtime restart at create, start, report and approval recovers one effect without automatic launches', async () => {
    const data = fixture.cases.restart; actor('payer'); const initial = await progress(data);
    const share = initial.details![data.expenseId].participants[0];
    const quote = await createReviewedQuote(data.trip.id, { mode: 'direct', method: 'upi', expected_snapshot_id: initial.snapshot_id!,
      shares: [{ share_id: share.id, amount: '100' }], parties: [{ from_member_id: data.payerWallet, to_member_id: data.receiverWallet,
        payer_person_id: data.payerWallet, recipient_person_id: data.receiverWallet }] }, mockToken);
    const launchCount = (copyAndLaunchUpiApp as jest.Mock).mock.calls.length;
    let client: typeof import('../reviewedSettlement');
    const restart = () => { jest.isolateModules(() => { client = require('../reviewedSettlement'); }); };
    restart();
    const recoverLost = async (path: string, body: Record<string, unknown>, who: Actor, intentId: string) => {
      actor(who); loseResponseFor = `/api${path}`;
      const before = requests.filter(req => req.path === loseResponseFor && req.method === 'POST').length;
      await expect(client.reviewedMutation(scope(data, who), path, body, mockToken, () => true, intentId)).rejects.toMatchObject({ code: 'network' });
      restart(); await client.hydrateReviewedMutation(scope(data, who));
      expect(client.hasUnresolvedSubmission(scope(data, who))).toBe(true);
      const recovered = await client.retryReviewedMutation(scope(data, who), mockToken, () => true);
      expect(requests.filter(req => req.path === `/api${path}` && req.method === 'POST')).toHaveLength(before + 1);
      expect(client.hasUnresolvedSubmission(scope(data, who))).toBe(false);
      return recovered;
    };
    let row = await recoverLost(`/trips/${data.trip.id}/settlement-intents`, { quote_id: quote.id, quote_hash: quote.quote_hash,
      submission_action: 'propose' }, 'payer', quote.intent_id);
    const leg = row.cash_legs[0].id, path = `/trips/${data.trip.id}/settlement-intents/${row.id}/legs/${leg}/actions`;
    row = await recoverLost(path, { action: 'start', expected_intent_version: row.version, plan_hash: row.plan.plan_hash }, 'payer', row.id);
    row = await recoverLost(path, { action: 'report_paid', expected_intent_version: row.version, plan_hash: row.plan.plan_hash,
      transaction_reference: 'RESTART-REF' }, 'payer', row.id);
    row = await recoverLost(`/trips/${data.trip.id}/settlement-intents/${row.id}/approvals`, {
      action: 'confirm_received', leg_id: leg, expected_intent_version: row.version, plan_hash: row.plan.plan_hash }, 'receiver', row.id);
    expect(row.allocation_status).toBe('applied'); expect((await progress(data)).expenses![0].remaining_amount).toBe('0');
    expect(copyAndLaunchUpiApp).toHaveBeenCalledTimes(launchCount);
  });
  test('concurrent direct/group creates cannot reserve the same shares; winner applies exactly once', async () => {
    const data = fixture.cases.concurrent; actor('payer'); const initial = await progress(data), share = initial.details![data.expenseId].participants[0];
    const parties = [{ from_member_id: data.payerWallet, to_member_id: data.receiverWallet, payer_person_id: data.payerWallet, recipient_person_id: data.receiverWallet }];
    const quotes = await Promise.all([createReviewedQuote(data.trip.id, { mode: 'direct', method: 'cash', expected_snapshot_id: initial.snapshot_id!,
      shares: [{ share_id: share.id, amount: '100' }], parties }, mockToken), createReviewedQuote(data.trip.id, { mode: 'group', method: 'cash',
      expected_snapshot_id: initial.snapshot_id!, cash_legs: [{ from_member_id: data.payerWallet, to_member_id: data.receiverWallet, amount: '20' }], parties }, mockToken)]);
    const results = await Promise.allSettled(quotes.map(quote => api<ReviewedIntent>(`/trips/${data.trip.id}/settlement-intents`, { method: 'POST', authToken: mockToken,
      body: { quote_id: quote.id, quote_hash: quote.quote_hash, submission_action: 'report_paid', client_mutation_id: require('node:crypto').randomUUID() } })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const winner = (results.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<ReviewedIntent>).value;
    let received = await decide(data, winner.id, 'receiver', 'confirm_received');
    for (const person of received.plan.required_person_ids) received = await decide(data, received.id, person === data.payerWallet ? 'payer' : 'receiver', 'consent', '', person);
    expect(received.allocation_status).toBe('applied');
  });
  test('recipient change stops obsolete sending but preserves original evidence and exact reported money as credit', async () => {
    const data = fixture.cases.changed, row = await create(data, 'upi');
    actor('secondReceiver'); await api('/auth/me', { method: 'PATCH', authToken: mockToken, body: { upi_id: 'changed-receiver@upi' } });
    actor('payer'); let current = await detail(data, row.id);
    expect(current.status).toBe('canceled'); expect(current.reports![0].upi_id_snapshot).toBe('journey-secondReceiver@upi');
    await expect(api(`/trips/${data.trip.id}/settlement-intents/${row.id}/legs/${row.cash_legs[0].id}/actions`, { method: 'POST', authToken: mockToken,
      body: { action: 'start', expected_intent_version: current.version, plan_hash: current.plan.plan_hash, client_mutation_id: require('node:crypto').randomUUID() } }))
      .rejects.toMatchObject({ status: 409 });
    current = await reviewedMutation(scope(data, 'payer'), `/trips/${data.trip.id}/settlement-intents/${row.id}/legs/${row.cash_legs[0].id}/actions`, {
      action: 'report_paid', expected_intent_version: current.version, plan_hash: current.plan.plan_hash, transaction_reference: 'ORIGINAL-RECIPIENT' }, mockToken, () => true);
    current = await decide(data, row.id, 'secondReceiver', 'confirm_received'); expect(current.allocation_status).toBe('needs_review');
    const final = await progress(data); expect(final.expenses![0].remaining_amount).toBe('100');
    expect(final.unapplied_credit!.some(credit => credit.amount === '100')).toBe(true);
    expect((await detail(data, row.id)).reports![0].upi_id_snapshot).toBe('journey-secondReceiver@upi');
  });
  test('an open Settle Up hub converges after an external reviewer notification without offering covered cash again', async () => {
    const data = fixture.cases.refresh, row = await create(data, 'cash'); actor('payer');
    let tree!: ReactTestRenderer;
    await act(async () => { tree = Renderer.create(<Hub trip={data.trip} accountId={fixture.users.payer.id} sessionMode="online"
      isAdmin={false} expenseNames={{ [data.expenseId]: 'Dinner' }} focusAttemptId={row.cash_legs[0].payment_attempt_id}
      onChanged={() => {}} onAdminReview={() => {}} />); });
    await until(() => JSON.stringify(tree.toJSON()).includes('Awaiting approval'), 'current Settle Up report');
    const current = await detail(data, row.id);
    await api(`/trips/${data.trip.id}/settlement-intents/${row.id}/approvals`, { method: 'POST', authToken: fixture.users.receiver.token, body: {
      action: 'confirm_received', leg_id: row.cash_legs[0].id, expected_intent_version: current.version,
      plan_hash: current.plan.plan_hash, client_mutation_id: require('node:crypto').randomUUID() } });
    await act(async () => { publishFinancialChange({ accountId: fixture.users.payer.id, tripId: data.trip.id, reason: 'notification' }); });
    await until(() => JSON.stringify(tree.toJSON()).includes('Approved coverage and history'), 'refreshed coverage and history');
    expect(tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === `reviewed-group-${data.payerWallet}-${data.receiverWallet}`)).toHaveLength(0);
    expect((await progress(data)).expenses![0].remaining_amount).toBe('0');
    await act(async () => tree.unmount());
  });
  test('dependent bundle posts each receipt once and waits for every receipt and person allocation', async () => {
    const data = fixture.cases.dependent;
    let row = await create(data, 'cash', 'group', '50'); expect(row.cash_legs).toHaveLength(2);
    const personActor = (person: string): Actor => Object.keys(fixture.users).find(key => fixture.users[key as Actor].id
      === data.trip.members.find(wallet => wallet.id === person)!.user_id) as Actor;
    for (const leg of row.cash_legs) {
      if (leg.receipt_status === 'initiated') {
        const who = personActor(leg.actual_payer_person_id); actor(who);
        row = await reviewedMutation(scope(data, who), `/trips/${data.trip.id}/settlement-intents/${row.id}/legs/${leg.id}/actions`, {
          action: 'report_paid', expected_intent_version: row.version, plan_hash: row.plan.plan_hash }, mockToken, () => true);
      }
      const receiver = personActor(leg.actual_receiver_person_id);
      row = await decide(data, row.id, receiver, 'confirm_received', '', undefined, leg.id);
      // An additional authorized receipt decision cannot post the same money twice.
      row = await decide(data, row.id, receiver, 'confirm_received', '', undefined, leg.id);
      expect(row.allocation_status).not.toBe('applied');
      expect((await progress(data)).expenses!.every(bill => bill.remaining_amount === '100')).toBe(true);
    }
    for (const person of row.plan.required_person_ids) row = await decide(data, row.id, personActor(person), 'consent', '', person);
    expect(row.allocation_status).toBe('applied');
    expect((await progress(data)).expenses!.map(bill => bill.remaining_amount).sort()).toEqual(['50', '50']);
  });
  test('one family payer covers siblings; zero-rounded shares need no cash; refund direction and reviewer remain correct', async () => {
    const data = fixture.cases.family; actor('payer'); const initial = await progress(data);
    const family = data.trip.members.find(wallet => wallet.kind === 'family')!;
    const shares = initial.details![data.expenseId].participants.filter(row => row.wallet_id === family.id);
    expect(shares.map(row => row.original_share)).toEqual(['67', '67']);
    const zero = initial.expenses!.find(bill => bill.expense_id !== data.expenseId && initial.details![bill.expense_id].participants.some(row => row.original_share === '0'))!;
    const zeroRows = initial.details![zero.expense_id].participants;
    expect(zeroRows.filter(share => share.original_share === '0').every(share => share.remaining_amount === '0')).toBe(true);
    const extra = zeroRows.filter(share => share.wallet_id === family.id && Number(share.known_uncovered_amount) > 0);
    const selections = [...shares.map(share => ({ share_id: share.id, amount: '67' })), ...extra.map(share => ({ share_id: share.id, amount: share.known_uncovered_amount }))];
    const row = await create(data, 'cash', 'direct', String(134 + extra.reduce((sum, share) => sum + Number(share.known_uncovered_amount), 0)), 'payer', { mode: 'direct', fromWallet: family.id, toWallet: data.receiverWallet,
      shares: selections });
    expect(row.cash_legs[0].actual_payer_person_id).toBe(family.family_member_ids![0]);
    expect(row.plan.allocation_lines).toHaveLength(selections.length); await decide(data, row.id, 'receiver', 'confirm_received');
    actor('receiver'); const current = await progress(data);
    const refund = Object.values(current.details!).find(bill => bill.participants.some(person => person.original_share === '-50'))!;
    const refundRow = await create(data, 'cash', 'direct', '100', 'receiver', { mode: 'direct', fromWallet: data.receiverWallet, toWallet: family.id,
      recipientPerson: family.family_member_ids![1], shares: refund.participants.map(share => ({ share_id: share.id, amount: '50' })) });
    expect(refundRow.cash_legs[0].actual_receiver_person_id).toBe(family.family_member_ids![1]);
    await decide(data, refundRow.id, 'secondPayer', 'confirm_received');
    expect((await progress(data)).expenses!.every(bill => bill.remaining_amount === '0' && bill.settled_count === bill.participant_count)).toBe(true);
  });
  test('unavailable approver cannot be impersonated; authorized admin sees the missing account and uses a reason', async () => {
    const data = fixture.cases.unavailable, row = await create(data, 'offset', 'offset');
    await expect(decide(data, row.id, 'receiver', 'consent', '', data.receiverWallet)).rejects.toMatchObject({ status: 403 });
    const reviewer = await panel(data, row.id, 'admin');
    expect(JSON.stringify(reviewer.tree.toJSON())).toContain('no current linked account');
    await act(async () => reviewer.tree.unmount());
    const applied = await decide(data, row.id, 'admin', 'admin_override', 'Agreement obtained from the unlinked person');
    expect(applied.allocation_status).toBe('applied');
  });
  test('financial correction makes prior offset consent stale and preserves the original frozen review', async () => {
    const data = fixture.cases.stale, row = await create(data, 'offset', 'offset');
    await decide(data, row.id, 'payer', 'consent', '', data.payerWallet);
    actor('admin'); const current = await progress(data);
    const preview = await api<{ id: string; preview_hash: string }>(`/trips/${data.trip.id}/correction-previews`, { method: 'POST', authToken: mockToken,
      body: { operation: 'replace_expense', target_id: data.expenseId, changes: { amount: '80' }, reason: 'Correct the original dinner amount', expected_snapshot_id: current.snapshot_id } });
    const correction = await api<{ status: string }>(`/trips/${data.trip.id}/corrections`, { method: 'POST', authToken: mockToken,
      body: { protocol_version: 2, preview_id: preview.id, preview_hash: preview.preview_hash, client_mutation_id: require('node:crypto').randomUUID() } });
    expect(correction.status).toBe('applied');
    const original = await detail(data, row.id);
    expect(original.status).toBe('canceled');
    expect(original.allocation_status).not.toBe('applied');
    await expect(decide(data, row.id, 'receiver', 'consent', '', data.receiverWallet))
      .rejects.toMatchObject({ status: 409, detailCode: 'invalid_transition' });
    expect(original.review_context!.some(line => line.original_share === '100')).toBe(true);
    expect((await progress(data)).expenses!.find(bill => bill.expense_id === data.expenseId)!.remaining_amount).toBe('80');
  });
  test('three-day pending reports survive expiry; expired starts retain late reporting and exact confirmed credit', async () => {
    const data = fixture.cases.oldReport; actor('payer'); const pending = await detail(data, data.seededIntentId!);
    expect(pending.cash_legs[0].receipt_status).toBe('awaiting_review');
    expect((await progress(data)).expenses![0].reserved_amount).toBe('100');
    expect((await decide(data, pending.id, 'receiver', 'confirm_received')).allocation_status).toBe('applied');
    const late = fixture.cases.late; actor('payer'); let row = await detail(late, late.seededIntentId!);
    expect(row.status).toBe('expired');
    const oldAddress = row.reports![0].upi_id_snapshot;
    row = await reviewedMutation(scope(late, 'payer'), `/trips/${late.trip.id}/settlement-intents/${row.id}/legs/${row.cash_legs[0].id}/actions`, {
      action: 'report_paid', expected_intent_version: row.version, plan_hash: row.plan.plan_hash, transaction_reference: 'LATE-ORIGINAL' }, mockToken, () => true);
    expect(row.status).toBe('needs_review'); row = await decide(late, row.id, 'receiver', 'confirm_received');
    expect(row.allocation_status).toBe('needs_review');
    const final = await progress(late); expect(final.expenses![0].remaining_amount).toBe('100'); expect(final.unapplied_credit![0].amount).toBe('100');
    expect((await detail(late, row.id)).reports![0].upi_id_snapshot).toBe(oldAddress);
  });
  test('real saved progress remains readable offline; writes and cached work stay account scoped', async () => {
    const data = fixture.cases.refresh; actor('payer');
    const before = requests.length; let tree!: ReactTestRenderer;
    const props = { trip: data.trip, accountId: fixture.users.payer.id, sessionMode: 'offline', isAdmin: false,
      expenseNames: { [data.expenseId]: 'Dinner' }, onChanged: () => {}, onAdminReview: () => {} };
    await act(async () => { tree = Renderer.create(<Hub {...props} />); });
    await until(() => JSON.stringify(tree.toJSON()).includes('Saved progress'), 'offline saved progress');
    expect(JSON.stringify(tree.toJSON())).toContain('last confirmed'); expect(requests).toHaveLength(before);
    expect(tree.root.findAll(node => typeof node.type === 'string' && node.props.testID?.startsWith('settlement-confirm-'))).toHaveLength(0);
    await act(async () => { tree.update(<Hub {...props} accountId={fixture.users.receiver.id} />); });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
    expect(JSON.stringify(tree.toJSON())).not.toContain('Saved progress'); expect(requests).toHaveLength(before);
    await act(async () => tree.unmount());
  });
});
