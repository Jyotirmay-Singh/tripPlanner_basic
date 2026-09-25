import { offlineAccessAllowed, sessionClaims } from '../sessionClaims';

function token(userId: string, expiresAt: number): string {
  return `header.${Buffer.from(JSON.stringify({ sub: userId, exp: Math.floor(expiresAt / 1000) }))
    .toString('base64url')}.signature`;
}

it('uses the signed-in token expiry as the offline access ceiling', () => {
  const now = Date.now();
  const claims = sessionClaims(token('account-a', now + 1000));
  expect(claims?.userId).toBe('account-a');
  expect(offlineAccessAllowed(claims, now, now)).toBe(true);
  expect(offlineAccessAllowed(claims, now, now + 2000)).toBe(false);
});

it('limits access to 30 days and rejects a clock rollback', () => {
  const verifiedAt = 1_000_000_000_000;
  const claims = sessionClaims(token('account-a', verifiedAt + 40 * 86_400_000));
  expect(offlineAccessAllowed(claims, verifiedAt, verifiedAt + 29 * 86_400_000)).toBe(true);
  expect(offlineAccessAllowed(claims, verifiedAt, verifiedAt + 30 * 86_400_000)).toBe(false);
  expect(offlineAccessAllowed(claims, verifiedAt, verifiedAt - 1)).toBe(false);
  expect(sessionClaims('invalid')).toBeNull();
});
