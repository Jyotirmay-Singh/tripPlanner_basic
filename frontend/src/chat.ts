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
  delivery?: 'sending' | 'failed';
  error?: string;
};

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
    byKey.set(message.client_message_id || message.id, message);
  }
  for (const message of incoming) {
    byKey.set(message.client_message_id || message.id, message);
  }
  return [...byKey.values()].sort((a, b) => {
    if (a.delivery && !b.delivery) return 1;
    if (!a.delivery && b.delivery) return -1;
    if (a.sequence !== b.sequence) return a.sequence - b.sequence;
    return a.created_at.localeCompare(b.created_at);
  });
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
