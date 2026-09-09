import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import {
  listAdminActivity,
  listAdminTrips,
  type AdminAuditEvent,
  type AdminTripSummary,
} from '../../src/api';
import { useAuth } from '../../src/AuthContext';
import { formatTripDates } from '../../src/date';
import { formatMoney } from '../../src/format';
import T from '../../src/T';
import TabPageHeader from '../../src/TabPageHeader';
import { useTheme } from '../../src/ThemeContext';
import { FONTS, RADIUS, SPACING } from '../../src/theme';
import {
  Button,
  Card,
  EmptyState,
  Icon,
  Input,
  SegmentedControl,
  SkeletonCard,
  TabScreen,
} from '../../src/ui';

type AdminView = 'trips' | 'activity';

const ADMIN_VIEWS = [
  { value: 'trips' as const, label: 'Trips', icon: 'briefcase' as const },
  { value: 'activity' as const, label: 'Activity', icon: 'document' as const },
];

function timestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function actionLabel(value: string): string {
  const text = value.replace(/[._]+/g, ' ');
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : 'Admin action';
}

export default function AdminScreen() {
  const { user } = useAuth();
  const { colors } = useTheme();
  const router = useRouter();
  const [view, setView] = useState<AdminView>('trips');
  const [query, setQuery] = useState('');
  const [settledQuery, setSettledQuery] = useState('');
  const [trips, setTrips] = useState<AdminTripSummary[]>([]);
  const [activity, setActivity] = useState<AdminAuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const nextCursorRef = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSettledQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (append = false) => {
    if (user?.is_super_admin !== true) return;
    const cursor = append ? nextCursorRef.current : null;
    if (append && !cursor) return;
    const current = ++generation.current;
    if (append) setLoadingMore(true);
    else {
      nextCursorRef.current = null;
      setNextCursor(null);
      setRefreshing(true);
    }
    setError(null);
    try {
      const page = view === 'trips'
        ? await listAdminTrips({ query: settledQuery, cursor })
        : await listAdminActivity({ cursor });
      if (current !== generation.current) return;
      if (view === 'trips') {
        setTrips((existing) => append ? [...existing, ...(page.items as AdminTripSummary[])] : page.items as AdminTripSummary[]);
      } else {
        setActivity((existing) => append ? [...existing, ...(page.items as AdminAuditEvent[])] : page.items as AdminAuditEvent[]);
      }
      setTotal(page.total);
      nextCursorRef.current = page.next_cursor;
      setNextCursor(page.next_cursor);
      setLoaded(true);
    } catch (caught: any) {
      if (current === generation.current) setError(caught?.message || 'Could not load admin data');
    } finally {
      if (current === generation.current) {
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [settledQuery, user?.is_super_admin, view]);

  useFocusEffect(useCallback(() => {
    setLoaded(false);
    nextCursorRef.current = null;
    setNextCursor(null);
    void load(false);
    return () => { generation.current += 1; };
  }, [load]));

  if (user?.is_super_admin !== true) {
    return (
      <TabScreen>
        <TabPageHeader title="Admin" />
        <EmptyState
          icon="lock"
          title="Admin access required"
          body="This area is available only to the application administrator."
          testID="admin-denied"
        />
      </TabScreen>
    );
  }

  const rows = view === 'trips' ? trips : activity;

  return (
    <TabScreen refreshing={refreshing} onRefresh={() => load(false)} testID="admin-screen">
      <TabPageHeader
        title="Admin"
        action={view === 'trips' ? (
          <Button
            label="New trip"
            icon="plus"
            size="sm"
            onPress={() => router.push('/create-trip')}
            testID="admin-new-trip"
          />
        ) : undefined}
      />

      <Card variant="primary" padding="lg" radius={RADIUS.xl} testID="admin-identity">
        <View style={styles.identityRow}>
          <View style={[styles.identityIcon, { backgroundColor: colors.overlayOnPrimary }]}>
            <Icon name="shield-check" size={24} color={colors.primaryText} />
          </View>
          <View style={styles.flex}>
            <T variant="h3" color={colors.primaryText}>Application admin</T>
            <T color={colors.primaryText} style={styles.identityEmail}>{user.email}</T>
          </View>
        </View>
        <T color={colors.primaryText} style={styles.identityCopy}>
          Review and maintain every trip without becoming part of its balances.
        </T>
      </Card>

      <SegmentedControl
        segments={ADMIN_VIEWS}
        value={view}
        onChange={(next) => {
          setView(next);
          nextCursorRef.current = null;
          setNextCursor(null);
          setLoaded(false);
        }}
        testIDPrefix="admin-view"
      />

      {view === 'trips' ? (
        <Input
          value={query}
          onChangeText={setQuery}
          placeholder="Search trip, code, owner name or Gmail"
          icon="search"
          returnKeyType="search"
          testID="admin-trip-search"
          accessibilityLabel="Search all trips"
        />
      ) : null}

      <View style={styles.sectionHeading}>
        <T variant="label">{view === 'trips' ? 'All trips' : 'Admin activity'}</T>
        {loaded ? <T variant="caption" muted>{total} total</T> : null}
      </View>

      {!loaded && refreshing ? (
        <SkeletonCard count={4} />
      ) : error && rows.length === 0 ? (
        <Card testID="admin-error">
          <T color={colors.danger}>{error}</T>
          <Button label="Try again" icon="refresh" onPress={() => load(false)} style={styles.retry} />
        </Card>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={view === 'trips' ? 'briefcase' : 'document'}
          title={view === 'trips' ? 'No matching trips' : 'No admin activity yet'}
          body={view === 'trips'
            ? 'Try another trip name, code, owner name, or Gmail address.'
            : 'Privileged changes will appear here after they are completed.'}
          testID={`admin-${view}-empty`}
        />
      ) : view === 'trips' ? (
        trips.map((trip) => (
          <Card
            key={trip.id}
            onPress={() => router.push(`/trip/${trip.id}`)}
            accessibilityLabel={`Open ${trip.name}`}
            testID={`admin-trip-${trip.id}`}
          >
            <View style={styles.recordTop}>
              <View style={[styles.recordIcon, { backgroundColor: colors.surfaceMuted }]}>
                <Icon name="briefcase" size={19} color={colors.primary} />
              </View>
              <View style={styles.flex}>
                <T variant="h3" numberOfLines={1}>{trip.name}</T>
                <T variant="caption" muted numberOfLines={1}>
                  {trip.owner?.name || 'Unknown owner'} · {trip.owner?.email || 'No owner email'}
                </T>
              </View>
              <Icon name="chevron-right" size={19} color={colors.textMuted} />
            </View>
            <View style={[styles.rule, { backgroundColor: colors.border }]} />
            <T variant="caption" muted>{formatTripDates(trip)} · {trip.currency}{trip.code ? ` · Code ${trip.code}` : ''}</T>
            <View style={styles.metrics}>
              <T variant="caption">{trip.member_count} members</T>
              <T variant="caption">{trip.expense_count} transactions</T>
              <T variant="caption" style={styles.metricMoney}>
                {formatMoney(trip.net_spend, { currency: trip.currency })} net
              </T>
            </View>
          </Card>
        ))
      ) : (
        activity.map((event) => (
          <Card key={event.id} testID={`admin-activity-${event.id}`}>
            <View style={styles.recordTop}>
              <View style={[styles.recordIcon, { backgroundColor: colors.surfaceMuted }]}>
                <Icon name="shield" size={18} color={colors.primary} />
              </View>
              <View style={styles.flex}>
                <T style={styles.actionText}>{actionLabel(event.action)}</T>
                <T variant="caption" muted numberOfLines={1}>
                  {event.trip_name || event.trip_id || 'Application'}
                  {event.resource_type ? ` · ${event.resource_type.replace(/_/g, ' ')}` : ''}
                </T>
              </View>
            </View>
            <View style={styles.activityMeta}>
              <T variant="caption" muted>{timestamp(event.created_at)}</T>
              <T variant="caption" muted numberOfLines={1}>{event.actor_email}</T>
            </View>
            {event.changed_fields.length > 0 ? (
              <T variant="caption" muted style={styles.changedFields}>
                Changed: {event.changed_fields.join(', ')}
              </T>
            ) : null}
          </Card>
        ))
      )}

      {error && rows.length > 0 ? <T color={colors.danger}>{error}</T> : null}
      {nextCursor ? (
        <Button
          label="Load more"
          variant="secondary"
          onPress={() => load(true)}
          loading={loadingMore}
          fullWidth
          testID="admin-load-more"
        />
      ) : null}
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, minWidth: 0 },
  identityRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  identityIcon: {
    width: 48,
    height: 48,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityEmail: { opacity: 0.82, marginTop: SPACING.xs },
  identityCopy: { opacity: 0.86, marginTop: SPACING.md, maxWidth: 520 },
  sectionHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.xs,
  },
  recordTop: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  recordIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: SPACING.md },
  metrics: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: SPACING.md,
    marginTop: SPACING.sm,
  },
  metricMoney: { fontFamily: FONTS.bodySemibold },
  actionText: { fontFamily: FONTS.bodySemibold },
  activityMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.md,
    paddingLeft: 40 + SPACING.md,
  },
  changedFields: { marginTop: SPACING.sm, paddingLeft: 40 + SPACING.md },
  retry: { marginTop: SPACING.md },
});
