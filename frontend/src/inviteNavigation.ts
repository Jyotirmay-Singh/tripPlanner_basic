import type { Href } from 'expo-router';


export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
export const DEFAULT_APP_ORIGIN = 'https://tripsplitter-web.vercel.app';

export function invitePath(token: string): string | null {
  const normalized = token.trim();
  return INVITE_TOKEN_PATTERN.test(normalized) ? `/invite/${normalized}` : null;
}

export function safeInviteReturnTo(value: unknown): string | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string') return null;
  const match = candidate.match(/^\/invite\/([^/?#]+)$/);
  return match ? invitePath(match[1]) : null;
}

export function postAuthHref(pendingInvitePath?: string | null): Href {
  return (safeInviteReturnTo(pendingInvitePath) || '/(tabs)/dashboard') as Href;
}

export function passwordSetupHref(pendingInvitePath?: string | null): Href {
  const returnTo = safeInviteReturnTo(pendingInvitePath);
  return (returnTo
    ? { pathname: '/set-credentials', params: { returnTo } }
    : '/set-credentials') as Href;
}

export function joinHref(token: string): Href | null {
  return INVITE_TOKEN_PATTERN.test(token)
    ? ({ pathname: '/join-trip', params: { inviteToken: token } } as Href)
    : null;
}
