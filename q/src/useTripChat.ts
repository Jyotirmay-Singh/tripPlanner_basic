import NetInfo from '@react-native-community/netinfo';
import * as Crypto from 'expo-crypto';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

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
  chatMessageKey,
  classifyChatError,
  type ChatCapability,
  type ChatConnectionState,
  type ChatEvent,
  type ChatFailure,
  type ChatMessage,
  type ChatSender,
  type LocalChatMessage,
  mergeChatEvent,
  mergeChatMessages,
  offlineChatFailure,
  reconnectDelay,
} from './chat';
import {
  ChatOutboxFullError,
  enqueueChatOutbox,
  loadChatOutbox,
  removeChatOutboxMessage,
  saveChatOutbox,
} from './chatOutbox';

const HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const UNAVAILABLE_PROBE_MS = 30_000;
const MAX_VISIBLE_RECONNECT_ATTEMPTS = 5;

type Options = {
  tripId: string;
  userId?: string;
  sender: ChatSender | null;
  active: boolean;
  capability?: ChatCapability;
  onAuthenticationRequired?: () => void | Promise<void>;
};

export type ChatSendResult = {
  created: boolean;
  sent: boolean;
  error?: string;
};

export type TripChatController = {
  messages: LocalChatMessage[];
  unreadCount: number;
  loading: boolean;
  loadingOlder: boolean;
  hasMoreBefore: boolean;
  connected: boolean;
  connection: ChatConnectionState;
  refreshUnread: () => Promise<void>;
  loadLatest: () => Promise<void>;
  loadOlder: () => Promise<void>;
  reconnect: () => void;
  send: (text: string) => Promise<ChatSendResult>;
  retry: (message: LocalChatMessage) => Promise<boolean>;
  edit: (messageId: string, text: string) => Promise<void>;
  remove: (messageId: string) => Promise<void>;
  clear: () => Promise<void>;
  markThrough: (sequence: number) => Promise<void>;
};

function chatDiagnostic(event: string, data: Record<string, unknown> = {}): void {
  if (__DEV__) console.warn(`[trip-chat] ${event}`, data);
}

function isOnlineState(state: { isConnected: boolean | null; isInternetReachable: boolean | null }): boolean {
  return state.isConnected !== false && state.isInternetReachable !== false;
}

function terminalStateForFailure(failure: ChatFailure): ChatConnectionState | null {
  if (failure.code === 'authentication_required') {
    return { status: 'authentication_required', attempt: 0, reason: failure.code };
  }
  if (failure.code === 'permission_denied') {
    return { status: 'permission_denied', attempt: 0, reason: failure.code };
  }
  if (failure.code === 'unavailable' || failure.code === 'configuration') {
    return { status: 'unavailable', attempt: 0, reason: failure.code };
  }
  return null;
}

export function useTripChat({
  tripId,
  userId,
  sender,
  active,
  capability = 'supported',
  onAuthenticationRequired,
}: Options): TripChatController {
  const [messages, setMessages] = useState<LocalChatMessage[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreBefore, setHasMoreBefore] = useState(false);
  const [connection, setConnection] = useState<ChatConnectionState>({
    status: capability === 'unsupported' ? 'unavailable' : 'connecting',
    attempt: 0,
    reason: capability === 'unsupported' ? 'configuration' : undefined,
  });
  const messagesRef = useRef<LocalChatMessage[]>([]);
  const activeRef = useRef(active);
  const onlineRef = useRef(true);
  const connectionRef = useRef(connection);
  const terminalRef = useRef(capability === 'unsupported');
  const outboxHydratedRef = useRef(false);
  const sendLockedRef = useRef(false);
  const inFlightRef = useRef(new Map<string, Promise<boolean>>());
  const reconnectRef = useRef<() => void>(() => {});
  const authenticationHandlerRef = useRef(onAuthenticationRequired);

  const updateConnection = useCallback((next: ChatConnectionState) => {
    connectionRef.current = next;
    setConnection(next);
  }, []);

  const commitMessages = useCallback((updater: (current: LocalChatMessage[]) => LocalChatMessage[]) => {
    setMessages((current) => {
      const next = updater(current);
      messagesRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { authenticationHandlerRef.current = onAuthenticationRequired; }, [onAuthenticationRequired]);

  useEffect(() => {
    let cancelled = false;
    outboxHydratedRef.current = false;
    commitMessages(() => []);
    if (!tripId || !userId) return () => { cancelled = true; };
    loadChatOutbox(userId, tripId)
      .then((stored) => {
        if (cancelled) return;
        commitMessages((current) => mergeChatMessages(current, stored));
        outboxHydratedRef.current = true;
      })
      .catch(() => {
        if (!cancelled) outboxHydratedRef.current = true;
      });
    return () => { cancelled = true; };
  }, [commitMessages, tripId, userId]);

  useEffect(() => {
    if (!outboxHydratedRef.current || !tripId || !userId) return;
    saveChatOutbox(userId, tripId, messages).catch(() => {
      chatDiagnostic('outbox_save_failed', { tripId });
    });
  }, [messages, tripId, userId]);

  const applyAuthoritative = useCallback((incoming: ChatMessage[]) => {
    if (!incoming.length) return;
    commitMessages((current) => mergeChatMessages(current, incoming));
    if (userId) {
      for (const message of incoming) {
        if (message.sender_user_id === userId) {
          void removeChatOutboxMessage(userId, tripId, message.client_message_id);
        }
      }
    }
  }, [commitMessages, tripId, userId]);

  const applyConnectionFailure = useCallback((failure: ChatFailure) => {
    const terminal = terminalStateForFailure(failure);
    if (!terminal) return;
    terminalRef.current = true;
    updateConnection(terminal);
    if (failure.code === 'authentication_required') {
      void authenticationHandlerRef.current?.();
    }
  }, [updateConnection]);

  const refreshUnread = useCallback(async () => {
    if (!tripId || !userId || capability === 'loading' || capability === 'unsupported') return;
    try {
      const result = await chatUnread(tripId);
      setUnreadCount(Number(result?.count) || 0);
    } catch (error) {
      applyConnectionFailure(classifyChatError(error));
    }
  }, [applyConnectionFailure, capability, tripId, userId]);

  const markThrough = useCallback(async (sequence: number) => {
    if (!tripId || !userId || !Number.isFinite(sequence) || sequence <= 0) return;
    await markChatRead(tripId, sequence);
    setUnreadCount(0);
  }, [tripId, userId]);

  const loadLatest = useCallback(async () => {
    if (!tripId || !userId || capability === 'loading') return;
    if (capability === 'unsupported') {
      applyConnectionFailure({
        code: 'unavailable', retryable: false,
        message: 'This server does not support Trip Chat.',
      });
      return;
    }
    setLoading(true);
    try {
      const page = await listChatMessages(tripId, { limit: 50 });
      commitMessages((current) => {
        const stillVisible = current.filter((message) => (
          !!message.delivery || message.sequence > (page.cleared_through_sequence ?? 0)
        ));
        return mergeChatMessages(stillVisible, page.items ?? []);
      });
      applyAuthoritative(page.items ?? []);
      setHasMoreBefore(!!page.has_more_before);
      const last = page.items?.[page.items.length - 1];
      if (activeRef.current && last) await markThrough(last.sequence);
      else await refreshUnread();
    } catch (error) {
      applyConnectionFailure(classifyChatError(error));
      throw error;
    } finally {
      setLoading(false);
    }
  }, [
    applyAuthoritative, applyConnectionFailure, capability, commitMessages,
    markThrough, refreshUnread, tripId, userId,
  ]);

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
      applyAuthoritative(page.items ?? []);
      setHasMoreBefore(!!page.has_more_before);
    } catch (error) {
      applyConnectionFailure(classifyChatError(error));
      throw error;
    } finally {
      setLoadingOlder(false);
    }
  }, [applyAuthoritative, applyConnectionFailure, commitMessages, loadingOlder, tripId]);

  const persistPending = useCallback((pending: LocalChatMessage): Promise<boolean> => {
    const existing = inFlightRef.current.get(pending.client_message_id);
    if (existing) return existing;

    const operation = (async () => {
      const sending: LocalChatMessage = {
        ...pending,
        delivery: 'sending',
        error: undefined,
        failure: undefined,
      };
      commitMessages((current) => current.map((message) => (
        chatMessageKey(message) === chatMessageKey(sending) ? sending : message
      )));
      try {
        if (userId) await enqueueChatOutbox(userId, tripId, sending);
        const saved = await sendChatMessage(tripId, {
          client_message_id: pending.client_message_id,
          text: pending.text ?? '',
        });
        applyAuthoritative([saved]);
        chatDiagnostic('message_ack', {
          tripId,
          clientMessageId: saved.client_message_id,
          sequence: saved.sequence,
        });
        return true;
      } catch (error) {
        const failure = onlineRef.current ? classifyChatError(error) : offlineChatFailure();
        const delivery = failure.code === 'offline' ? 'queued' as const : 'failed' as const;
        commitMessages((current) => current.map((message) => (
          chatMessageKey(message) === chatMessageKey(pending)
            ? { ...message, delivery, error: failure.message, failure }
            : message
        )));
        applyConnectionFailure(failure);
        chatDiagnostic('message_failed', {
          tripId,
          clientMessageId: pending.client_message_id,
          code: failure.code,
          status: failure.status,
        });
        return false;
      }
    })().finally(() => {
      inFlightRef.current.delete(pending.client_message_id);
    });

    inFlightRef.current.set(pending.client_message_id, operation);
    return operation;
  }, [applyAuthoritative, applyConnectionFailure, commitMessages, tripId, userId]);

  const send = useCallback(async (rawText: string): Promise<ChatSendResult> => {
    const text = rawText.trim();
    if (sendLockedRef.current) {
      return { created: false, sent: false, error: 'A message is already being submitted.' };
    }
    if (!userId || !sender || !text || text.length > 2000) {
      return { created: false, sent: false, error: 'This message cannot be sent.' };
    }
    if (capability === 'unsupported' || connectionRef.current.status === 'authentication_required'
      || connectionRef.current.status === 'permission_denied') {
      return { created: false, sent: false, error: 'Trip chat is not available.' };
    }

    sendLockedRef.current = true;
    try {
      const clientId = Crypto.randomUUID();
      const offline = !onlineRef.current || connectionRef.current.status === 'offline';
      const failure = offline ? offlineChatFailure() : undefined;
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
        delivery: offline ? 'queued' : 'sending',
        error: failure?.message,
        failure,
      };
      try {
        await enqueueChatOutbox(userId, tripId, pending);
      } catch (error) {
        const message = error instanceof ChatOutboxFullError
          ? error.message
          : 'Could not preserve this message for retry.';
        return { created: false, sent: false, error: message };
      }
      commitMessages((current) => mergeChatMessages(current, [pending]));
      if (offline) return { created: true, sent: false, error: failure?.message };
      const sent = await persistPending(pending);
      const failed = messagesRef.current.find((message) => message.client_message_id === clientId);
      return { created: true, sent, error: sent ? undefined : failed?.error ?? 'Message not sent.' };
    } finally {
      sendLockedRef.current = false;
    }
  }, [capability, commitMessages, persistPending, sender, tripId, userId]);

  const retry = useCallback(async (message: LocalChatMessage): Promise<boolean> => {
    if (!message.text || !userId || message.sender_user_id !== userId) return false;
    if (!onlineRef.current || connectionRef.current.status === 'offline') {
      const failure = offlineChatFailure();
      const queued = { ...message, delivery: 'queued' as const, error: failure.message, failure };
      commitMessages((current) => current.map((item) => (
        chatMessageKey(item) === chatMessageKey(queued) ? queued : item
      )));
      await enqueueChatOutbox(userId, tripId, queued);
      return false;
    }
    if (message.failure?.retryable === false && connectionRef.current.status !== 'connected') {
      return false;
    }
    return persistPending(message);
  }, [commitMessages, persistPending, tripId, userId]);

  const edit = useCallback(async (messageId: string, text: string) => {
    const saved = await editChatMessage(tripId, messageId, text);
    applyAuthoritative([saved]);
  }, [applyAuthoritative, tripId]);

  const remove = useCallback(async (messageId: string) => {
    const saved = await deleteChatMessage(tripId, messageId);
    applyAuthoritative([saved]);
  }, [applyAuthoritative, tripId]);

  const clear = useCallback(async () => {
    const result = await clearChatHistory(tripId);
    commitMessages((current) => current.filter(
      (message) => !!message.delivery || message.sequence > result.cleared_through_sequence,
    ));
    setHasMoreBefore(false);
    setUnreadCount(0);
  }, [commitMessages, tripId]);

  const catchUp = useCallback(async () => {
    const persisted = messagesRef.current.filter((message) => !message.delivery && message.sequence > 0);
    let after = persisted.length ? persisted[persisted.length - 1].sequence : 0;
    for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
      const page = await listChatMessages(tripId, { afterSequence: after, limit: 100 });
      commitMessages((current) => current.filter((message) => (
        !!message.delivery || message.sequence > (page.cleared_through_sequence ?? 0)
      )));
      if (page.items?.length) {
        applyAuthoritative(page.items);
        after = page.items[page.items.length - 1].sequence;
      }
      if (!page.has_more_after) break;
    }
    if (activeRef.current && after > 0) await markThrough(after);
    else await refreshUnread();
  }, [applyAuthoritative, commitMessages, markThrough, refreshUnread, tripId]);

  useEffect(() => {
    if (active) loadLatest().catch(() => {});
  }, [active, loadLatest]);

  useEffect(() => {
    if (capability === 'loading') {
      terminalRef.current = false;
      updateConnection({ status: 'connecting', attempt: 0 });
      return () => {};
    }
    if (capability === 'unsupported') {
      terminalRef.current = true;
      updateConnection({ status: 'unavailable', attempt: 0, reason: 'configuration' });
      return () => {};
    }
    if (!tripId || !userId || typeof WebSocket === 'undefined' || typeof chatSocketUrl !== 'function') {
      return () => {};
    }

    let disposed = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let handshakeTimer: ReturnType<typeof setTimeout> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let pongTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let suppressClose = false;
    let foreground = AppState.currentState === 'active';
    terminalRef.current = false;

    const clearTimer = (timer: ReturnType<typeof setTimeout> | null) => {
      if (timer) clearTimeout(timer);
    };

    const clearConnectionTimers = () => {
      clearTimer(handshakeTimer);
      clearTimer(pongTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      handshakeTimer = null;
      heartbeatTimer = null;
      pongTimer = null;
    };

    const closeSocket = () => {
      clearConnectionTimers();
      if (!socket) return;
      suppressClose = true;
      socket.onclose = null;
      socket.onerror = null;
      socket.onmessage = null;
      try { socket.close(); } catch { /* already closed */ }
      socket = null;
      suppressClose = false;
    };

    const stop = (status: ChatConnectionState['status'], reason: ChatFailure['code']) => {
      terminalRef.current = true;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      closeSocket();
      updateConnection({ status, attempt, reason });
      if (status === 'authentication_required') {
        void authenticationHandlerRef.current?.();
      }
    };

    const scheduleReconnect = () => {
      if (disposed || terminalRef.current || !onlineRef.current || !foreground) return;
      clearTimer(reconnectTimer);
      attempt += 1;
      const unavailable = attempt >= MAX_VISIBLE_RECONNECT_ATTEMPTS;
      updateConnection({
        status: unavailable ? 'unavailable' : 'reconnecting',
        attempt,
        reason: unavailable ? 'unavailable' : 'network',
      });
      const delay = unavailable ? UNAVAILABLE_PROBE_MS : reconnectDelay(attempt - 1);
      chatDiagnostic('reconnect_scheduled', { tripId, attempt, delay });
      reconnectTimer = setTimeout(connect, delay);
    };

    const startHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => {
        if (!socket || socket.readyState !== WebSocket.OPEN || pongTimer) return;
        try {
          socket.send(JSON.stringify({ type: 'ping' }));
          pongTimer = setTimeout(() => {
            pongTimer = null;
            chatDiagnostic('heartbeat_timeout', { tripId });
            try { socket?.close(4000, 'heartbeat timeout'); } catch { scheduleReconnect(); }
          }, PONG_TIMEOUT_MS);
        } catch {
          try { socket.close(); } catch { scheduleReconnect(); }
        }
      }, HEARTBEAT_INTERVAL_MS);
    };

    const handleEvent = (event: ChatEvent) => {
      if (event.type === 'ready') {
        clearTimer(handshakeTimer);
        handshakeTimer = null;
        attempt = 0;
        terminalRef.current = false;
        updateConnection({ status: 'connected', attempt: 0 });
        startHeartbeat();
        chatDiagnostic('connected', { tripId });
        catchUp().catch((error) => {
          applyConnectionFailure(classifyChatError(error));
        });
        return;
      }
      if (event.type === 'pong') {
        clearTimer(pongTimer);
        pongTimer = null;
        return;
      }
      if (event.type === 'message.created') {
        commitMessages((current) => mergeChatEvent(current, event.data, userId));
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
          (message) => !!message.delivery || message.sequence > event.data.through_sequence,
        ));
        setHasMoreBefore(false);
        setUnreadCount(0);
      }
    };

    async function connect() {
      if (disposed || terminalRef.current || !onlineRef.current || !foreground) return;
      if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      try {
        const token = await getToken();
        if (disposed) return;
        if (!token) {
          stop('authentication_required', 'authentication_required');
          return;
        }
        updateConnection({
          status: attempt ? (attempt >= MAX_VISIBLE_RECONNECT_ATTEMPTS ? 'unavailable' : 'reconnecting') : 'connecting',
          attempt,
          reason: attempt ? 'network' : undefined,
        });
        socket = new WebSocket(chatSocketUrl(tripId));
        socket.onopen = () => {
          if (!socket || disposed) return;
          chatDiagnostic('socket_open', { tripId, attempt });
          try {
            socket.send(JSON.stringify({ type: 'auth', token }));
            handshakeTimer = setTimeout(() => {
              chatDiagnostic('handshake_timeout', { tripId, attempt });
              try { socket?.close(4001, 'ready timeout'); } catch { scheduleReconnect(); }
            }, HANDSHAKE_TIMEOUT_MS);
          } catch {
            chatDiagnostic('auth_frame_failed', { tripId, attempt });
            try { socket.close(4002, 'auth send failed'); } catch { scheduleReconnect(); }
          }
        };
        socket.onmessage = (message) => {
          try {
            handleEvent(JSON.parse(String(message.data)) as ChatEvent);
          } catch {
            chatDiagnostic('invalid_event', { tripId });
          }
        };
        socket.onerror = () => {
          chatDiagnostic('socket_error', { tripId, attempt });
        };
        socket.onclose = (event) => {
          clearConnectionTimers();
          socket = null;
          if (disposed || suppressClose) return;
          chatDiagnostic('socket_closed', { tripId, attempt, closeCode: event.code });
          if (event.code === 4401) stop('authentication_required', 'authentication_required');
          else if (event.code === 4403) stop('permission_denied', 'permission_denied');
          else if (event.code === 4404) stop('unavailable', 'unavailable');
          else scheduleReconnect();
        };
      } catch (error) {
        const failure = classifyChatError(error);
        const terminal = terminalStateForFailure(failure);
        if (terminal) stop(terminal.status, failure.code);
        else scheduleReconnect();
      }
    }

    reconnectRef.current = () => {
      if (connectionRef.current.status === 'authentication_required'
        || connectionRef.current.status === 'permission_denied') return;
      terminalRef.current = false;
      attempt = 0;
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      closeSocket();
      void connect();
    };

    const netSubscription = NetInfo.addEventListener((state) => {
      const wasOnline = onlineRef.current;
      const online = isOnlineState(state);
      onlineRef.current = online;
      if (!online) {
        closeSocket();
        updateConnection({ status: 'offline', attempt: 0, reason: 'offline' });
        return;
      }
      if (!wasOnline && foreground
        && connectionRef.current.status !== 'authentication_required'
        && connectionRef.current.status !== 'permission_denied') {
        terminalRef.current = false;
        attempt = 0;
        void connect();
      }
    });

    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      const wasForeground = foreground;
      foreground = nextState === 'active';
      if (!foreground) {
        closeSocket();
        return;
      }
      if (!wasForeground && onlineRef.current && !terminalRef.current) {
        attempt = 0;
        void connect();
      }
    });

    refreshUnread().catch(() => {});
    void connect();
    return () => {
      disposed = true;
      reconnectRef.current = () => {};
      clearTimer(reconnectTimer);
      reconnectTimer = null;
      closeSocket();
      netSubscription();
      appStateSubscription.remove();
    };
  }, [
    applyConnectionFailure, capability, catchUp, commitMessages, markThrough,
    refreshUnread, tripId, updateConnection, userId,
  ]);

  return {
    messages,
    unreadCount,
    loading,
    loadingOlder,
    hasMoreBefore,
    connected: connection.status === 'connected',
    connection,
    refreshUnread,
    loadLatest,
    loadOlder,
    reconnect: () => reconnectRef.current(),
    send,
    retry,
    edit,
    remove,
    clear,
    markThrough,
  };
}
