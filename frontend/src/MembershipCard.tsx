import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';

import Badge from './Badge';
import ConfirmModal from './ConfirmModal';
import T from './T';
import { useTheme } from './ThemeContext';
import {
  getMembershipLeaveImpact,
  leaveTripMembership,
  type DepartureBlocker,
  type TripDeletionImpact,
} from './api';
import { exactPositionLabel, primaryResolution } from './departure';
import { SPACING } from './theme';
import { Button, Card, Icon, SkeletonBox, useToast } from './ui';


type DepartureChoice = 'leave' | 'dissolve_family';


function ResolutionButton({ blocker, tripId }: { blocker: DepartureBlocker; tripId: string }) {
  const router = useRouter();
  const label = blocker.resolution === 'resolve_payment'
    ? 'Resolve payment'
    : blocker.resolution === 'settle_up'
      ? 'Settle up'
      : blocker.resolution === 'delete_trip_first'
        ? 'Delete trip first'
        : 'Refresh membership';
  const route = blocker.resolution === 'resolve_payment' || blocker.resolution === 'settle_up'
    ? `/trip/${tripId}/settle-up`
    : `/trip/${tripId}`;
  if (blocker.resolution === 'keep_family' || blocker.resolution === 'none') return null;
  return (
    <Button
      label={label}
      variant="secondary"
      size="sm"
      onPress={() => router.push(route as Href)}
      testID={`membership-${blocker.resolution}`}
    />
  );
}


export default function MembershipCard({ tripId }: { tripId: string }) {
  const router = useRouter();
  const { colors } = useTheme();
  const toast = useToast();
  const [impact, setImpact] = useState<TripDeletionImpact | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<DepartureChoice | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setImpact(await getMembershipLeaveImpact(tripId));
    } catch (reason: any) {
      setError(reason?.message || 'Could not load your membership.');
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const confirmDeparture = useCallback(async () => {
    if (!choice) return;
    setSubmitting(true);
    try {
      await leaveTripMembership(tripId, choice === 'dissolve_family');
      setChoice(null);
      router.replace('/(tabs)/trips');
    } catch (reason: any) {
      setChoice(null);
      toast.show(reason?.message || 'Could not leave this trip.', 'error');
      if (reason?.status === 409) await load();
    } finally {
      setSubmitting(false);
    }
  }, [choice, load, router, toast, tripId]);

  if (loading && !impact) {
    return (
      <Card testID="membership-impact-loading" style={styles.card}>
        <SkeletonBox width="42%" height={18} />
        <SkeletonBox width="72%" height={14} />
        <SkeletonBox width="100%" height={48} />
      </Card>
    );
  }

  if (error && !impact) {
    return (
      <Card testID="membership-impact-error" style={styles.card}>
        <View style={styles.headingRow}>
          <Icon name="alert" size={19} color={colors.warning} />
          <T variant="h4" style={styles.flexCopy}>Your membership</T>
        </View>
        <T variant="caption" muted>{error}</T>
        <Button label="Try again" icon="retry" size="sm" variant="secondary"
          onPress={() => void load()} testID="membership-impact-retry" />
      </Card>
    );
  }

  if (!impact) return null;
  const identity = impact.identity?.type === 'family_member'
    ? `${impact.identity.member_name} in ${impact.identity.family_name}`
    : impact.identity?.member_name ?? 'Identity needs review';
  const resolution = primaryResolution(impact.blockers);

  return (
    <>
      <Card testID="trip-membership-card" style={styles.card}>
        <View style={styles.headingRow}>
          <View style={styles.flexCopy}>
            <T variant="h4">Your membership</T>
            <T variant="caption" muted>{identity}</T>
          </View>
          <Badge
            label={impact.settled ? 'Settled' : 'Unsettled'}
            color={impact.settled ? colors.success : colors.warning}
          />
        </View>

        <View style={styles.positionRow}>
          <T variant="caption" muted style={styles.flexCopy}>Your position</T>
          <T style={styles.position} testID="membership-position">
            {exactPositionLabel(impact.position, impact.currency)}
          </T>
        </View>
        {impact.family_position != null ? (
          <View style={styles.positionRow}>
            <T variant="caption" muted style={styles.flexCopy}>Family total</T>
            <T style={styles.position} testID="membership-family-position">
              {exactPositionLabel(impact.family_position, impact.currency)}
            </T>
          </View>
        ) : null}

        {impact.ownership.transfer_required ? (
          <View style={styles.messageRow} testID="membership-ownership">
            <Icon name={impact.ownership.successor ? 'shield-check' : 'alert'} size={16}
              color={impact.ownership.successor ? colors.primary : colors.danger} />
            <T variant="caption" style={styles.flexCopy}>
              {impact.ownership.successor
                ? `Ownership will transfer to ${impact.ownership.successor.name}.`
                : 'No linked account can take ownership. Delete this trip first.'}
            </T>
          </View>
        ) : null}

        {impact.blockers
          .filter((blocker) => blocker.actions.includes('leave'))
          .map((blocker, index) => (
            <View key={`${blocker.code}-${index}`} style={styles.messageRow}>
              <Icon name="info" size={16} color={colors.textMuted} />
              <T variant="caption" muted style={styles.flexCopy}>{blocker.message}</T>
            </View>
          ))}

        <View style={styles.actions}>
          {impact.leave_eligible ? (
            <Button
              label="Leave trip"
              variant="secondary"
              size="sm"
              onPress={() => setChoice('leave')}
              disabled={submitting}
              testID="membership-leave"
              accessibilityLabel="Leave this trip"
            />
          ) : null}
          {impact.dissolve_family_eligible ? (
            <Button
              label={impact.requires_family_dissolution ? 'Leave and dissolve family' : 'Dissolve family'}
              variant="destructive"
              size="sm"
              onPress={() => setChoice('dissolve_family')}
              disabled={submitting}
              testID="membership-dissolve-family"
            />
          ) : null}
          {!impact.leave_eligible && !impact.dissolve_family_eligible && resolution ? (
            <ResolutionButton blocker={resolution} tripId={tripId} />
          ) : null}
        </View>
      </Card>

      <ConfirmModal
        visible={choice !== null}
        testID="membership-leave-confirm"
        title={choice === 'dissolve_family' ? 'Dissolve this family and leave?' : 'Leave this trip?'}
        message={choice === 'dissolve_family'
          ? 'The settled family will be removed from the roster. Financial history remains in trip records.'
          : 'Your settled identity will be removed. Financial history remains in trip records.'}
        onRequestClose={() => !submitting && setChoice(null)}
        actions={[
          {
            label: 'Cancel',
            variant: 'cancel',
            onPress: () => setChoice(null),
            disabled: submitting,
            testID: 'membership-leave-cancel',
          },
          {
            label: choice === 'dissolve_family' ? 'Dissolve and leave' : 'Leave trip',
            variant: 'destructive',
            onPress: () => void confirmDeparture(),
            disabled: submitting,
            testID: 'membership-leave-confirm-action',
          },
        ]}
      />
    </>
  );
}


const styles = StyleSheet.create({
  card: { gap: SPACING.sm },
  headingRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  flexCopy: { flex: 1, minWidth: 0 },
  positionRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  position: { fontVariant: ['tabular-nums'] },
  messageRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, marginTop: SPACING.xs },
});
