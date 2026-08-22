import { useCallback, useEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';

import {
  chatSocketUrl,
  chatUnread,
  clearChatHistory,
  deleteChatMessage,
  editChatMessage,
  getToken,
  listChatMessages,
  markChatRead,
  sendChatMessage,
} from './api';
import {
  type ChatEvent,
  type ChatSender,
  type LocalChatMessage,
  mergeChatMessages,
} from './chat';

type Options = {
  tripId: string;
  userId?: string;
  sender: ChatSender | null;
  active: boolean;
};

export type TripChatController = {
  messages: LocalChatMessage[];
  unreadCount: number;
  loading: boolean;
  loadingOlder: boolean;
  hasMoreBefore: boolean;
  connected: boolean;
  refreshUnread: () => Promise<void>;
  loadLatest: () => Promise<void>;
  loadOlder: () => Promise<void>;
  send: (text: string) => Promise<boolean>;
  retry: (message: LocalChatMessage) => Promise<boolean>;
  edit: (messageId: string, text: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  clear: () => Promise<void>;
  markThrough: (sequence: number) => Promise<void>;
};

export function useTripChat({ tripId, userId, sender, active }: Options): TripChatController {
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [connected, setConnected] = useState(false);
  const messagesRef = useRef<LocalChatMessage[]>([]);
  const activeRef = useRef(active);
  const disposedRef = useRef(false);

  const commitMessages = useCallback((updater: (current: LocalChatMessage[]) => LocalChatMessage[]) => {
    setMessages((current) => {
      const next = updater(current);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => { activeRef.current = active; }, [active]);

  const refreshUnread = useCallback(async () => {
    if (!tripId || !userId) return;
    try {
      const result = await chatUnread(tripId);
      setUnreadCount(Number(result?.count) || 0);
    } catch {
      // Keep the last known badge during a transient network failure.
    }
  }, [tripId, userId]);

  const markThrough = useCallback(async (sequence: number) => {
    if (!tripId || !userId || !Number.isFinite(sequence) || sequence <= 0) return;
    await markChatRead(tripId, sequence);
    setUnreadCount(0);
  }, [tripId, userId]);

  const loadLatest = useCallback(async () => {
    if (!tripId || !userId) return;
    setLoading(true);
    try {
      const page = await listChatMessages(tripId, { limit: 50 });
      commitMessages((current) => {
        const stillVisible = current.filter((message) => (
          !!message.delivery || message.sequence > (page.cleared_through_sequence ?? 0)
        ));
        return mergeChatMessages(stillVisible, page.items ?? []);
      });
      setHasMoreBefore(!!page.has_more_before);
      const last = page.items?.[page.items.length - 1];
      if (activeRef.current && last) await markThrough(last.sequence);
      else await refreshUnread();
    } finally {
      setLoading(false);
    }
  }, [commitMessages, markThrough, refreshUnread, tripId, userId]);

  const loadOlder = useCallback(async () => {
    const first = messagesRef.current.find((message) => !message.delivery && message.sequence > 0);
    if (!tripId || !first || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listChatMessages(tripId, {
        beforeSequence: first.sequence,
        limit: 50,
      });
      commitMessages((current) => mergeChatMessages(
        current.filter((message) => (
          !!message.delivery || message.sequence > (page.cleared_through_sequence ?? 0)
        )),
        page.items ?? [],
      ));
      setHasMoreBefore(!!page.has_more_before);
    } finally {
      setLoadingOlder(false);
    }
  }, [commitMessages, loadingOlder, tripId]);

  const persistPending = useCallback(async (pending: LocalChatMessage): Promise<boolean> => {
    try {
      const saved = await sendChatMessage(tripId, {
        client_message_id: pending.client_message_id,
        text: pending.text ?? '',
      });
      commitMessages((current) => mergeChatMessages(current, [saved]));
      return true;
    } catch (error: any) {
      commitMessages((current) => current.map((message) => (
        message.client_message_id === pending.client_message_id
          ? { ...message, delivery: 'failed', error: error?.message || 'Message not sent' }
          : message
      )));
      return false;
    }
  }, [commitMessages, tripId]);

  const send = useCallback(async (rawText: string): Promise<boolean> => {
    const text = rawText.trim();
    if (!userId || !sender || !text || text.length > 2000) return false;
    const clientId = Crypto.randomUUID();
    const pending: LocalChatMessage = {
      id: `pending:${clientId}`,
      client_message_id: clientId,
      trip_id: tripId,
      sequence: Number.MAX_SAFE_INTEGER,
      sender_user_id: userId,
      sender_person_id: '',
      sender_name: sender.name,
      sender_family_name: sender.familyName ?? null,
      text,
      created_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      delivery: 'sending',
    };
    commitMessages((current) => mergeChatMessages(current, [pending]));
    return persistPending(pending);
  }, [commitMessages, persistPending, sender, tripId, userId]);

  const retry = useCallback(async (message: LocalChatMessage): Promise<boolean> => {
    if (!message.text) return false;
    const pending = { ...message, delivery: 'sending' as const, error: undefined };
    commitMessages((current) => current.map((item) => (
      item.client_message_id === pending.client_message_id ? pending : item
    )));
    return persistPending(pending);
  }, [commitMessages, persistPending]);

  const edit = useCallback(async (messageId: string, text: string) => {
    const saved = await editChatMessage(tripId, messageId, text);
    commitMessages((current) => mergeChatMessages(current, [saved]));
  }, [commitMessages, tripId]);

  const remove = useCallback(async (messageId: string) => {
    const saved = await deleteChatMessage(tripId, messageId);
    commitMessages((current) => mergeChatMessages(current, [saved]));
  }, [commitMessages, tripId]);

  const clear = useCallback(async () => {
    const result = await clearChatHistory(tripId);
    commitMessages((current) => current.filter(
      (message) => !message.delivery && message.sequence > result.cleared_through_sequence,
    ));
    setHasMoreBefore(false);
    setUnreadCount(0);
  }, [commitMessages, tripId]);

  const catchUp = useCallback(async () => {
    const persisted = messagesRef.current.filter((message) => !message.delivery);
    let after = persisted.length ? persisted[persisted.length - 1].sequence : 0;
    if (!after) {
      await refreshUnread();
      return;
    }
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await listChatMessages(tripId, { afterSequence: after, limit: 100 });
      commitMessages((current) => current.filter((message) => (
        !!message.delivery || message.sequence > (page.cleared_through_sequence ?? 0)
      )));
      if (page.items?.length) {
        commitMessages((current) => mergeChatMessages(current, page.items));
        after = page.items[page.items.length - 1].sequence;
      }
      if (!page.has_more_after) break;
    }
    if (activeRef.current && after > 0) await markThrough(after);
    else await refreshUnread();
  }, [commitMessages, markThrough, refreshUnread, tripId]);

  useEffect(() => {
    if (active) loadLatest().catch(() => {});
  }, [active, loadLatest]);

  useEffect(() => {
    disposedRef.current = false;
    refreshUnread().catch(() => {});
    // The function guard also keeps focused screen tests that intentionally mock only the legacy
    // API surface from starting reconnect timers.
    if (!tripId || !userId || typeof WebSocket === 'undefined' || typeof chatSocketUrl !== 'function') {
      return () => {};
    }

    let socket: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const scheduleReconnect = () => {
      if (disposedRef.current) return;
      const delay = Math.min(30_000, [1000, 2000, 5000, 10_000][Math.min(attempt, 3)] ?? 30_000);
      attempt += 1;
      retryTimer = setTimeout(connect, delay);
    };

    const handleEvent = (event: ChatEvent) => {
      if (event.type === 'ready') {
        attempt = 0;
        setConnected(true);
        catchUp().catch(() => refreshUnread());
        return;
      }
      if (event.type === 'message.created') {
        commitMessages((current) => mergeChatMessages(current, [event.data]));
        if (event.data.sender_user_id !== userId) {
          if (activeRef.current) markThrough(event.data.sequence).catch(() => {});
          else setUnreadCount((count) => count + 1);
        }
        return;
      }
      if (event.type === 'message.updated') {
        commitMessages((current) => mergeChatMessages(current, [event.data]));
        if (!activeRef.current) refreshUnread().catch(() => {});
        return;
      }
      if (event.type === 'chat.cleared') {
        commitMessages((current) => current.filter(
          (message) => !message.delivery && message.sequence > event.data.through_sequence,
        ));
        setHasMoreBefore(false);
        setUnreadCount(0);
      }
    };

    async function connect() {
      if (disposedRef.current) return;
      try {
        const token = await getToken();
        if (!token || disposedRef.current) return;
        socket = new WebSocket(chatSocketUrl(tripId));
        socket.onopen = () => socket?.send(JSON.stringify({ type: 'auth', token }));
        socket.onmessage = (message) => {
          try { handleEvent(JSON.parse(String(message.data)) as ChatEvent); } catch { /* ignore */ }
        };
        socket.onerror = () => setConnected(false);
        socket.onclose = (event) => {
          setConnected(false);
          if (![4401, 4403, 4404].includes(event.code)) scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      }
    }

    connect();
    return () => {
      disposedRef.current = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      setConnected(false);
    };
  }, [catchUp, commitMessages, markThrough, refreshUnread, tripId, userId]);

  return {
    messages,
    unreadCount,
    loading,
    loadingOlder,
    hasMoreBefore,
    connected,
    refreshUnread,
    loadLatest,
    loadOlder,
    send,
    retry,
    edit,
    remove,
    clear,
    markThrough,
  };
}
