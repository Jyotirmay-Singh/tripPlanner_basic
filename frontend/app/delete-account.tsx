import React, { useCallback, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';

import Badge from '../src/Badge';
import ConfirmModal from '../src/ConfirmModal';
import T from '../src/T';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import {
  deleteAccount,
  getAccountDeletionImpact,
  type AccountDeletionImpact,
  type DepartureBlocker,
  type TripDeletionAction,
  type TripDeletionImpact,
} from '../src/api';
import { AUTH_LOGIN_HREF, navResetTo } from '../src/authNav';
import {
  exactPositionLabel,
  primaryResolution,
  selectedTripsRequireAcknowledgement,
  TRIP_ACTION_LABELS,
} from '../src/departure';
import { FONTS, RADIUS, SPACING } from '../src/theme';
import {
  Button,
  Card,
  Icon,
  Input,
  Screen,
  SegmentedControl,
  SkeletonCard,
  useToast,
} from '../src/ui';


function BlockerAction({ blocker, tripId }: { blocker: DepartureBlocker; tripId: string }) {
  const router = useRouter();
  const route = blocker.resolution === 'settle_up' || blocker.resolution === 'resolve_payment'
    ? `/trip/${tripId}/settle-up`
    : `/trip/${tripId}?tab=members`;
  const label = blocker.resolution === 'resolve_payment'
    ? 'Resolve payment'
    : blocker.resolution === 'settle_up'
      ? 'Settle up'
      : blocker.resolution === 'delete_trip_first'
        ? 'Delete trip first'
        : 'Review membership';
  if (blocker.resolution === 'keep_family' || blocker.resolution === 'none') return null;
  return (
    <Button
      label={label}
      variant="secondary"
      size="sm"
      onPress={() => router.push(route as Href)}
      testID={`deletion-trip-${tripId}-${blocker.resolution}`}
      accessibilityLabel={`${label} for this trip`}
    />
  );
}


function TripReviewCard({
  trip,
  action,
  onAction,
}: {
  trip: TripDeletionImpact;
  action: TripDeletionAction;
  onAction: (action: TripDeletionAction) => void;
}) {
  const { colors } = useTheme();
  const segments = trip.available_actions.map((value) => ({
    value,
    label: TRIP_ACTION_LABELS[value],
  }));
  const actionBlockers = trip.blockers.filter((blocker) => blocker.actions.includes(action));
  const resolution = primaryResolution(actionBlockers.length ? actionBlockers : trip.blockers);
  const identityLabel = trip.identity?.type === 'family_member'
    ? `${trip.identity.member_name} in ${trip.identity.family_name}`
    : trip.identity?.member_name ?? 'Identity needs review';

  return (
    <Card testID={`deletion-trip-${trip.trip_id}`} style={styles.tripCard}>
      <View style={styles.cardHeading}>
        <View style={styles.flexCopy}>
          <T variant="h3" numberOfLines={2}>{trip.trip_name}</T>
          <T variant="caption" muted>{identityLabel}</T>
        </View>
        <Badge
          label={trip.settled ? 'Settled' : 'Unsettled'}
          color={trip.settled ? colors.success : colors.warning}
          size="status"
        />
      </View>

      <View style={[styles.positionRow, { borderColor: colors.border }]}>
        <View style={styles.flexCopy}>
          <T variant="caption" muted>Your position</T>
          <T variant="money" testID={`deletion-trip-${trip.trip_id}-position`}>
            {exactPositionLabel(trip.position, trip.currency)}
          </T>
        </View>
        {trip.family_position != null ? (
          <View style={[styles.familyTotal, { borderColor: colors.border }]}>
            <T variant="caption" muted>Family total</T>
            <T variant="h4" testID={`deletion-trip-${trip.trip_id}-family-position`}>
              {exactPositionLabel(trip.family_position, trip.currency)}
            </T>
          </View>
        ) : null}
      </View>

      {trip.unsettled_family_members.length ? (
        <View testID={`deletion-trip-${trip.trip_id}-family-rows`} style={styles.detailStack}>
          <T variant="caption" muted>Unsettled family members</T>
          {trip.unsettled_family_members.map((member) => (
            <View key={member.id} style={styles.compactRow}>
              <T style={styles.flexCopy} numberOfLines={1}>{member.name}</T>
              <T style={styles.numberText} color={colors.warning}>
                {exactPositionLabel(member.position, trip.currency)}
              </T>
            </View>
          ))}
        </View>
      ) : null}

      {trip.ownership.transfer_required ? (
        <View style={styles.inlineMessage} testID={`deletion-trip-${trip.trip_id}-ownership`}>
          <Icon name={trip.ownership.successor ? 'shield-check' : 'alert'} size={17}
            color={trip.ownership.successor ? colors.primary : colors.danger} />
          <T variant="caption" style={styles.flexCopy}>
            {trip.ownership.successor
              ? `Ownership will transfer to ${trip.ownership.successor.name}.`
              : 'No linked account can take ownership. Delete this trip first.'}
          </T>
        </View>
      ) : null}

      <View>
        <T variant="caption" muted style={styles.fieldLabel}>When this account is deleted</T>
        <SegmentedControl
          segments={segments}
          value={action}
          onChange={onAction}
          layout="adaptive"
          testIDPrefix={`deletion-trip-${trip.trip_id}-action`}
        />
      </View>

      {actionBlockers.map((blocker) => (
        <View key={`${blocker.code}-${blocker.actions.join('-')}`} style={styles.inlineMessage}>
          <Icon name="alert" size={16} color={colors.warning} />
          <T variant="caption" muted style={styles.flexCopy}>{blocker.message}</T>
        </View>
      ))}
      {resolution ? <BlockerAction blocker={resolution} tripId={trip.trip_id} /> : null}
    </Card>
  );
}


export default function DeleteAccountScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const { finalizeAccountDeletion } = useAuth();
  const toast = useToast();
  const [impact, setImpact] = useState<AccountDeletionImpact | null>(null);
  const [actions, setActions] = useState<Record<string, TripDeletionAction>>({});
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [finalVisible, setFinalVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async (asRefresh = false) => {
    if (asRefresh) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const next = await getAccountDeletionImpact();
      setImpact(next);
      setActions((current) => Object.fromEntries(next.trips.map((trip) => {
        const selected = current[trip.trip_id];
        return [trip.trip_id, selected && trip.available_actions.includes(selected) ? selected : 'keep'];
      })));
    } catch (reason: any) {
      setError(reason?.message || 'Could not review account deletion.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const needsAcknowledgement = useMemo(
    () => impact ? selectedTripsRequireAcknowledgement(impact.trips, actions) : false,
    [actions, impact],
  );
  const canContinue = !!impact?.account_deletion_allowed
    && confirmation === 'DELETE'
    && (!needsAcknowledgement || acknowledged)
    && !submitting;

  const submitDeletion = useCallback(async () => {
    if (!impact || !canContinue) return;
    setSubmitting(true);
    try {
      await deleteAccount({
        confirmation: 'DELETE',
        acknowledge_unsettled: needsAcknowledgement && acknowledged,
        trip_actions: impact.trips.map((trip) => ({
          trip_id: trip.trip_id,
          action: actions[trip.trip_id] ?? 'keep',
        })),
      });
      await finalizeAccountDeletion();
      navResetTo(router, AUTH_LOGIN_HREF);
    } catch (reason: any) {
      setFinalVisible(false);
      toast.show(reason?.message || 'Account deletion could not be completed.', 'error');
      if (reason?.status === 409) await load(true);
    } finally {
      setSubmitting(false);
    }
  }, [
    acknowledged, actions, canContinue, finalizeAccountDeletion, impact,
    load, needsAcknowledgement, router, toast,
  ]);

  if (loading && !impact) {
    return (
      <Screen edges={['bottom', 'left', 'right']} testID="delete-account-loading">
        <SkeletonCard count={4} />
      </Screen>
    );
  }

  if (error && !impact) {
    return (
      <Screen edges={['bottom', 'left', 'right']} testID="delete-account-error">
        <Card style={styles.centeredCard}>
          <Icon name="alert" size={28} color={colors.danger} />
          <T variant="h3">Couldn’t load the review</T>
          <T muted style={styles.centeredText}>{error}</T>
          <Button label="Try again" icon="retry" onPress={() => void load()}
            testID="delete-account-retry" />
        </Card>
      </Screen>
    );
  }

  if (!impact) return null;

  return (
    <>
      <Screen
        edges={['bottom', 'left', 'right']}
        testID="delete-account-screen"
        refreshing={refreshing}
        onRefresh={() => void load(true)}
      >
        <View style={styles.intro}>
          <View style={[styles.dangerIcon, { backgroundColor: colors.surfaceMuted }]}>
            <Icon name="trash" size={24} color={colors.danger} />
          </View>
          <View style={styles.flexCopy}>
            <T variant="h2">Delete account</T>
            <T muted>
              Review each trip before permanently removing your login and personal account data.
            </T>
          </View>
        </View>

        <View style={styles.twoColumnCards}>
          <Card style={styles.summaryCard}>
            <T variant="h4">Deleted permanently</T>
            {impact.privacy.deleted.map((line) => (
              <View key={line} style={styles.bulletRow}>
                <Icon name="close" size={15} color={colors.danger} />
                <T variant="caption" style={styles.flexCopy}>{line}</T>
              </View>
            ))}
          </Card>
          <Card style={styles.summaryCard}>
            <T variant="h4">Kept as trip history</T>
            {impact.privacy.retained.map((line) => (
              <View key={line} style={styles.bulletRow}>
                <Icon name="check" size={15} color={colors.success} />
                <T variant="caption" style={styles.flexCopy}>{line}</T>
              </View>
            ))}
          </Card>
        </View>

        {impact.blockers.length ? (
          <Card variant="muted" testID="delete-account-blockers" style={styles.summaryCard}>
            <T variant="h4">Resolve before deleting</T>
            {impact.blockers.map((blocker, index) => (
              <View key={`${blocker.code}-${index}`} style={styles.bulletRow}>
                <Icon name="alert" size={16} color={colors.warning} />
                <T variant="caption" style={styles.flexCopy}>{blocker.message}</T>
              </View>
            ))}
          </Card>
        ) : null}

        <View style={styles.sectionHeading}>
          <T variant="h3">Trip review</T>
          <T variant="caption" muted>Trips are preserved unless you choose an eligible departure.</T>
        </View>
        {impact.trips.length ? impact.trips.map((trip) => (
          <TripReviewCard
            key={trip.trip_id}
            trip={trip}
            action={actions[trip.trip_id] ?? 'keep'}
            onAction={(action) => setActions((current) => ({
              ...current, [trip.trip_id]: action,
            }))}
          />
        )) : (
          <Card testID="delete-account-no-trips">
            <T variant="h4">No linked trips</T>
            <T variant="caption" muted>Your account can be removed without changing trip history.</T>
          </Card>
        )}

        {needsAcknowledgement ? (
          <Pressable
            onPress={() => setAcknowledged((value) => !value)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: acknowledged }}
            accessibilityLabel="Acknowledge retained unsettled trip positions"
            testID="delete-account-unsettled-ack"
            style={({ pressed, focused }: any) => [
              styles.acknowledgement,
              { backgroundColor: colors.surface, borderColor: colors.warning },
              pressed && styles.pressed,
              focused && Platform.OS === 'web' && {
                outlineWidth: 2,
                outlineColor: colors.primary,
                outlineStyle: 'solid',
                outlineOffset: 2,
              } as any,
            ]}
          >
            <Icon name={acknowledged ? 'checkbox-on' : 'checkbox-off'} size={23}
              color={acknowledged ? colors.primary : colors.warning} />
            <T style={styles.flexCopy}>
              I understand that positions in trips I keep may remain unsettled after my account is deleted.
            </T>
          </Pressable>
        ) : null}

        <Card style={styles.confirmCard}>
          <Input
            label="Type DELETE to continue"
            helper="Use uppercase letters exactly as shown."
            value={confirmation}
            onChangeText={setConfirmation}
            autoCapitalize="characters"
            autoCorrect={false}
            testID="delete-account-confirmation"
            returnKeyType="done"
          />
          <Button
            label="Review final deletion"
            variant="destructive"
            icon="trash"
            fullWidth
            disabled={!canContinue}
            loading={submitting}
            onPress={() => setFinalVisible(true)}
            testID="delete-account-review-final"
          />
        </Card>
      </Screen>

      <ConfirmModal
        visible={finalVisible}
        testID="delete-account-final-modal"
        title="Permanently delete this account?"
        message="This cannot be undone. Retained trip history will no longer be linked to this login."
        onRequestClose={() => !submitting && setFinalVisible(false)}
        actions={[
          {
            label: 'Go back',
            variant: 'cancel',
            onPress: () => setFinalVisible(false),
            disabled: submitting,
            testID: 'delete-account-final-cancel',
          },
          {
            label: 'Delete account permanently',
            variant: 'destructive',
            onPress: () => void submitDeletion(),
            disabled: submitting,
            testID: 'delete-account-final-confirm',
          },
        ]}
      />
    </>
  );
}


const styles = StyleSheet.create({
  intro: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  dangerIcon: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  flexCopy: { flex: 1, minWidth: 0 },
  twoColumnCards: { gap: SPACING.sm },
  summaryCard: { gap: SPACING.sm },
  bulletRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  sectionHeading: { gap: SPACING.xs, marginTop: SPACING.sm },
  tripCard: { gap: SPACING.md },
  cardHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.md },
  positionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: SPACING.md,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    paddingVertical: SPACING.md,
  },
  familyTotal: { minWidth: 144, borderLeftWidth: 1, paddingLeft: SPACING.md },
  detailStack: { gap: SPACING.xs },
  compactRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.sm },
  numberText: { fontFamily: FONTS.number },
  inlineMessage: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm },
  fieldLabel: { marginBottom: SPACING.xs },
  acknowledgement: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.md,
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.md,
  },
  confirmCard: { gap: SPACING.lg },
  centeredCard: { alignItems: 'center', gap: SPACING.md },
  centeredText: { textAlign: 'center' },
  pressed: { opacity: 0.78 },
});
