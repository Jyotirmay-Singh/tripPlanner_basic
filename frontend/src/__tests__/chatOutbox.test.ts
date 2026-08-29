import AsyncStorage from '@react-native-async-storage/async-storage';

import type { LocalChatMessage } from '../chat';
import {
  CHAT_OUTBOX_LIMIT,
  ChatOutboxFullError,
  chatOutboxKey,
  enqueueChatOutbox,
  loadChatOutbox,
  removeChatOutboxMessage,
  saveChatOutbox,
} from '../chatOutbox';

const mockStorage = new Map<string, string>();

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn((key: string) => Promise.resolve(mockStorage.get(key) ?? null)),
    setItem: jest.fn((key: string, value: string) => {
      mockStorage.set(key, value);
      return Promise.resolve();
    }),
    removeItem: jest.fn((key: string) => {
      mockStorage.delete(key);
      return Promise.resolve();
    }),
  },
}));

const pendingMessage = (clientId: string, overrides: Partial<LocalChatMessage> = {}): LocalChatMessage => ({
  id: `pending:${clientId}`,
  client_message_id: clientId,
  trip_id: 't1',
  sequence: Number.MAX_SAFE_INTEGER,
  sender_user_id: 'u1',
  sender_person_id: '',
  sender_name: 'Ravi',
  sender_family_name: null,
  text: 'Meet in the lobby',
  created_at: '2026-08-22T10:00:00Z',
  edited_at: null,
  deleted_at: null,
  delivery: 'sending',
  ...overrides,
});

beforeEach(() => {
  mockStorage.clear();
  jest.clearAllMocks();
});

it('updates the same logical message without creating another outbox row', async () => {
  await enqueueChatOutbox('u1', 't1', pendingMessage('c1'));
  await enqueueChatOutbox('u1', 't1', pendingMessage('c1', {
    delivery: 'failed',
    error: 'Could not reach the server.',
  }));

  const loaded = await loadChatOutbox('u1', 't1');
  expect(loaded).toHaveLength(1);
  expect(loaded[0]).toMatchObject({ client_message_id: 'c1', delivery: 'failed' });
});

it('hydrates an interrupted send as a safely retryable failure', async () => {
  await AsyncStorage.setItem(
    chatOutboxKey('u1', 't1'),
    JSON.stringify([pendingMessage('c1')]),
  );

  const loaded = await loadChatOutbox('u1', 't1');
  expect(loaded[0]).toMatchObject({
    client_message_id: 'c1',
    delivery: 'failed',
    failure: { code: 'network', retryable: true },
  });
});

it('rejects corrupt or cross-user rows from a scoped outbox', async () => {
  await AsyncStorage.setItem(
    chatOutboxKey('u1', 't1'),
    JSON.stringify([
      pendingMessage('valid'),
      pendingMessage('wrong-user', { sender_user_id: 'u2' }),
      pendingMessage('wrong-trip', { trip_id: 't2' }),
      { client_message_id: 'incomplete' },
    ]),
  );

  expect((await loadChatOutbox('u1', 't1')).map((item) => item.client_message_id)).toEqual(['valid']);
});

it('bounds durable unsent messages and preserves existing retry IDs at the limit', async () => {
  for (let index = 0; index < CHAT_OUTBOX_LIMIT; index += 1) {
    await enqueueChatOutbox('u1', 't1', pendingMessage(`c${index}`, { delivery: 'failed' }));
  }

  await expect(enqueueChatOutbox(
    'u1',
    't1',
    pendingMessage('overflow', { delivery: 'failed' }),
  )).rejects.toBeInstanceOf(ChatOutboxFullError);
  await expect(enqueueChatOutbox(
    'u1',
    't1',
    pendingMessage('c0', { delivery: 'queued' }),
  )).resolves.toBeUndefined();
  expect(await loadChatOutbox('u1', 't1')).toHaveLength(CHAT_OUTBOX_LIMIT);
});

it('removes acknowledged messages and persists delivery rows only', async () => {
  await saveChatOutbox('u1', 't1', [
    pendingMessage('pending', { delivery: 'queued' }),
    pendingMessage('sent', { id: 'server-id', delivery: undefined, sequence: 1 }),
  ]);
  expect((await loadChatOutbox('u1', 't1')).map((item) => item.client_message_id)).toEqual(['pending']);

  await removeChatOutboxMessage('u1', 't1', 'pending');
  expect(await loadChatOutbox('u1', 't1')).toEqual([]);
  expect(mockStorage.has(chatOutboxKey('u1', 't1'))).toBe(false);
});
