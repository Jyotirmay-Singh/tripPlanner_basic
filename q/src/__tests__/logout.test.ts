import {
  authRedirectTarget,
  performSignOut,
  AUTH_LOGIN_HREF,
  DASHBOARD_HREF,
} from '../authNav';

const user = { id: 'u1', email: 'a@gmail.com', name: 'A', role: 'user' } as any;

describe('authRedirectTarget', () => {
  it('no-ops while the session is still loading (undefined)', () => {
    expect(authRedirectTarget(undefined, false)).toBeNull();
    expect(authRedirectTarget(undefined, true)).toBeNull();
  });

  it('sends a signed-out user off a protected screen to login', () => {
    expect(authRedirectTarget(null, false)).toBe(AUTH_LOGIN_HREF);
  });

  it('leaves a signed-out user on an auth screen alone', () => {
    expect(authRedirectTarget(null, true)).toBeNull();
  });

  it('sends a signed-in user off an auth screen to the dashboard', () => {
    expect(authRedirectTarget(user, true)).toBe(DASHBOARD_HREF);
  });

  it('leaves a signed-in user on a protected screen alone', () => {
    expect(authRedirectTarget(user, false)).toBeNull();
  });
});

describe('performSignOut', () => {
  it('drops the session before navigating, each exactly once', async () => {
    const order: string[] = [];
    const signOut = jest.fn(async () => { order.push('signOut'); });
    const navigate = jest.fn(() => { order.push('navigate'); });

    await performSignOut(signOut, navigate);

    expect(order).toEqual(['signOut', 'navigate']);
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('does not navigate if signing out fails', async () => {
    const signOut = jest.fn(async () => { throw new Error('boom'); });
    const navigate = jest.fn();

    await expect(performSignOut(signOut, navigate)).rejects.toThrow('boom');
    expect(navigate).not.toHaveBeenCalled();
  });
});
