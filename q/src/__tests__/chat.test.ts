import {
  chatMessageKey,
  classifyChatError,
  mergeChatEvent,
  mergeChatMessages,
  reconnectDelay,
  resolveOptimisticSender,
  senderLabel,
  unreadBadge,
  type ChatMessage,
  type LocalChatMessage,
} from '../chat';

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'm1',
  client_message_id: 'c1',
  trip_id: 't1',
  sequence: 1,
  sender_user_id: 'u1',
  sender_person_id: 'p1',
  sender_name: 'Ravi',
  sender_family_name: null,
  text: 'Hello',
  created_at: '2026-08-22T10:00:00Z',
  edited_at: null,
  deleted_at: null,
  ...overrides,
});

describe('chat identity', () => {
  it('uses the exact linked family sub-member plus family context', () => {
    const sender = resolveOptimisticSender([
      {
        id: 'f1', name: 'Sharma Family', kind: 'family',
        family_members: ['Ravi', 'Priya'], family_member_ids: ['p1', 'p2'],
        family_member_user_ids: [null, 'u2'],
      },
    ], 'u2');

    expect(sender).toEqual({ name: 'Priya', familyName: 'Sharma Family' });
  });

  it('uses disambiguated top-level names for duplicate individuals', () => {
    const sender = resolveOptimisticSender([
      { id: 'i1', name: 'Ravi', kind: 'individual', user_id: 'u1' },
      { id: 'i2', name: 'Ravi', kind: 'individual', user_id: 'u2' },
    ], 'u2');
    expect(sender).toEqual({ name: 'Ravi_2' });
  });

  it('formats family context and unread caps', () => {
    expect(senderLabel(message({ sender_family_name: 'Sharma Family' }))).toBe('Ravi · Sharma Family');
    expect(unreadBadge(0)).toBeUndefined();
    expect(unreadBadge(7)).toBe('7');
    expect(unreadBadge(120)).toBe('99+');
  });
});

describe('chat message merging', () => {
  it('replaces an optimistic row with the server copy by client id', () => {
    const pending: LocalChatMessage = {
      ...message({ id: 'pending:c1', sequence: Number.MAX_SAFE_INTEGER }),
      delivery: 'sending',
    };
    const saved = message({ id: 'server-id', sequence: 4 });

    expect(mergeChatMessages([pending], [saved])).toEqual([saved]);
  });

  it('sorts persisted messages chronologically and leaves local failures last', () => {
    const failed: LocalChatMessage = {
      ...message({ id: 'pending:c3', client_message_id: 'c3', sequence: Number.MAX_SAFE_INTEGER }),
      delivery: 'failed',
    };
    const result = mergeChatMessages(
      [failed, message({ id: 'm2', client_message_id: 'c2', sequence: 2 })],
      [message({ id: 'm1', client_message_id: 'c1', sequence: 1 })],
    );
    expect(result.map((item) => item.id)).toEqual(['m1', 'm2', 'pending:c3']);
  });

  it('scopes client message IDs to the sender', () => {
    const first = message({ id: 'm1', sender_user_id: 'u1', client_message_id: 'same', sequence: 1 });
    const second = message({ id: 'm2', sender_user_id: 'u2', client_message_id: 'same', sequence: 2 });
    const result = mergeChatMessages([first], [second]);

    expect(result).toHaveLength(2);
    expect(result.map(chatMessageKey)).toEqual(['u1:same', 'u2:same']);
  });

  it('keeps the sender pending until the REST acknowledgement arrives', () => {
    const pending: LocalChatMessage = {
      ...message({ id: 'pending:c1', sequence: Number.MAX_SAFE_INTEGER }),
      delivery: 'sending',
    };
    const announced = message({ id: 'server-id', sequence: 4 });

    expect(mergeChatEvent([pending], announced, 'u1')).toEqual([{
      ...announced,
      delivery: 'sending',
      error: undefined,
      failure: undefined,
    }]);
  });
});

describe('chat failure and reconnect policy', () => {
  it.each([
    [401, 'authentication_required', false],
    [403, 'permission_denied', false],
    [404, 'unavailable', false],
    [422, 'validation', false],
    [503, 'server', true],
  ])('classifies HTTP %s as %s (retryable=%s)', (status, code, retryable) => {
    expect(classifyChatError({ status, message: 'server detail' })).toMatchObject({ code, retryable, status });
  });

  it('classifies transport failures without exposing implementation details', () => {
    expect(classifyChatError({ code: 'timeout' })).toMatchObject({ code: 'timeout', retryable: true });
    expect(classifyChatError({ code: 'network' })).toMatchObject({ code: 'network', retryable: true });
    expect(classifyChatError({ code: 'configuration', message: 'bad endpoint' }))
      .toMatchObject({ code: 'configuration', retryable: false });
  });

  it('uses bounded exponential delays with twenty-percent jitter', () => {
    expect(reconnectDelay(0, () => 0)).toBe(800);
    expect(reconnectDelay(0, () => 1)).toBe(1200);
    expect(reconnectDelay(2, () => 0.5)).toBe(5000);
    expect(reconnectDelay(99, () => 0.5)).toBe(30_000);
  });
});
