import * as Clipboard from 'expo-clipboard';
import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  getTripInviteLink,
  resetTripInviteLink,
  type TripInviteLink,
} from './api';
import ConfirmModal from './ConfirmModal';
import T from './T';
import { useTheme } from './ThemeContext';
import { Button, Card, useToast } from './ui';
import { FONTS, RADIUS, SPACING } from './theme';


type Props = {
  tripId: string;
  canReset: boolean;
  onShare: (url: string) => Promise<void>;
};

export default function InviteLinksPanel({ tripId, canReset, onShare }: Props) {
  const { colors } = useTheme();
  const toast = useToast();
  const [invite, setInvite] = useState<TripInviteLink | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInvite(await getTripInviteLink(tripId));
      setError(null);
    } catch (requestError: any) {
      setInvite(null);
      setError(requestError.message || 'Could not load the trip link');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { void load(); }, [load]);

  const copy = async () => {
    if (!invite) return;
    try {
      await Clipboard.setStringAsync(invite.url);
      toast.show('Link copied.', 'success');
    } catch {
      toast.show('Could not copy the link.', 'error');
    }
  };

  const share = async () => {
    if (!invite || sharing) return;
    setSharing(true);
    try {
      await onShare(invite.url);
    } finally {
      setSharing(false);
    }
  };

  const reset = async () => {
    setConfirmReset(false);
    setResetting(true);
    try {
      setInvite(await resetTripInviteLink(tripId));
      setError(null);
      toast.show('New trip link ready.', 'success');
    } catch (requestError: any) {
      toast.show(requestError.message || 'Could not reset the trip link.', 'error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <Card testID="trip-invite-link" style={styles.panel}>
        <View style={styles.heading}>
          <T variant="h3">Trip invite link</T>
          <T variant="caption" muted>
            Share this link with people joining the trip.
          </T>
        </View>

        {loading ? (
          <View
            testID="trip-invite-link-loading"
            style={[styles.linkBox, { backgroundColor: colors.surfaceMuted }]}
          >
            <T variant="caption" muted>Loading trip link…</T>
          </View>
        ) : error ? (
          <View testID="trip-invite-link-error" style={styles.errorState}>
            <T variant="caption" color={colors.danger}>{error}</T>
            <Button label="Try again" variant="ghost" size="sm" onPress={() => { void load(); }} />
          </View>
        ) : invite ? (
          <>
            <View style={[styles.linkBox, { backgroundColor: colors.surfaceMuted }]}>
              <T
                selectable
                variant="caption"
                testID="trip-invite-link-url"
                style={styles.linkText}
              >
                {invite.url}
              </T>
            </View>

            <View style={styles.actions}>
              <View style={styles.action}>
                <Button
                  label="Copy link"
                  icon="copy"
                  variant="secondary"
                  onPress={() => { void copy(); }}
                  fullWidth
                  testID="invite-copy-link"
                />
              </View>
              <View style={styles.action}>
                <Button
                  label="Share link"
                  icon="share"
                  onPress={() => { void share(); }}
                  loading={sharing}
                  fullWidth
                  testID="invite-share-link"
                />
              </View>
            </View>
          </>
        ) : null}

        {canReset && invite && !loading ? (
          <View style={styles.resetAction}>
            <Button
              label="Reset link"
              variant="ghost"
              size="sm"
              loading={resetting}
              onPress={() => setConfirmReset(true)}
              testID="invite-reset-link"
            />
          </View>
        ) : null}
      </Card>

      <ConfirmModal
        visible={confirmReset}
        title="Reset trip link?"
        message="The current link will stop working immediately. Existing trip members will keep their access."
        onRequestClose={() => setConfirmReset(false)}
        actions={[
          { label: 'Reset link', variant: 'destructive', onPress: () => { void reset(); }, testID: 'invite-reset-confirm' },
          { label: 'Keep link', variant: 'cancel', onPress: () => setConfirmReset(false), testID: 'invite-reset-cancel' },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  panel: { gap: SPACING.md },
  heading: { gap: SPACING.xs },
  linkBox: {
    minHeight: 54,
    borderRadius: RADIUS.md,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
  },
  linkText: { fontFamily: FONTS.bodyMedium },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm },
  action: { flexGrow: 1, flexBasis: 140, minWidth: 0 },
  resetAction: { alignItems: 'flex-end', marginTop: -SPACING.xs },
  errorState: { alignItems: 'flex-start', gap: SPACING.xs },
});
