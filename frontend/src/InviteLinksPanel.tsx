import React, { useCallback, useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import {
  listTripInvites,
  revokeTripInvite,
  type TripInvite,
} from './api';
import Badge from './Badge';
import ConfirmModal from './ConfirmModal';
import T from './T';
import { useTheme } from './ThemeContext';
import { Button, Card, Icon } from './ui';
import { FONTS, SPACING } from './theme';


type Props = {
  tripId: string;
  refreshKey: number;
  onCreateAndShare: () => Promise<void>;
};

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return date.toLocaleString(undefined, {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function InviteLinksPanel({ tripId, refreshKey, onCreateAndShare }: Props) {
  const { colors } = useTheme();
  const [invites, setInvites] = useState<TripInvite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setInvites(await listTripInvites(tripId));
      setError(null);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not load invite links');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => { void load(); }, [load, refreshKey]);

  const revoke = async () => {
    if (!confirmId) return;
    const inviteId = confirmId;
    setConfirmId(null);
    setRevoking(inviteId);
    try {
      const updated = await revokeTripInvite(tripId, inviteId);
      setInvites((current) => current.map((item) => item.id === inviteId ? updated : item));
      setError(null);
    } catch (requestError: any) {
      setError(requestError.message || 'Could not revoke this invite');
    } finally {
      setRevoking(null);
    }
  };

  return (
    <>
      <Card testID="trip-invite-links" style={styles.panel}>
        <View style={styles.headingRow}>
          <View style={[styles.iconTile, { backgroundColor: colors.surfaceMuted }]}>
            <Icon name="share" size={18} color={colors.primary} />
          </View>
          <View style={styles.flex}>
            <T variant="h3">Invite links</T>
            <T variant="caption" muted>
              Your newest link replaces your previous one and expires after seven days.
            </T>
          </View>
        </View>

        <Button
          label="Create and share link"
          icon="share"
          onPress={() => { void onCreateAndShare(); }}
          fullWidth
          testID="invite-create-share"
        />

        {loading ? <T variant="caption" muted>Loading links…</T> : null}
        {error ? <T variant="caption" color={colors.danger}>{error}</T> : null}

        {!loading && invites.length === 0 ? (
          <T variant="caption" muted testID="invite-links-empty">
            No secure links have been created for this trip.
          </T>
        ) : null}

        {invites.map((invite, index) => (
          <View
            key={invite.id}
            testID={`invite-link-${invite.id}`}
            style={[
              styles.inviteRow,
              index > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <View style={styles.flex}>
              <View style={styles.statusRow}>
                <Badge
                  label={invite.status === 'active' ? 'Active' : invite.status === 'expired' ? 'Expired' : 'Revoked'}
                  color={invite.status === 'active' ? colors.success : colors.textMuted}
                />
                {invite.use_count > 0 ? (
                  <T variant="caption" muted>{invite.use_count} successful use{invite.use_count === 1 ? '' : 's'}</T>
                ) : null}
              </View>
              <T variant="caption" style={styles.dateText}>
                {invite.status === 'revoked'
                  ? `Revoked ${dateLabel(invite.revoked_at || invite.expires_at)}`
                  : `${invite.status === 'active' ? 'Expires' : 'Expired'} ${dateLabel(invite.expires_at)}`}
              </T>
              {invite.created_by_name ? (
                <T variant="caption" muted testID={`invite-creator-${invite.id}`}>
                  Created by {invite.created_by_name}
                </T>
              ) : null}
            </View>
            {invite.status === 'active' ? (
              <Button
                label="Revoke"
                variant="ghost"
                size="sm"
                loading={revoking === invite.id}
                onPress={() => setConfirmId(invite.id)}
                testID={`invite-revoke-${invite.id}`}
              />
            ) : null}
          </View>
        ))}
      </Card>

      <ConfirmModal
        visible={!!confirmId}
        title="Revoke invite link?"
        message="Anyone who has this link will no longer be able to use it. Existing trip members keep their access."
        onRequestClose={() => setConfirmId(null)}
        actions={[
          { label: 'Revoke link', variant: 'destructive', onPress: () => { void revoke(); }, testID: 'invite-revoke-confirm' },
          { label: 'Keep link', variant: 'cancel', onPress: () => setConfirmId(null), testID: 'invite-revoke-cancel' },
        ]}
      />
    </>
  );
}

const styles = StyleSheet.create({
  panel: { gap: SPACING.md },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  iconTile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, minWidth: 0 },
  inviteRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm, paddingTop: SPACING.md },
  statusRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm },
  dateText: { marginTop: SPACING.xs, fontFamily: FONTS.bodyMedium },
});
