import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import type { SpendSummary } from './spend';

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL;
const TOKEN_KEY = 'auth_token';

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
  if (d?.msg) return d.msg;
  return JSON.stringify(d);
}

export async function api<T = any>(
  path: string,
  opts: { method?: string; body?: any; auth?: boolean } = {}
): Promise<T> {
  const { method = 'GET', body, auth = true } = opts;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const t = await getToken();
    if (t) headers['Authorization'] = `Bearer ${t}`;
  }
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = formatDetail(data?.detail ?? data);
    const err: any = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data as T;
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
