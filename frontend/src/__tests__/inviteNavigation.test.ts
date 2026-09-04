import {
  invitePath,
  joinHref,
  passwordSetupHref,
  postAuthHref,
  safeInviteReturnTo,
} from '../inviteNavigation';


const token = 'a'.repeat(43);
const path = `/invite/${token}`;

describe('invite navigation safety', () => {
  it('accepts only internal, well-formed invite paths', () => {
    expect(invitePath(token)).toBe(path);
    expect(safeInviteReturnTo(path)).toBe(path);
    expect(safeInviteReturnTo(`https://evil.example/invite/${token}`)).toBeNull();
    expect(safeInviteReturnTo('/invite/short')).toBeNull();
    expect(safeInviteReturnTo(`${path}?next=https://evil.example`)).toBeNull();
  });

  it('returns to the invite across normal and first-time Google authentication', () => {
    expect(postAuthHref(path)).toBe(path);
    expect(passwordSetupHref(path)).toEqual({ pathname: '/set-credentials', params: { returnTo: path } });
    expect(postAuthHref('/trip/secret')).toBe('/(tabs)/dashboard');
    expect(joinHref(token)).toEqual({ pathname: '/join-trip', params: { inviteToken: token } });
  });
});
