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
  return `You have been invited to join the group "${tripName}" on Splitora.`
    + `\n\nGroup code: ${code}`
    + '\nEnter this code in Splitora to join the group.'
    + '\n\nDownload the latest Splitora APK for Android:'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`;
}

export function tripInviteShareMessage(
  tripName: string,
  code: string,
  inviteUrl: string,
): string {
  return `You have been invited to join the group "${tripName}" on Splitora.`
    + `\n\nOpen the invitation link:\n${inviteUrl}`
    + `\n\nGroup code: ${code}`
    + '\nYou can also enter this code in Splitora to join manually.'
    + '\n\nDownload the latest Splitora APK for Android:'
    + `\n${ANDROID_APK_DOWNLOAD_URL}`;
}
