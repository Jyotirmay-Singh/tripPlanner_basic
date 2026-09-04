import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import ConfirmModal from './ConfirmModal';
import T from './T';
import { useTheme } from './ThemeContext';
import {
  chatMessageKey,
  chatDateKey,
  formatChatClock,
  formatChatDate,
  senderLabel,
  type ChatConnectionState,
  type LocalChatMessage,
} from './chat';
import { initials } from './initials';
import {
  CONTENT_MAX_WIDTH,
  FONTS,
  RADIUS,
  SPACING,
  TYPESCALE,
} from './theme';
import type { TripChatController } from './useTripChat';
import { ActionSheet, Button, Icon, IconButton, useToast } from './ui';

type Props = {
  header: React.ReactNode;
  controller: TripChatController;
  currentUserId?: string;
  isOwner: boolean;
  canSend: boolean;
  focusMessageId?: string;
};

type ConfirmState = { kind: 'message'; messageId: string } | { kind: 'history' } | null;

const CONNECTION_LABELS: Record<ChatConnectionState['status'], string> = {
  connecting: 'Connecting',
  connected: 'Live',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  authentication_required: 'Sign in required',
  permission_denied: 'Access removed',
  unavailable: 'Chat unavailable',
};

export default function TripChat({
  header,
  controller,
  currentUserId,
  isOwner,
  canSend,
  focusMessageId,
}: Props) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const toast = useToast();
  const listRef = useRef<FlatList<LocalChatMessage>>(null);
  const initialScrollDone = useRef(false);
  const nearBottom = useRef(true);
  const lastMarked = useRef(0);
  const controllerRef = useRef(controller);
  const focusedMessageId = useRef<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<LocalChatMessage | null>(null);
  const [selected, setSelected] = useState<LocalChatMessage | null>(null);
  const [showOwnerActions, setShowOwnerActions] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmState>(null);
  const [showJump, setShowJump] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { connection } = controller;
  const permanentlyUnavailable = connection.status === 'unavailable' && connection.attempt === 0;
  const composerBlocked = connection.status === 'authentication_required'
    || connection.status === 'permission_denied'
    || permanentlyUnavailable;
  const composerEnabled = canSend && !composerBlocked;
  const canManuallyReconnect = connection.status === 'reconnecting'
    || (connection.status === 'unavailable' && connection.attempt > 0);
  const connectionDescription = (() => {
    switch (connection.status) {
      case 'connecting': return 'Connecting to the trip conversation.';
      case 'connected': return 'Everyone linked to this trip can join the conversation.';
      case 'reconnecting': return 'Connection interrupted. Messages remain available while chat reconnects.';
      case 'offline': return 'You are offline. Unsent messages stay on this device for retry.';
      case 'authentication_required': return 'Sign in again to continue using Trip Chat.';
      case 'permission_denied': return 'Your account no longer has access to this trip conversation.';
      case 'unavailable': return connection.reason === 'configuration'
        ? 'The connected server does not support this version of Trip Chat.'
        : 'The chat service could not be reached. You can try connecting again.';
      default: return 'Everyone linked to this trip can join the conversation.';
    }
  })();
  const composerNotice = !canSend
    ? 'Your account is not linked to a named person in this trip.'
    : connection.status === 'authentication_required'
      ? 'Sign in again before sending a message.'
      : connection.status === 'permission_denied'
        ? 'You no longer have permission to send messages in this trip.'
        : permanentlyUnavailable
          ? 'Trip Chat is unavailable on the connected server.'
          : null;

  controllerRef.current = controller;

  useEffect(() => {
    if (!controller.messages.length) {
      initialScrollDone.current = false;
      setShowJump(false);
      return;
    }
    if (initialScrollDone.current && nearBottom.current) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    } else if (initialScrollDone.current) {
      setShowJump(true);
    }
  }, [controller.messages.length]);

  useEffect(() => {
    if (!focusMessageId || focusedMessageId.current === focusMessageId) return;
    const index = controller.messages.findIndex((message) => message.id === focusMessageId);
    if (index < 0) return;
    focusedMessageId.current = focusMessageId;
    nearBottom.current = index === controller.messages.length - 1;
    requestAnimationFrame(() => listRef.current?.scrollToIndex({
      index, animated: false, viewPosition: 0.5,
    }));
  }, [controller.messages, focusMessageId]);

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    nearBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 120;
    if (nearBottom.current) setShowJump(false);
  };

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    const highest = viewableItems.reduce((value: number, item: any) => {
      const sequence = item.item?.delivery ? 0 : Number(item.item?.sequence) || 0;
      return Math.max(value, sequence);
    }, 0);
    if (highest > lastMarked.current) {
      lastMarked.current = highest;
      controllerRef.current.markThrough(highest).catch(() => {});
    }
  }).current;

  const submit = async () => {
    const text = draft.trim();
    if (!text || text.length > 2000 || submitting) return;
    setSubmitting(true);
    if (editing) {
      try {
        await controller.edit(editing.id, text);
        setEditing(null);
        setDraft('');
      } catch (error: any) {
        toast.show(error?.message || 'Could not update the message', 'error');
      } finally {
        setSubmitting(false);
      }
      return;
    }
    try {
      const result = await controller.send(text);
      if (result.created) {
        setDraft('');
        requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
      }
      if (!result.sent && result.error) {
        const message = connection.status === 'offline' && result.created
          ? 'Message queued. Retry when you are back online.'
          : result.error;
        toast.show(message, 'error');
      }
    } catch (error: any) {
      toast.show(error?.message || 'Message not sent.', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const startEdit = () => {
    if (!selected?.text) return;
    setEditing(selected);
    setDraft(selected.text);
    setSelected(null);
  };

  const performDelete = async () => {
    if (confirm?.kind !== 'message') return;
    const messageId = confirm.messageId;
    setConfirm(null);
    try {
      await controller.remove(messageId);
    } catch (error: any) {
      toast.show(error?.message || 'Could not delete the message', 'error');
    }
  };

  const performClear = async () => {
    setConfirm(null);
    try {
      await controller.clear();
      toast.show('Chat history cleared', 'success');
    } catch (error: any) {
      toast.show(error?.message || 'Could not clear chat history', 'error');
    }
  };

  const renderMessage = ({ item, index }: { item: LocalChatMessage; index: number }) => {
    const mine = item.sender_user_id === currentUserId;
    const previous = controller.messages[index - 1];
    const showDate = !previous || chatDateKey(previous.created_at) !== chatDateKey(item.created_at);
    const failed = item.delivery === 'failed';
    const pending = item.delivery === 'sending';
    const queued = item.delivery === 'queued';
    const canRetry = (failed || queued) && (item.failure?.retryable !== false || controller.connected);
    const label = senderLabel(item);
    return (
      <View style={styles.itemWrap}>
        {showDate ? (
          <View style={styles.dateRow}>
            <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
            <T variant="caption" muted style={styles.dateText}>{formatChatDate(item.created_at)}</T>
            <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
          </View>
        ) : null}
        <View style={[styles.messageRow, mine && styles.messageRowMine]}>
          {!mine ? (
            <View style={[styles.identityMark, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
              <T variant="caption" color={colors.primary} style={{ fontFamily: FONTS.bodyBold }}>
                {initials(item.sender_name)}
              </T>
            </View>
          ) : null}
          <Pressable
            disabled={!mine || !!item.deleted_at || !!item.delivery}
            onPress={() => setSelected(item)}
            onLongPress={() => setSelected(item)}
            accessibilityRole={mine && !item.deleted_at && !item.delivery ? 'button' : undefined}
            accessibilityLabel={mine ? `Message from ${label}. Open message actions` : `Message from ${label}`}
            accessibilityState={{ selected: item.id === focusMessageId }}
            testID={`chat-message-${item.id}`}
            style={[
              styles.bubble,
              {
                backgroundColor: mine ? colors.primary : colors.surface,
                borderColor: mine ? colors.primary : colors.border,
              },
              mine ? styles.bubbleMine : styles.bubbleOther,
              failed && { borderColor: colors.danger },
              item.id === focusMessageId && {
                borderColor: mine ? colors.primaryText : colors.primary,
                borderWidth: 2,
              },
            ]}
          >
            <View style={styles.senderLine}>
              <T
                variant="caption"
                numberOfLines={1}
                color={mine ? colors.primaryText : colors.primary}
                style={{ flexShrink: 1, fontFamily: FONTS.bodySemibold }}
              >
                {label}{mine ? ' · You' : ''}
              </T>
              {mine && !item.deleted_at && !item.delivery ? (
                <Icon name="more-vertical" size={14} color={colors.primaryText} />
              ) : null}
            </View>
            {item.deleted_at ? (
              <T
                color={mine ? colors.primaryText : colors.textMuted}
                style={{ fontStyle: 'italic', opacity: 0.75 }}
              >
                Message deleted
              </T>
            ) : (
              <T color={mine ? colors.primaryText : colors.textMain} style={styles.messageText}>
                {item.text}
              </T>
            )}
            <View style={styles.metaRow}>
              <T variant="caption" color={mine ? colors.primaryText : colors.textMuted} style={{ opacity: 0.72 }}>
                {formatChatClock(item.created_at)}{item.edited_at ? ' · edited' : ''}
              </T>
              {pending ? (
                <T variant="caption" color={colors.primaryText} style={{ opacity: 0.72 }}>Sending…</T>
              ) : null}
              {queued ? (
                <T variant="caption" color={colors.primaryText} style={{ opacity: 0.72 }}>Queued</T>
              ) : null}
              {failed && !canRetry ? (
                <T variant="caption" color={colors.primaryText} style={{ opacity: 0.72 }}>Not sent</T>
              ) : null}
              {canRetry ? (
                <Pressable
                  onPress={() => controller.retry(item).then((ok) => {
                    if (!ok) toast.show('Message still could not be sent', 'error');
                  }).catch((error: any) => {
                    toast.show(error?.message || 'Message still could not be sent', 'error');
                  })}
                  accessibilityRole="button"
                  accessibilityLabel="Retry sending message"
                  style={styles.retry}
                >
                  <Icon name="retry" size={13} color={colors.primaryText} />
                  <T variant="caption" color={colors.primaryText} style={{ fontFamily: FONTS.bodyBold }}>Retry</T>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
          {mine ? (
            <View style={[styles.identityMark, { backgroundColor: colors.primary, borderColor: colors.primary }]}>
              <T variant="caption" color={colors.primaryText} style={{ fontFamily: FONTS.bodyBold }}>
                {initials(item.sender_name)}
              </T>
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  const listHeader = (
    <View style={{ width: '100%', alignItems: 'center' }}>
      {header}
      <View style={[styles.chatHeader, { maxWidth: CONTENT_MAX_WIDTH }]}>
        <View style={{ flex: 1 }}>
          <View style={styles.chatTitleRow}>
            <T variant="h3">Trip chat</T>
            <View style={[
              styles.liveDot,
              { backgroundColor: controller.connected ? colors.success : composerBlocked ? colors.danger : colors.textMuted },
            ]} />
            <T variant="caption" muted>{CONNECTION_LABELS[connection.status]}</T>
            {canManuallyReconnect ? (
              <Pressable
                onPress={controller.reconnect}
                accessibilityRole="button"
                accessibilityLabel="Try connecting to Trip Chat again"
                testID="chat-reconnect"
              >
                <T variant="caption" color={colors.primary} style={{ fontFamily: FONTS.bodyBold }}>Try again</T>
              </Pressable>
            ) : null}
          </View>
          <T variant="caption" muted>{connectionDescription}</T>
        </View>
        {isOwner ? (
          <IconButton
            name="more-vertical"
            variant="surface"
            onPress={() => setShowOwnerActions(true)}
            accessibilityLabel="Chat options"
            testID="chat-owner-options"
          />
        ) : null}
      </View>
      {controller.hasMoreBefore ? (
        <Button
          label="Load earlier messages"
          icon="refresh"
          variant="ghost"
          size="sm"
          loading={controller.loadingOlder}
          onPress={() => controller.loadOlder().catch((error: any) => {
            toast.show(error?.message || 'Could not load earlier messages', 'error');
          })}
          testID="chat-load-older"
        />
      ) : null}
      {controller.loading ? <ActivityIndicator color={colors.primary} style={{ marginVertical: SPACING.lg }} /> : null}
      {!controller.loading && controller.messages.length === 0 ? (
        <View style={[styles.empty, { borderColor: colors.border, backgroundColor: colors.surface }]} testID="chat-empty">
          <View style={[styles.emptyMark, { backgroundColor: colors.surfaceMuted }]}>
            <Icon name="chat" size={28} color={colors.primary} />
          </View>
          <T variant="h3" style={{ marginTop: SPACING.md }}>Start the trip conversation</T>
          <T muted style={{ textAlign: 'center', marginTop: SPACING.xs }}>
            Coordinate arrivals, plans, and reminders in one place.
          </T>
        </View>
      ) : null}
    </View>
  );

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <FlatList
        ref={listRef}
        data={controller.messages}
        keyExtractor={chatMessageKey}
        renderItem={renderMessage}
        ListHeaderComponent={listHeader}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
        onScroll={onScroll}
        scrollEventThrottle={100}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          listRef.current?.scrollToOffset({
            offset: Math.max(0, index * averageItemLength), animated: false,
          });
        }}
        onContentSizeChange={() => {
          if (!initialScrollDone.current && controller.messages.length) {
            initialScrollDone.current = true;
            listRef.current?.scrollToEnd({ animated: false });
          }
        }}
        onLayout={() => {
          if (initialScrollDone.current && nearBottom.current) {
            requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: false }));
          }
        }}
        testID="trip-chat-list"
      />

      {showJump ? (
        <Pressable
          onPress={() => {
            listRef.current?.scrollToEnd({ animated: true });
            nearBottom.current = true;
            setShowJump(false);
          }}
          accessibilityRole="button"
          style={[styles.jump, { backgroundColor: colors.primary }]}
        >
          <T variant="caption" color={colors.primaryText} style={{ fontFamily: FONTS.bodyBold }}>New messages ↓</T>
        </Pressable>
      ) : null}

      <View style={[
        styles.composerShell,
        {
          backgroundColor: colors.background,
          borderTopColor: colors.border,
          paddingBottom: insets.bottom + SPACING.sm,
        },
      ]}>
        <View style={[styles.composerInner, { maxWidth: CONTENT_MAX_WIDTH }]}>
          {editing ? (
            <View style={[styles.editingBar, { backgroundColor: colors.surfaceMuted }]}>
              <View style={{ flex: 1 }}>
                <T variant="caption" color={colors.primary} style={{ fontFamily: FONTS.bodyBold }}>Editing message</T>
                <T variant="caption" muted numberOfLines={1}>{editing.text}</T>
              </View>
              <IconButton
                name="close"
                onPress={() => { setEditing(null); setDraft(''); }}
                accessibilityLabel="Cancel editing"
                size={18}
              />
            </View>
          ) : null}
          {composerNotice ? (
            <T variant="caption" color={colors.danger} style={{ marginBottom: SPACING.xs }}>
              {composerNotice}
            </T>
          ) : null}
          <View style={[styles.composer, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder="Message the trip…"
              placeholderTextColor={colors.textMuted}
              multiline
              maxLength={2000}
              editable={composerEnabled}
              accessibilityLabel={editing ? 'Edit message' : 'Message the trip'}
              style={[styles.input, { color: colors.textMain }]}
              onFocus={() => {
                if (nearBottom.current) {
                  requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
                }
              }}
              onKeyPress={(event: any) => {
                if (Platform.OS === 'web' && event.nativeEvent.key === 'Enter' && !event.nativeEvent.shiftKey) {
                  event.preventDefault?.();
                  submit();
                }
              }}
              testID="chat-composer"
            />
            <IconButton
              name={editing ? 'check' : 'send'}
              variant="primary"
              onPress={submit}
              disabled={submitting || !composerEnabled || !draft.trim() || draft.trim().length > 2000}
              accessibilityLabel={editing ? 'Save message changes' : 'Send message'}
              testID="chat-send"
            />
          </View>
          {draft.length >= 1800 ? (
            <T variant="caption" muted style={{ textAlign: 'right', marginTop: 2 }}>{draft.length}/2000</T>
          ) : null}
        </View>
      </View>

      <ActionSheet
        visible={!!selected}
        onClose={() => setSelected(null)}
        title="Your message"
        actions={[
          { label: 'Edit message', icon: 'pencil', onPress: startEdit },
          {
            label: 'Delete message', icon: 'trash', variant: 'destructive',
            onPress: () => {
              if (selected) setConfirm({ kind: 'message', messageId: selected.id });
              setSelected(null);
            },
          },
        ]}
        testID="chat-message-actions"
      />

      <ActionSheet
        visible={showOwnerActions}
        onClose={() => setShowOwnerActions(false)}
        title="Chat options"
        message="Only the trip owner can clear the conversation for everyone."
        actions={[
          {
            label: 'Clear chat history', icon: 'trash', variant: 'destructive',
            onPress: () => { setShowOwnerActions(false); setConfirm({ kind: 'history' }); },
          },
        ]}
        testID="chat-owner-actions"
      />

      <ConfirmModal
        visible={!!confirm}
        title={confirm?.kind === 'history' ? 'Clear chat history?' : 'Delete message?'}
        message={confirm?.kind === 'history'
          ? 'This permanently removes every existing message for all trip members.'
          : 'The original text will be removed and replaced with “Message deleted”.'}
        onRequestClose={() => setConfirm(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirm(null) },
          {
            label: confirm?.kind === 'history' ? 'Clear chat' : 'Delete message',
            variant: 'destructive',
            onPress: confirm?.kind === 'history' ? performClear : performDelete,
          },
        ]}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingBottom: SPACING.xl },
  chatHeader: {
    width: '100%', paddingHorizontal: SPACING.lg, paddingTop: SPACING.lg,
    paddingBottom: SPACING.sm, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
  },
  chatTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  liveDot: { width: 8, height: 8, borderRadius: 4 },
  itemWrap: { width: '100%', maxWidth: CONTENT_MAX_WIDTH, alignSelf: 'center', paddingHorizontal: SPACING.lg },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, marginVertical: SPACING.lg },
  dateLine: { flex: 1, height: StyleSheet.hairlineWidth },
  dateText: { fontFamily: FONTS.bodySemibold },
  messageRow: { flexDirection: 'row', alignItems: 'flex-end', gap: SPACING.sm, marginBottom: SPACING.sm },
  messageRowMine: { justifyContent: 'flex-end' },
  identityMark: {
    width: 34, height: 34, borderRadius: 17, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center', marginBottom: 2,
  },
  bubble: { maxWidth: '78%', minWidth: 136, padding: SPACING.md, borderWidth: 1 },
  bubbleMine: { borderRadius: RADIUS.lg, borderBottomRightRadius: RADIUS.sm },
  bubbleOther: { borderRadius: RADIUS.lg, borderBottomLeftRadius: RADIUS.sm },
  senderLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  messageText: { marginTop: 3, fontSize: TYPESCALE.md, lineHeight: 22 },
  metaRow: { marginTop: 5, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  empty: {
    width: '100%', maxWidth: CONTENT_MAX_WIDTH - SPACING.lg * 2, alignItems: 'center',
    marginTop: SPACING.lg, padding: SPACING.xl, borderWidth: 1, borderRadius: RADIUS.lg,
  },
  emptyMark: { width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center' },
  jump: {
    position: 'absolute', alignSelf: 'center', bottom: 92, paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm, borderRadius: RADIUS.pill,
  },
  composerShell: { borderTopWidth: 1, paddingHorizontal: SPACING.md, paddingTop: SPACING.sm },
  composerInner: { width: '100%', alignSelf: 'center' },
  composer: {
    minHeight: 54, maxHeight: 132, borderWidth: 1, borderRadius: RADIUS.xl,
    flexDirection: 'row', alignItems: 'flex-end', paddingLeft: SPACING.md, paddingRight: 5, paddingVertical: 5,
  },
  input: { flex: 1, minHeight: 42, maxHeight: 112, fontFamily: FONTS.body, fontSize: TYPESCALE.md, paddingVertical: 9 },
  editingBar: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    borderRadius: RADIUS.md, paddingLeft: SPACING.md, marginBottom: SPACING.sm,
  },
});
