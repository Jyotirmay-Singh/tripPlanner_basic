import {
  canShareSecureInvite,
  tripCodeShareMessage,
  tripInviteShareMessage,
} from '../inviteSharing';


const trip = {
  owner_id: 'owner-1',
  admin_ids: ['owner-1', 'admin-1'],
  user_ids: ['owner-1', 'admin-1', 'member-1'],
};

it('allows only owners/admins to use secure sharing when the rollout flag is enabled', () => {
  expect(canShareSecureInvite(trip, 'owner-1', true)).toBe(true);
  expect(canShareSecureInvite(trip, 'admin-1', true)).toBe(true);
  expect(canShareSecureInvite(trip, 'member-1', true)).toBe(false);
  expect(canShareSecureInvite(trip, 'owner-1', false)).toBe(false);
});

it('keeps secure invitation messages code-free and preserves the member code fallback', () => {
  const url = `https://tripsplitter-web.vercel.app/invite/${'a'.repeat(43)}`;
  const secure = tripInviteShareMessage('Coast trip', url);
  const legacy = tripCodeShareMessage('Coast trip', 'ABC123');

  expect(secure).toContain(url);
  expect(secure).not.toContain('ABC123');
  expect(legacy).toContain('Code: ABC123');
});
