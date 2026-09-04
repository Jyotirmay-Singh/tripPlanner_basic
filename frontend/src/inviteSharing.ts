import { canManageMembers, type RoleTrip } from './permissions';


export function canShareSecureInvite(
  trip: RoleTrip,
  userId: string | undefined,
  inviteLinksEnabled: boolean,
): boolean {
  return inviteLinksEnabled && canManageMembers(trip, userId);
}

export function tripCodeShareMessage(tripName: string, code: string): string {
  return `Join my trip "${tripName}" on Trip Splitter. Code: ${code}`;
}

export function tripInviteShareMessage(tripName: string, inviteUrl: string): string {
  return `Join my trip "${tripName}" on Trip Splitter:\n${inviteUrl}`
    + '\n\nThis private link expires in 7 days.';
}
