import { Platform } from 'react-native';
import { getStoredToken, setStoredToken } from './tokenStorage';
import type { SpendSummary } from './spend';
import type {
  Payment,
  PaymentAttempt,
  PaymentAttemptCreate,
  PaymentAttemptRecipientAction,
  PaymentAttemptSenderAction,
  PaymentHandoffPreview,
  PaymentHandoffPreviewRequest,
  PaymentRecipientDetails,
} from './payments';
import type { ChatMessage, ChatPage, ChatUnread } from './chat';
import type { JoinCredential, JoinRequestView } from './joinIdentity';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL?.trim().replace(/\/$/, '');
const unauthorizedListeners = new Set<(token: string) => void>();

export function subscribeUnauthorized(listener: (token: string) => void): () => void {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}

export type ApiErrorCode = 'configuration' | 'network' | 'timeout' | 'aborted' | 'http';

export type TripInviteLink = { url: string };
export type PublicTripInvite = {
  status: 'active';
  trip_name: string;
};

export type TripDeletionAction = 'keep' | 'leave' | 'dissolve_family';

export type DepartureBlocker = {
  code: string;
  message: string;
  resolution: 'settle_up' | 'resolve_payment' | 'delete_trip_first' | 'review_membership'
    | 'keep_family' | 'none' | string;
  actions: string[];
};

export type DepartureIdentity = {
  type: 'individual' | 'family_member';
  member_id: string;
  member_name: string;
  family_id?: string | null;
  family_name?: string | null;
  family_member_id?: string | null;
};

export type OwnershipOutcome = {
  is_owner: boolean;
  transfer_required: boolean;
  successor: { user_id: string; name: string } | null;
  requires_trip_deletion: boolean;
};

export type TripDeletionImpact = {
  trip_id: string;
  trip_name: string;
  currency: string;
  identity: DepartureIdentity | null;
  position: string | null;
  family_position: string | null;
  unsettled_family_members: { id: string; name: string; position: string }[];
  settled: boolean;
  leave_eligible: boolean;
  dissolve_family_eligible: boolean;
  requires_family_dissolution: boolean;
  available_actions: TripDeletionAction[];
  default_action: 'keep';
  active_payment_blocker: boolean;
  ownership: OwnershipOutcome;
  blockers: DepartureBlocker[];
};

export type AccountDeletionImpact = {
  account_deletion_allowed: boolean;
  blockers: DepartureBlocker[];
  trips: TripDeletionImpact[];
  defaults: { trip_action: 'keep' };
  privacy: { deleted: string[]; retained: string[] };
};

export type AdminTripSummary = {
  id: string;
  name: string;
  code?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  travel_date?: string | null;
  currency: string;
  budget?: number | null;
  created_at: string;
  owner?: { id?: string | null; name?: string | null; email?: string | null } | null;
  member_count: number;
  expense_count: number;
  net_spend: number;
};

export type AdminAuditEvent = {
  id: string;
  actor_user_id: string;
  actor_email: string;
  action: string;
  trip_id?: string | null;
  trip_name?: string | null;
  resource_type: string;
  resource_id?: string | null;
  changed_fields: string[];
  created_at: string;
};

export type MoneyAuditRecord = {
  id: string;
  record_type: 'normalization' | 'migration' | 'adjustment';
  trip_id?: string | null;
  trip_name?: string | null;
  currency?: string | null;
  policy_version: string;
  created_at: string;
  mode?: 'apply' | 'revert';
  resource_type?: string;
  resource_id?: string | null;
  source?: string;
  changes?: {
    collection?: string;
    document_id?: string;
    field: string;
    before: unknown;
    after: unknown;
  }[];
  vector?: Record<string, number | string>;
  adjustment_vector?: Record<string, number | string>;
};

export type AdminPage<T> = {
  items: T[];
  total: number;
  next_cursor: string | null;
};

export class ApiError extends Error {
  status?: number;
  data?: unknown;
  code: ApiErrorCode;
  detailCode?: string;
  retryable?: boolean;
  retryAfterMs?: number;

  constructor(message: string, options: {
    status?: number; data?: unknown; code: ApiErrorCode; detailCode?: string;
    retryable?: boolean; retryAfterMs?: number;
  }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.data = options.data;
    this.code = options.code;
    this.detailCode = options.detailCode;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

type ApiOptions = {
  method?: string;
  body?: any;
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  // The sync worker binds one request to the token whose claims match its outbox account.
  authToken?: string;
  suppressUnauthorized?: boolean;
};

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

function backendBase(): string {
  if (!BASE) {
    throw new ApiError('The backend URL is not configured', { code: 'configuration' });
  }
  if (!__DEV__ && !/^https:\/\//i.test(BASE)) {
    throw new ApiError('Release builds require an HTTPS backend URL', { code: 'configuration' });
  }
  return BASE;
}

export async function getToken(): Promise<string | null> {
  return getStoredToken();
}

export async function setToken(t: string | null) {
  await setStoredToken(t);
}

function formatDetail(d: any): string {
  if (d == null) return 'Something went wrong';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map((e) => (e?.msg ? e.msg : JSON.stringify(e))).join(' ');
  if (d?.message) return d.message;
  if (d?.msg) return d.msg;
  return JSON.stringify(d);
}

export async function api<T = any>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const { method = 'GET', body, auth = true, timeoutMs, signal } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let requestToken: string | null = null;
  if (auth) {
    requestToken = opts.authToken ?? await getToken();
    if (requestToken) headers['Authorization'] = `Bearer ${requestToken}`;
  }
  const base = backendBase();
  const controller = timeoutMs ? new AbortController() : null;
  const abortFromCaller = () => controller?.abort();
  if (controller && signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortFromCaller, { once: true });
  }
  const timeout = timeoutMs
    ? setTimeout(() => controller?.abort(), timeoutMs)
    : null;
  let res: Response;
  let responseText: string;
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal ?? signal,
    });
    responseText = await res.text();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (signal?.aborted) {
        throw new ApiError('The request was cancelled', { code: 'aborted' });
      }
      throw new ApiError('The request timed out', { code: 'timeout' });
    }
    throw new ApiError('Could not reach the server', { code: 'network' });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (controller && signal) signal.removeEventListener('abort', abortFromCaller);
  }
  let data: any = null;
  try { data = responseText ? JSON.parse(responseText) : null; } catch { data = responseText; }
  if (!res.ok) {
    if (res.status === 401 && requestToken && path !== '/auth/me' && !opts.suppressUnauthorized) {
      for (const listener of unauthorizedListeners) {
        try { listener(requestToken); } catch { /* Preserve the original HTTP error. */ }
      }
    }
    const msg = formatDetail(data?.detail ?? data);
    const detail = data?.detail;
    throw new ApiError(msg, {
      status: res.status,
      data,
      code: 'http',
      detailCode: typeof detail === 'object' ? detail?.code : undefined,
      retryable: typeof detail === 'object' ? detail?.retryable : undefined,
      retryAfterMs: res.status === 429 ? retryAfterMs(res.headers.get('Retry-After')) : undefined,
    });
  }
  return data as T;
}

export type ExchangeRateMode = 'automatic' | 'manual';
export type ManualExchangeInput = 'rate' | 'target_amount';

export type ExchangeRateQuote = {
  quote_id: string;
  mode: ExchangeRateMode;
  source_amount: string;
  source_currency: string;
  target_amount: string;
  target_currency: string;
  rate: string;
  requested_date: string | null;
  effective_rate_date: string | null;
  provider: string;
  provider_sources: { key: string; date?: string | null; rate: string }[];
  cache_hit: boolean;
  stale: boolean;
  manual: boolean;
  manual_input_type?: ManualExchangeInput | null;
  manual_input_value?: string | null;
  requires_confirmation: boolean;
  expires_at: string;
};

export type ExchangeRateQuoteParams = {
  from: string;
  to: string;
  amount: string | number;
  date?: string | null;
  mode?: ExchangeRateMode;
  manualInputType?: ManualExchangeInput | null;
  manualRate?: string | number | null;
  manualTargetAmount?: string | number | null;
  refresh?: boolean;
};

export type ExpenseConversionRequest = {
  mode: ExchangeRateMode;
  quote_id: string;
  approved: true;
  allow_stale: boolean;
  manual_input_type?: ManualExchangeInput;
  manual_rate?: string;
  manual_target_amount?: string;
};

export function quoteExchangeRate(
  params: ExchangeRateQuoteParams,
  signal?: AbortSignal,
): Promise<ExchangeRateQuote> {
  const query = new URLSearchParams({
    from: params.from,
    to: params.to,
    amount: String(params.amount),
    mode: params.mode ?? 'automatic',
  });
  if (params.date) query.set('date', params.date);
  if (params.manualInputType) query.set('manual_input_type', params.manualInputType);
  if (params.manualRate != null) query.set('manual_rate', String(params.manualRate));
  if (params.manualTargetAmount != null) {
    query.set('manual_target_amount', String(params.manualTargetAmount));
  }
  if (params.refresh) query.set('refresh', 'true');
  return api<ExchangeRateQuote>(`/exchange-rates/quote?${query.toString()}`, {
    signal,
    timeoutMs: 12_000,
  });
}

export function getExpense<T = any>(tripId: string, expenseId: string): Promise<T> {
  return api<T>(`/trips/${tripId}/expenses/${expenseId}`);
}

export function listAdminTrips(options: {
  query?: string;
  cursor?: string | null;
  limit?: number;
} = {}): Promise<AdminPage<AdminTripSummary>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 25) });
  if (options.query?.trim()) query.set('query', options.query.trim());
  if (options.cursor) query.set('cursor', options.cursor);
  return api<AdminPage<AdminTripSummary>>(`/admin/trips?${query.toString()}`);
}

export function listAdminActivity(options: {
  cursor?: string | null;
  limit?: number;
  tripId?: string;
  action?: string;
} = {}): Promise<AdminPage<AdminAuditEvent>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.tripId) query.set('trip_id', options.tripId);
  if (options.action) query.set('action', options.action);
  return api<AdminPage<AdminAuditEvent>>(`/admin/audit?${query.toString()}`);
}

export function listAdminMoneyAudit(options: {
  cursor?: string | null;
  limit?: number;
  tripId?: string;
  recordType?: MoneyAuditRecord['record_type'];
} = {}): Promise<AdminPage<MoneyAuditRecord>> {
  const query = new URLSearchParams({ limit: String(options.limit ?? 50) });
  if (options.cursor) query.set('cursor', options.cursor);
  if (options.tripId) query.set('trip_id', options.tripId);
  if (options.recordType) query.set('record_type', options.recordType);
  return api<AdminPage<MoneyAuditRecord>>(`/admin/money-audit?${query.toString()}`);
}

export function reconvertExpense<T = any>(
  tripId: string,
  expenseId: string,
  body: {
    quote_id: string;
    expected_conversion_version: number;
    approved: boolean;
    allow_stale?: boolean;
    force?: boolean;
  },
): Promise<T> {
  return api<T>(`/trips/${tripId}/expenses/${expenseId}/reconvert`, { method: 'POST', body });
}

// Phase 11 — thin wrappers over api() for the join-identity flow. previewJoin returns the
// match/families context; joinTrip posts the discriminated commit (legacy {mode} OR Phase 11
// {action:'claim'|'join_new'}). Callers build the body via src/joinIdentity.ts.
export function previewJoin<T = any>(credential: string | JoinCredential): Promise<T> {
  const body = typeof credential === 'string' ? { code: credential } : credential;
  return api<T>('/trips/join/preview', { method: 'POST', body });
}

export function joinTrip<T = any>(body: Record<string, unknown>): Promise<T> {
  return api<T>('/trips/join', { method: 'POST', body });
}

export function getAccountDeletionImpact(): Promise<AccountDeletionImpact> {
  return api<AccountDeletionImpact>('/auth/me/deletion-impact');
}

export function deleteAccount(body: {
  confirmation: 'DELETE';
  acknowledge_unsettled: boolean;
  trip_actions: { trip_id: string; action: TripDeletionAction }[];
}): Promise<{ ok: true; kept_trip_ids: string[]; departed_trip_ids: string[] }> {
  return api('/auth/me', { method: 'DELETE', body });
}

export function getMembershipLeaveImpact(tripId: string): Promise<TripDeletionImpact> {
  return api<TripDeletionImpact>(
    `/trips/${encodeURIComponent(tripId)}/membership/leave-impact`,
  );
}

export function leaveTripMembership(
  tripId: string,
  dissolveFamily: boolean,
): Promise<{ ok: true; trip_id: string; action: 'leave' | 'dissolve_family' }> {
  return api(`/trips/${encodeURIComponent(tripId)}/membership`, {
    method: 'DELETE', body: { dissolve_family: dissolveFamily },
  });
}

export function requestExistingPerson(body: Record<string, unknown>): Promise<JoinRequestView> {
  return api<JoinRequestView>('/trips/join-requests', { method: 'POST', body });
}

export function getTripInviteLink(tripId: string): Promise<TripInviteLink> {
  return api<TripInviteLink>(`/trips/${encodeURIComponent(tripId)}/invite-link`);
}

export function resetTripInviteLink(tripId: string): Promise<TripInviteLink> {
  return api<TripInviteLink>(
    `/trips/${encodeURIComponent(tripId)}/invite-link/reset`,
    { method: 'POST' },
  );
}

export function getPublicTripInvite(token: string): Promise<PublicTripInvite> {
  return api<PublicTripInvite>(`/invites/${encodeURIComponent(token)}`, { auth: false });
}

export function getJoinRequest(requestId: string): Promise<JoinRequestView> {
  return api<JoinRequestView>(`/trips/join-requests/${encodeURIComponent(requestId)}`);
}

export function cancelJoinRequest(requestId: string): Promise<JoinRequestView> {
  return api<JoinRequestView>(`/trips/join-requests/${encodeURIComponent(requestId)}`, {
    method: 'DELETE',
  });
}

export function listJoinRequests(tripId: string): Promise<JoinRequestView[]> {
  return api<JoinRequestView[]>(`/trips/${encodeURIComponent(tripId)}/join-requests?status=pending`);
}

export function approveJoinRequest(tripId: string, requestId: string): Promise<JoinRequestView> {
  return api<JoinRequestView>(
    `/trips/${encodeURIComponent(tripId)}/join-requests/${encodeURIComponent(requestId)}/approve`,
    { method: 'POST' },
  );
}

export function rejectJoinRequest(
  tripId: string,
  requestId: string,
  reason?: string,
): Promise<JoinRequestView> {
  return api<JoinRequestView>(
    `/trips/${encodeURIComponent(tripId)}/join-requests/${encodeURIComponent(requestId)}/reject`,
    { method: 'POST', body: { reason: reason?.trim() || null } },
  );
}

// Phase 12 — read-only gross-spend ranking for a trip (GET /trips/{id}/spend-summary).
export function spendSummary(tripId: string): Promise<SpendSummary> {
  return api<SpendSummary>(`/trips/${tripId}/spend-summary`);
}

// Phase 20 — partial payments along suggested settle-up pairs (db.payments).
export function listPayments(tripId: string): Promise<Payment[]> {
  return api<Payment[]>(`/trips/${tripId}/payments`);
}
export function getPaymentRecipientDetails(
  tripId: string,
  fromMemberId: string,
  toMemberId: string,
): Promise<PaymentRecipientDetails> {
  const query = `from_member_id=${encodeURIComponent(fromMemberId)}`
    + `&to_member_id=${encodeURIComponent(toMemberId)}`;
  return api<PaymentRecipientDetails>(
    `/trips/${encodeURIComponent(tripId)}/payment-recipient-details?${query}`,
  );
}
export function previewPaymentHandoff(
  tripId: string,
  body: PaymentHandoffPreviewRequest,
): Promise<PaymentHandoffPreview> {
  return api<PaymentHandoffPreview>(
    `/trips/${encodeURIComponent(tripId)}/payment-handoff/preview`,
    { method: 'POST', body, timeoutMs: 12_000 },
  );
}
export function createPaymentAttempt(
  tripId: string,
  body: PaymentAttemptCreate,
): Promise<PaymentAttempt> {
  return api<PaymentAttempt>(`/trips/${encodeURIComponent(tripId)}/payment-attempts`, {
    method: 'POST', body,
  });
}
export function listPaymentAttempts(tripId: string): Promise<PaymentAttempt[]> {
  return api<PaymentAttempt[]>(`/trips/${encodeURIComponent(tripId)}/payment-attempts`, {
    timeoutMs: 10_000,
  });
}
export function updatePaymentAttemptSender(
  tripId: string,
  attemptId: string,
  action: PaymentAttemptSenderAction,
  transactionReference?: string | null,
): Promise<PaymentAttempt> {
  return api<PaymentAttempt>(
    `/trips/${encodeURIComponent(tripId)}/payment-attempts/${encodeURIComponent(attemptId)}/sender`,
    {
      method: 'PATCH',
      body: {
        action,
        ...(action === 'report_paid' ? { transaction_reference: transactionReference ?? null } : {}),
      },
    },
  );
}
export function updatePaymentAttemptRecipient(
  tripId: string,
  attemptId: string,
  action: PaymentAttemptRecipientAction,
): Promise<PaymentAttempt> {
  return api<PaymentAttempt>(
    `/trips/${encodeURIComponent(tripId)}/payment-attempts/${encodeURIComponent(attemptId)}/recipient`,
    { method: 'PATCH', body: { action } },
  );
}
export function recordPayment(
  tripId: string,
  body: { from_member_id: string; to_member_id: string; amount: number; note?: string },
): Promise<Payment> {
  return api<Payment>(`/trips/${tripId}/payments`, { method: 'POST', body });
}
export function editPayment(
  tripId: string,
  paymentId: string,
  body: { amount?: number; note?: string },
): Promise<Payment> {
  return api<Payment>(`/trips/${tripId}/payments/${paymentId}`, { method: 'PATCH', body });
}
export function deletePayment(tripId: string, paymentId: string): Promise<void> {
  return api(`/trips/${tripId}/payments/${paymentId}`, { method: 'DELETE' }).then(() => undefined);
}

export function xlsxUrl(tripId: string, token: string) {
  return `${BASE}/api/trips/${tripId}/report.xlsx?token=${encodeURIComponent(token)}`;
}

// Phase 18 — parallel PDF report (GET /trips/{id}/report.pdf). Same ?token= auth as xlsxUrl since
// it's opened via a browser link (the JWT can't ride an Authorization header on a plain link).
export function pdfUrl(tripId: string, token: string) {
  return `${BASE}/api/trips/${tripId}/report.pdf?token=${encodeURIComponent(token)}`;
}

// Step 22: a streamed receipt URL for <Image source={{ uri }}> / browser links. Auth rides on
// the ?token= query (RN <Image> can't set an Authorization header), mirroring xlsxUrl.
export function receiptUrl(tripId: string, expenseId: string, token: string) {
  return `${BASE}/api/trips/${tripId}/expenses/${expenseId}/receipt?token=${encodeURIComponent(token)}`;
}

// Step 22: upload a bill image to GridFS via multipart. Pass the picked asset's local uri +
// mimeType; we must NOT set Content-Type so React Native generates the multipart boundary.
export async function uploadReceipt(
  tripId: string,
  expenseId: string,
  asset: { uri: string; mimeType?: string; fileName?: string }
): Promise<{ receipt_id: string }> {
  const mime = asset.mimeType || 'image/jpeg';
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const name = asset.fileName || `receipt.${ext}`;
  const form = new FormData();
  if (Platform.OS === 'web') {
    // In a browser, FormData.append coerces a plain {uri,name,type} object to the string
    // "[object Object]" — FastAPI then rejects it (422). Fetch the picked uri (data:/blob:)
    // into a real Blob so the part is a genuine file; guarantee an allowed Content-Type.
    const r = await fetch(asset.uri);
    let blob = await r.blob();
    if (!blob.type) blob = new Blob([blob], { type: mime });
    form.append('file', blob, name);
  } else {
    // On native, RN's FormData understands this shape and computes the multipart boundary.
    form.append('file', { uri: asset.uri, name, type: mime } as any);
  }

  const t = await getToken();
  const res = await fetch(`${BASE}/api/trips/${tripId}/expenses/${expenseId}/receipt`, {
    method: 'POST',
    headers: t ? { Authorization: `Bearer ${t}` } : {},
    body: form,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const err: any = new Error(formatDetail(data?.detail ?? data));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as { receipt_id: string };
}

// Step 22: detach the receipt from an expense (deletes the GridFS file). Idempotent server-side.
export async function deleteReceipt(tripId: string, expenseId: string): Promise<void> {
  await api(`/trips/${tripId}/expenses/${expenseId}/receipt`, { method: 'DELETE' });
}

// Per-trip durable chat. REST owns persistence; WebSocket only announces committed mutations.
export function listChatMessages(
  tripId: string,
  options: { beforeSequence?: number; afterSequence?: number; limit?: number } = {},
): Promise<ChatPage> {
  const query = new URLSearchParams();
  if (options.beforeSequence != null) query.set('before_sequence', String(options.beforeSequence));
  if (options.afterSequence != null) query.set('after_sequence', String(options.afterSequence));
  if (options.limit != null) query.set('limit', String(options.limit));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return api<ChatPage>(`/trips/${tripId}/chat/messages${suffix}`);
}

export function sendChatMessage(
  tripId: string,
  body: { client_message_id: string; text: string },
): Promise<ChatMessage> {
  return api<ChatMessage>(`/trips/${tripId}/chat/messages`, {
    method: 'POST', body, timeoutMs: 15_000,
  });
}

export function editChatMessage(tripId: string, messageId: string, text: string): Promise<ChatMessage> {
  return api<ChatMessage>(`/trips/${tripId}/chat/messages/${messageId}`, {
    method: 'PATCH', body: { text },
  });
}

export function deleteChatMessage(tripId: string, messageId: string): Promise<ChatMessage> {
  return api<ChatMessage>(`/trips/${tripId}/chat/messages/${messageId}`, { method: 'DELETE' });
}

export function chatUnread(tripId: string): Promise<ChatUnread> {
  return api<ChatUnread>(`/trips/${tripId}/chat/unread`);
}

export function markChatRead(tripId: string, throughSequence: number): Promise<void> {
  return api(`/trips/${tripId}/chat/read`, {
    method: 'PUT', body: { through_sequence: throughSequence },
  }).then(() => undefined);
}

export function clearChatHistory(tripId: string): Promise<{ ok: boolean; cleared_through_sequence: number }> {
  return api(`/trips/${tripId}/chat/history`, { method: 'DELETE' });
}

export function chatSocketUrl(tripId: string): string {
  const websocketBase = backendBase().replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${websocketBase}/api/trips/${encodeURIComponent(tripId)}/chat/ws`;
}
