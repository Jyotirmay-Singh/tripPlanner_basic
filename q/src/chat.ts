import { familyMemberDisplayNames, memberDisplayNames } from './displayNames';

export type ChatMessage = {
  id: string;
  client_message_id: string;
  trip_id: string;
  sequence: number;
  sender_user_id: string;
  sender_person_id: string;
  sender_name: string;
  sender_family_id?: string | null;
  sender_family_name?: string | null;
  text: string | null;
  created_at: string;
  edited_at?: string | null;
  deleted_at?: string | null;
};

export type LocalChatMessage = ChatMessage & {
  delivery?: 'queued' | 'sending' | 'failed';
  error?: string;
  failure?: ChatFailure;
};

export type ChatFailureCode =
  | 'authentication_required'
  | 'permission_denied'
  | 'unavailable'
  | 'offline'
  | 'timeout'
  | 'network'
  | 'server'
  | 'conflict'
  | 'validation'
  | 'configuration'
  | 'unknown';

export type ChatFailure = {
  code: ChatFailureCode;
  message: string;
  retryable: boolean;
  status?: number;
};

export type ChatConnectionStatus =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'offline'
  | 'authentication_required'
  | 'permission_denied'
  | 'unavailable';

export type ChatConnectionState = {
  status: ChatConnectionStatus;
  attempt: number;
  reason?: ChatFailureCode;
};

export type ChatCapability = 'loading' | 'supported' | 'unsupported' | 'unknown';

export type ChatPage = {
  items: ChatMessage[];
  has_more_before: boolean;
  has_more_after: boolean;
  cleared_through_sequence: number;
};

export type ChatUnread = { count: number; latest_sequence: number };

export type ChatEvent =
  | { type: 'ready' | 'pong' }
  | { type: 'message.created' | 'message.updated'; data: ChatMessage }
  | { type: 'chat.cleared'; data: { through_sequence: number } };

export type ChatMember = {
  id: string;
  name: string;
  kind: 'individual' | 'family';
  user_id?: string | null;
  family_members?: string[] | null;
  family_member_ids?: string[] | null;
  family_member_user_ids?: (string | null)[] | null;
};

export type ChatSender = { name: string; familyName?: string | null };

export function chatMessageKey(
  message: Pick<ChatMessage, 'id' | 'client_message_id' | 'sender_user_id'>,
): string {
  return message.client_message_id
    ? `${message.sender_user_id}:${message.client_message_id}`
    : message.id;
}

export function classifyChatError(error: any): ChatFailure {
  const status = typeof error?.status === 'number' ? error.status : undefined;
  const rawMessage = typeof error?.message === 'string' ? error.message : '';
  if (status === 401) {
    return {
      code: 'authentication_required', status, retryable: false,
      message: 'Sign in again to send this message.',
    };
  }
  if (status === 403) {
    return {
      code: 'permission_denied', status, retryable: false,
      message: 'You no longer have access to this trip chat.',
    };
  }
  if (status === 404) {
    return {
      code: 'unavailable', status, retryable: false,
      message: 'Trip chat is unavailable on the connected server.',
    };
  }
  if (status === 409) {
    const retryable = /retry|try again|cleared while/i.test(rawMessage);
    return {
      code: 'conflict', status, retryable,
      message: rawMessage || 'The message conflicts with a newer chat change.',
    };
  }
  if (status === 400 || status === 422) {
    return {
      code: 'validation', status, retryable: false,
      message: rawMessage || 'The message was rejected.',
    };
  }
  if (status != null && status >= 500) {
    return {
      code: 'server', status, retryable: true,
      message: 'Trip chat is temporarily unavailable.',
    };
  }
  if (error?.code === 'timeout') {
    return { code: 'timeout', retryable: true, message: 'Sending timed out. Retry safely.' };
  }
  if (error?.code === 'network') {
    return { code: 'network', retryable: true, message: 'Could not reach the server.' };
  }
  if (error?.code === 'configuration') {
    return { code: 'configuration', retryable: false, message: rawMessage || 'Chat is not configured.' };
  }
  return { code: 'unknown', retryable: true, message: rawMessage || 'Message not sent.' };
}

export function offlineChatFailure(): ChatFailure {
  return { code: 'offline', retryable: true, message: 'Offline. Retry when you are connected.' };
}

export function reconnectDelay(attempt: number, random = Math.random): number {
  const base = [1000, 2000, 5000, 10_000, 30_000][Math.min(Math.max(attempt, 0), 4)];
  const jitter = 0.8 + Math.min(Math.max(random(), 0), 1) * 0.4;
  return Math.round(base * jitter);
}

/** Client mirror used only for the optimistic row; persisted attribution is server-authoritative. */
export function resolveOptimisticSender(
  members: ChatMember[] | null | undefined,
  userId: string | null | undefined,
): ChatSender | null {
  if (!userId) return null;
  const list = members ?? [];
  const topNames = memberDisplayNames(list);
  for (const member of list) {
    if (member.kind !== 'family') {
      if (member.user_id === userId) return { name: topNames[member.id] ?? member.name };
      continue;
    }
    const userIds = member.family_member_user_ids ?? [];
    const index = userIds.findIndex((id) => id === userId);
    if (index < 0) continue;
    const personNames = familyMemberDisplayNames(member);
    return {
      name: personNames[index] ?? member.family_members?.[index] ?? 'Member',
      familyName: topNames[member.id] ?? member.name,
    };
  }
  return null;
}

export function senderLabel(message: Pick<ChatMessage, 'sender_name' | 'sender_family_name'>): string {
  return message.sender_family_name
    ? `${message.sender_name} · ${message.sender_family_name}`
    : message.sender_name;
}

export function unreadBadge(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count > 99 ? '99+' : String(count);
}

export function mergeChatMessages(
  current: LocalChatMessage[],
  incoming: ChatMessage[],
): LocalChatMessage[] {
  const byKey = new Map<string, LocalChatMessage>();
  for (const message of current) {
    byKey.set(chatMessageKey(message), message);
  }
  for (const message of incoming) {
    byKey.set(chatMessageKey(message), message);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.delivery && !b.delivery) return 1;
    if (!a.delivery && b.delivery) return -1;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.created_at.localeCompare(b.created_at);
  });
}

/** Keep a local sender pending until its REST acknowledgement arrives. */
export function mergeChatEvent(
  current: LocalChatMessage[],
  incoming: ChatMessage,
  currentUserId: string,
): LocalChatMessage[] {
  const existing = current.find((message) => chatMessageKey(message) === chatMessageKey(incoming));
  if (existing?.delivery && incoming.sender_user_id === currentUserId) {
    const pending: LocalChatMessage = {
      ...incoming,
      delivery: existing.delivery,
      error: existing.error,
      failure: existing.failure,
    };
    return mergeChatMessages(
      current.filter((message) => chatMessageKey(message) !== chatMessageKey(incoming)),
      [pending],
    );
  }
  return mergeChatMessages(current, [incoming]);
}

export function formatChatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function chatDateKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function formatChatDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const difference = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (difference === 0) return 'Today';
  if (difference === 1) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}
