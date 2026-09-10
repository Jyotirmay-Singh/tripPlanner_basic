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

it('allows every actual trip member to use secure sharing when the rollout flag is enabled', () => {
  expect(canShareSecureInvite(trip, 'owner-1', true)).toBe(true);
  expect(canShareSecureInvite(trip, 'admin-1', true)).toBe(true);
  expect(canShareSecureInvite(trip, 'member-1', true)).toBe(true);
  expect(canShareSecureInvite(trip, 'outsider-1', true)).toBe(false);
  expect(canShareSecureInvite(trip, 'owner-1', false)).toBe(false);
});

it('allows the application super-admin to share without joining the trip', () => {
  expect(canShareSecureInvite(trip, undefined, true, true)).toBe(true);
  expect(canShareSecureInvite(trip, undefined, false, true)).toBe(false);
});

it('builds the exact secure invitation message with link, code, APK, and expiry', () => {
  const url = `https://tripsplitter-web.vercel.app/invite/${'a'.repeat(43)}`;
  expect(tripInviteShareMessage('Coast trip', 'ABC123', url)).toBe(
    `You have been invited to join the trip "Coast trip" on Trip Splitter.\n\n`
    + `Open the invitation link:\n${url}\n\n`
    + 'Trip code: ABC123\n'
    + 'You can also enter this code in Trip Splitter to join manually.\n\n'
    + 'Download Trip Splitter for Android:\n'
    + 'https://tripsplitter-web.vercel.app/download/android\n\n'
    + 'A trip admin can reset this private invitation link at any time.',
  );
});

it('builds the exact code fallback with the Android-only APK download', () => {
  expect(tripCodeShareMessage('Coast trip', 'ABC123')).toBe(
    'You have been invited to join the trip "Coast trip" on Trip Splitter.\n\n'
    + 'Trip code: ABC123\n'
    + 'Enter this code in Trip Splitter to join the trip.\n\n'
    + 'Download Trip Splitter for Android:\n'
    + 'https://tripsplitter-web.vercel.app/download/android',
  );
});
