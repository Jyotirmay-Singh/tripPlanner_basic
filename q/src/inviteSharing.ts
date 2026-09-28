import { roleOf, type RoleTrip } from './permissions';
import { ANDROID_APK_DOWNLOAD_URL } from './inviteNavigation';


export function canShareSecureInvite(
  trip: RoleTrip,
  userId: string | undefined,
  inviteLinksEnabled: boolean,
  isSuperAdmin = false,
): boolean {
  return inviteLinksEnabled && roleOf(trip, userId, isSuperAdmin) !== null;
}

export function tripCodeShareMessage(tripName: string, code: string): string {
  return `You have been invited to join the trip "${tripName}" on Trip Splitter.`
    + `\n\nTrip code: ${code}`
    + '\nEnter this code in Trip Splitter to join the trip.'
    + '\n\nDownload Trip Splitter for Android:'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`;
}

export function tripInviteShareMessage(
  tripName: string,
  code: string,
  inviteUrl: string,
): string {
  return `You have been invited to join the trip "${tripName}" on Trip Splitter.`
    + `\n\nOpen the invitation link:\n${inviteUrl}`
    + `\n\nTrip code: ${code}`
    + '\nYou can also enter this code in Trip Splitter to join manually.'
    + '\n\nDownload Trip Splitter for Android:'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`
    + '\n\nA trip admin can reset this private invitation link at any time.';
}
