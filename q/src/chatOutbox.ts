import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LocalChatMessage } from './chat';

const OUTBOX_PREFIX = 'trip_chat_outbox:v1';
export const CHAT_OUTBOX_LIMIT = 50;
const mutationQueues = new Map<string, Promise<unknown>>();

export class ChatOutboxFullError extends Error {
  constructor() {
    super('Too many unsent messages. Retry an existing message before adding another.');
    this.name = 'ChatOutboxFullError';
  }
}

export function chatOutboxKey(userId: string, tripId: string): string {
  return `${OUTBOX_PREFIX}:${userId}:${tripId}`;
}

function serialized<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  mutationQueues.set(key, current);
  return current.finally(() => {
    if (mutationQueues.get(key) === current) mutationQueues.delete(key);
  });
}

function isOutboxMessage(value: unknown, userId: string, tripId: string): value is LocalChatMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocalChatMessage>;
  return (
    item.trip_id === tripId
    && item.sender_user_id === userId
    && typeof item.client_message_id === 'string'
    && typeof item.text === 'string'
    && !!item.delivery
  );
}

async function readOutbox(key: string, userId: string, tripId: string): Promise<LocalChatMessage[]> {
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => isOutboxMessage(item, userId, tripId))
      .slice(0, CHAT_OUTBOX_LIMIT)
      .map((item) => item.delivery === 'sending'
        ? {
          ...item,
          delivery: 'failed' as const,
          error: 'Sending was interrupted. Retry safely.',
          failure: {
            code: 'network' as const,
            retryable: true,
            message: 'Sending was interrupted. Retry safely.',
          },
        }
        : item);
  } catch {
    return [];
  }
}

async function writeOutbox(key: string, messages: LocalChatMessage[]): Promise<void> {
  if (!messages.length) {
    await AsyncStorage.removeItem(key);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify(messages));
}

export function loadChatOutbox(userId: string, tripId: string): Promise<LocalChatMessage[]> {
  const key = chatOutboxKey(userId, tripId);
  return serialized(key, () => readOutbox(key, userId, tripId));
}

export function enqueueChatOutbox(
  userId: string,
  tripId: string,
  pending: LocalChatMessage,
): Promise<void> {
  const key = chatOutboxKey(userId, tripId);
  return serialized(key, async () => {
    const current = await readOutbox(key, userId, tripId);
    const index = current.findIndex((item) => item.client_message_id === pending.client_message_id);
    if (index >= 0) current[index] = pending;
    else {
      if (current.length >= CHAT_OUTBOX_LIMIT) throw new ChatOutboxFullError();
      current.push(pending);
    }
    await writeOutbox(key, current);
  });
}

export function saveChatOutbox(
  userId: string,
  tripId: string,
  messages: LocalChatMessage[],
): Promise<void> {
  const key = chatOutboxKey(userId, tripId);
  const pending = messages.filter((message) => !!message.delivery).slice(0, CHAT_OUTBOX_LIMIT);
  return serialized(key, () => writeOutbox(key, pending));
}

export function removeChatOutboxMessage(
  userId: string,
  tripId: string,
  clientMessageId: string,
): Promise<void> {
  const key = chatOutboxKey(userId, tripId);
  return serialized(key, async () => {
    const current = await readOutbox(key, userId, tripId);
    await writeOutbox(
      key,
      current.filter((message) => message.client_message_id !== clientMessageId),
    );
  });
}
