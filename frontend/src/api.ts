import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { SpendSummary } from './spend';
import type { Payment } from './payments';
import type { ChatMessage, ChatPage, ChatUnread } from './chat';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL?.trim().replace(/\/$/, '');
const TOKEN_KEY = 'auth_token';

export type ApiErrorCode = 'configuration' | 'network' | 'timeout' | 'aborted' | 'http';

export class ApiError extends Error {
  status?: number;
  data?: unknown;
  code: ApiErrorCode;
  detailCode?: string;
  retryable?: boolean;

  constructor(message: string, options: {
    status?: number; data?: unknown; code: ApiErrorCode; detailCode?: string; retryable?: boolean;
  }) {
    super(message);
    this.name = 'ApiError';
    this.status = options.status;
    this.data = options.data;
    this.code = options.code;
    this.detailCode = options.detailCode;
    this.retryable = options.retryable;
  }
}

type ApiOptions = {
  method?: string;
  body?: any;
  auth?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
};

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
  return AsyncStorage.getItem(TOKEN_KEY);
}

export async function setToken(t: string | null) {
  if (t) await AsyncStorage.setItem(TOKEN_KEY, t);
  else await AsyncStorage.removeItem(TOKEN_KEY);
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
  if (auth) {
    const t = await getToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
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
  try {
    res = await fetch(`${base}/api${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller?.signal ?? signal,
    });
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
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = formatDetail(data?.detail ?? data);
    const detail = data?.detail;
    throw new ApiError(msg, {
      status: res.status,
      data,
      code: 'http',
      detailCode: typeof detail === 'object' ? detail?.code : undefined,
      retryable: typeof detail === 'object' ? detail?.retryable : undefined,
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
export function previewJoin<T = any>(code: string): Promise<T> {
  return api<T>('/trips/join/preview', { method: 'POST', body: { code } });
}

export function joinTrip<T = any>(body: Record<string, unknown>): Promise<T> {
  return api<T>('/trips/join', { method: 'POST', body });
}

// Phase 12 — read-only gross-spend ranking for a trip (GET /trips/{id}/spend-summary).
export function spendSummary(tripId: string): Promise<SpendSummary> {
  return api<SpendSummary>(`/trips/${tripId}/spend-summary`);
}

// Phase 20 — partial payments along suggested settle-up pairs (db.payments).
export function listPayments(tripId: string): Promise<Payment[]> {
  return api<Payment[]>(`/trips/${tripId}/payments`);
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
