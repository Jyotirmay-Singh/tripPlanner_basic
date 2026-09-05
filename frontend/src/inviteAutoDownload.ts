export const INVITE_APK_AUTO_DOWNLOAD_DELAY_MS = 900;

type SessionStorageLike = Pick<Storage, 'getItem' | 'setItem'>;

const attemptedOnThisPage = new Set<string>();

function tokenFingerprint(token: string): string {
  // This is only a storage-key fingerprint, not a security primitive.  Keeping the bearer token
  // itself out of sessionStorage avoids creating another copy of the invitation credential.
  let forward = 2166136261;
  let backward = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    forward = Math.imul(forward ^ token.charCodeAt(index), 16777619);
    backward = Math.imul(backward ^ token.charCodeAt(token.length - index - 1), 16777619);
  }
  return `${(forward >>> 0).toString(36)}-${(backward >>> 0).toString(36)}-${token.length}`;
}

export function isAndroidWebBrowser(platform: string, userAgent: string): boolean {
  return platform === 'web' && /android/i.test(userAgent);
}

export function claimInviteApkAutoDownload(
  token: string,
  storage: SessionStorageLike | null,
): boolean {
  const fingerprint = tokenFingerprint(token);
  if (attemptedOnThisPage.has(fingerprint)) return false;

  const key = `trip-splitter:invite-apk-attempt:${fingerprint}`;
  try {
    if (storage?.getItem(key)) {
      attemptedOnThisPage.add(fingerprint);
      return false;
    }
    storage?.setItem(key, '1');
  } catch {
    // Privacy modes can deny sessionStorage.  The in-memory claim still prevents repeat attempts
    // during this page lifetime and the manual download button remains available.
  }
  attemptedOnThisPage.add(fingerprint);
  return true;
}
