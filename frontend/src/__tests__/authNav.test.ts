import {
  authRedirectTarget,
  isPublicTokenRoute,
  AUTH_LOGIN_HREF,
  DASHBOARD_HREF,
  PASSWORD_SETUP_HREF,
} from '../authNav';

const user = { id: 'u1', email: 'a@gmail.com', name: 'A', role: 'user' } as any;

// The 2-arg contract is exercised in logout.test.ts; here we cover the Phase 9 additions:
// the optional `isPublicRoute` short-circuit and the route-name helper.

describe('isPublicTokenRoute', () => {
  it('recognizes the email-link landing routes', () => {
    expect(isPublicTokenRoute('verify-email')).toBe(true);
    expect(isPublicTokenRoute('reset-password')).toBe(true);
    expect(isPublicTokenRoute('invite')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(isPublicTokenRoute('(auth)')).toBe(false);
    expect(isPublicTokenRoute('(tabs)')).toBe(false);
    expect(isPublicTokenRoute('set-credentials')).toBe(false); // requires auth, not public
    expect(isPublicTokenRoute(undefined)).toBe(false);
  });
});

describe('authRedirectTarget with isPublicRoute', () => {
  it('never redirects on a public token route, signed in or out', () => {
    expect(authRedirectTarget(null, false, true)).toBeNull();   // logged out, not bounced to login
    expect(authRedirectTarget(user, true, true)).toBeNull();    // logged in, not bounced to dashboard
    expect(authRedirectTarget(user, false, true)).toBeNull();
  });

  it('requires unfinished Google accounts to complete password setup', () => {
    const unfinished = { ...user, credentials_set: false };
    expect(authRedirectTarget(unfinished, false)).toBe(PASSWORD_SETUP_HREF);
    expect(authRedirectTarget(unfinished, true)).toBe(PASSWORD_SETUP_HREF);
    expect(authRedirectTarget(unfinished, false, false, true)).toBeNull();
  });

  it('preserves a validated invite through auth and password setup', () => {
    const invite = `/invite/${'a'.repeat(43)}`;
    const unfinished = { ...user, credentials_set: false };
    expect(authRedirectTarget(unfinished, true, false, false, invite)).toEqual({
      pathname: '/set-credentials', params: { returnTo: invite },
    });
    expect(authRedirectTarget(user, true, false, false, invite)).toBe(invite);
    expect(authRedirectTarget(user, false, false, true, invite)).toBe(invite);
  });

  it('keeps completed and signed-out users away from the setup route', () => {
    expect(authRedirectTarget(user, false, false, true)).toBe(DASHBOARD_HREF);
    expect(authRedirectTarget(null, false, false, true)).toBe(AUTH_LOGIN_HREF);
  });

  it('still loads-guards on a public route (undefined session)', () => {
    expect(authRedirectTarget(undefined, false, true)).toBeNull();
  });

  it('keeps normal routing when isPublicRoute is false (default)', () => {
    expect(authRedirectTarget(null, false)).toBe(AUTH_LOGIN_HREF);
    expect(authRedirectTarget(user, true)).toBe(DASHBOARD_HREF);
    expect(authRedirectTarget(null, false, false)).toBe(AUTH_LOGIN_HREF);
    expect(authRedirectTarget(user, true, false)).toBe(DASHBOARD_HREF);
  });
});
