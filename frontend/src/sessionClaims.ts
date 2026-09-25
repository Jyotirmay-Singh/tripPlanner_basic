export type SessionClaims = { userId: string; expiresAt: number };

// These claims select a previously server-verified local profile. They are not an authorization
// decision; the server still validates the JWT on every online request.
export function sessionClaims(token: string): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    let bits = 0;
    let count = 0;
    let decoded = '';
    for (const character of encoded) {
      const value = alphabet.indexOf(character);
      if (value < 0) return null;
      bits = (bits << 6) | value;
      count += 6;
      if (count >= 8) {
        count -= 8;
        decoded += String.fromCharCode((bits >> count) & 0xff);
      }
    }
    const payload: unknown = JSON.parse(decoded);
    if (!payload || typeof payload !== 'object') return null;
    const { sub, exp } = payload as { sub?: unknown; exp?: unknown };
    if (typeof sub !== 'string' || !sub || typeof exp !== 'number' || !Number.isFinite(exp)) {
      return null;
    }
    return { userId: sub, expiresAt: exp * 1000 };
  } catch {
    return null;
  }
}

export function offlineAccessAllowed(
  claims: SessionClaims | null,
  verifiedAt: number,
  now: number = Date.now(),
): boolean {
  return !!claims && verifiedAt > 0 && now >= verifiedAt && now < claims.expiresAt
    && now - verifiedAt < 30 * 24 * 60 * 60 * 1000;
}
