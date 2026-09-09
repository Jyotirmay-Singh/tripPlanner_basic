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
  return `Join my trip "${tripName}" on Trip Splitter.`
    + `\n\nTrip code: ${code}`
    + '\n\nDownload the Trip Splitter APK (Android phones only):'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`;
}

export function tripInviteShareMessage(
  tripName: string,
  code: string,
  inviteUrl: string,
): string {
  return `Join my trip "${tripName}" on Trip Splitter.`
    + `\n\nOpen trip / join:\n${inviteUrl}`
    + `\n\nTrip code: ${code}`
    + '\n\nDownload the Trip Splitter APK (Android phones only):'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`
    + '\n\nThis private invite link expires in 7 days.';
}
