import { categoryIcon, categoryAccent, categoryBadgeColor } from '../../../../../src/categories';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useAuth } from '../../../../../src/AuthContext';
import { useTheme } from '../../../../../src/ThemeContext';
import { loadTripReadBundle, type CompleteTrip, type ReadResult } from '../../../../../src/offlineReads';
import OfflineReadStatus from '../../../../../src/OfflineReadStatus';
import { memberDisplayNames } from '../../../../../src/displayNames';
import { sortExpensesDesc } from '../../../../../src/expenseSort';
import { trendExpensesForPeriod, trendPeriodLabel, type TrendPeriod, type TrendScope } from '../../../../../src/expenseTrend';
import { formatAccessibleMoney, formatMoney, pluralize } from '../../../../../src/format';
import { formatTime12h } from '../../../../../src/time';
import { RADIUS, SPACING } from '../../../../../src/theme';
import T from '../../../../../src/T';
import { Screen, Card, ListRow, EmptyState, AmountText, SkeletonCard } from '../../../../../src/ui';

type Member = {
  id: string;
  name: string;
  kind: 'individual' | 'family';
  family_members?: string[];
  user_id?: string | null;
  family_member_user_ids?: (string | null)[] | null;
};
type Trip = { id: string; name: string; currency: string; members: Member[] };
type Expense = {
  id: string;
  amount: number;
  category: string;
  description?: string;
  date: string;
  time?: string | null;
  created_at?: string | null;
  paid_by_member_id: string;
  original_amount?: string | number | null;
  original_currency?: string | null;
  has_receipt?: boolean;
};
type Bundle = CompleteTrip<Trip, Expense, unknown, unknown, unknown>;
const EMPTY_EXPENSES: Expense[] = [];

export default function SpendingPeriodDetail() {
  const { id, period: periodParam, key, scope: scopeParam } = useLocalSearchParams<{
    id: string; period: string; key: string; scope?: string;
  }>();
  const period: TrendPeriod | null = periodParam === 'daily' || periodParam === 'weekly' || periodParam === 'monthly'
    ? periodParam : null;
  const scope: TrendScope | null = scopeParam === 'trip' || scopeParam === 'personal' ? scopeParam : null;
  const periodLabel = period && key ? trendPeriodLabel(period, key) : null;
  const { user, sessionMode } = useAuth();
  const { colors, mode } = useTheme();
  const router = useRouter();
  const [read, setRead] = useState<ReadResult<Bundle> | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!id || !periodLabel || !scope || !user?.id) {
      setLoaded(true);
      return;
    }
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      const result = await loadTripReadBundle<Trip, Expense, unknown, unknown, unknown>(
        user.id, id, sessionMode === 'offline',
      );
      if (generation === loadGeneration.current) setRead(result);
    } catch (error: any) {
      if (generation === loadGeneration.current) setRead({
        data: null, source: 'unavailable', fetchedAt: null,
        error: error?.message || 'Could not load spending details.',
      });
    } finally {
      if (generation === loadGeneration.current) {
        setLoaded(true);
        setRefreshing(false);
      }
    }
  }, [id, periodLabel, scope, sessionMode, user?.id]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const trip = read?.data?.trip;
  const expenses = read?.data?.expenses ?? EMPTY_EXPENSES;
  const personalMember = trip && user?.id
    ? trip.members.find((member) => member.user_id === user.id)
      ?? trip.members.find((member) => member.kind === 'family'
        && (member.family_member_user_ids ?? []).includes(user.id))
    : undefined;
  const displayNames = useMemo(() => memberDisplayNames(trip?.members), [trip?.members]);
  const rows = useMemo(() => period && periodLabel && scope
    ? sortExpensesDesc(trendExpensesForPeriod(
        expenses, period, key, scope, personalMember?.id,
      ))
    : [], [expenses, key, period, periodLabel, personalMember?.id, scope]);
  const net = rows.reduce((sum, expense) => sum + expense.amount, 0);
  const paid = rows.reduce((sum, expense) => sum + Math.max(0, expense.amount), 0);
  const refunded = rows.reduce((sum, expense) => sum + Math.max(0, -expense.amount), 0);
  const isPersonal = scope === 'personal';
  const scopeLabel = isPersonal
    ? personalMember?.kind === 'family' ? 'Your family paid' : 'You paid'
    : 'Trip net spend';
  const offlineView = sessionMode === 'offline' || read?.source === 'cache';

  return (
    <Screen edges={['left', 'right', 'bottom']} refreshing={refreshing} onRefresh={load} testID="spending-period-screen">
      <Stack.Screen options={{ title: 'Spending details' }} />
      {!periodLabel || !scope ? (
        <EmptyState icon="alert" title="Invalid spending period" body="Return to the trip and choose a bar again." testID="spending-period-invalid" />
      ) : !loaded ? (
        <SkeletonCard count={4} />
      ) : !trip ? (
        <EmptyState
          icon="alert"
          title="Could not load spending"
          body={read?.error || 'Try again when your trip is available.'}
          ctaLabel="Try again"
          ctaIcon="refresh"
          onCta={load}
          testID="spending-period-error"
        />
      ) : isPersonal && !personalMember ? (
        <EmptyState
          icon="user"
          title="No linked member"
          body="Your account is not linked to a person or family in this trip."
          testID="spending-period-unlinked"
        />
      ) : (
        <>
          {read?.source === 'cache' ? <OfflineReadStatus result={read} /> : null}
          {read?.data?.expensesComplete ? <Card testID="spending-period-summary" variant="primary" padding="lg" radius={RADIUS.xl}>
            <T variant="label" color={colors.primaryText} style={styles.cardLabel}>{scopeLabel}</T>
            <T variant="caption" color={colors.primaryText} style={styles.cardSubtitle}>{periodLabel}</T>
            <AmountText value={net} currency={trip.currency} variant="moneyLg" color={colors.primaryText} style={styles.netAmount} />
            <T color={colors.primaryText} style={styles.cardSubtitle}>{pluralize(rows.length, 'transaction')}</T>
            <View style={[styles.reconciliation, { borderTopColor: `${colors.primaryText}33` }]}>
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.cardSubtitle}>Paid</T>
                <T variant="h4" color={colors.primaryText}>{formatMoney(paid, { currency: trip.currency })}</T>
              </View>
              <View style={[styles.reconciliationDivider, { backgroundColor: `${colors.primaryText}33` }]} />
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.cardSubtitle}>Refunded</T>
                <T variant="h4" color={colors.primaryText}>{formatMoney(refunded, { currency: trip.currency })}</T>
              </View>
            </View>
          </Card> : <T muted>Category totals need a complete refresh</T>}
          {offlineView && rows.length > 0 ? (
            <T variant="caption" muted>Reconnect to open a transaction.</T>
          ) : null}
          {rows.length === 0 ? (
            <EmptyState
              icon="receipt"
              title="No transactions in this period"
              body={isPersonal ? 'You or your family did not pay for any transactions here.' : 'This trip has no expenses or refunds here.'}
              testID="spending-period-empty"
            />
          ) : (
            <>
              <View style={styles.transactionHeading}>
                <T variant="label">Transactions</T>
                <T variant="caption" muted>Newest first</T>
              </View>
              {rows.map((expense) => {
                const payer = displayNames[expense.paid_by_member_id] || 'Unknown payer';
                const original = expense.original_currency && expense.original_currency !== trip.currency
                  && expense.original_amount != null
                  ? ` · originally ${formatMoney(Number(expense.original_amount), { currency: expense.original_currency })}`
                  : '';
                return (
                  <ListRow
              wrapText
              icon={categoryIcon(expense.category)}
              iconColor={categoryAccent(expense.category, mode)}
              iconBg={categoryBadgeColor(expense.category, mode, colors.surface)}
                    key={expense.id}
                    testID={`spending-period-transaction-${expense.id}`}
                    title={expense.description || expense.category}
                    subtitle={`${expense.date}${expense.time ? ` · ${formatTime12h(expense.time)}` : ''} · ${expense.category} · by ${payer}${original}`}
                    meta={expense.amount < 0 ? 'Refund' : expense.has_receipt ? 'Receipt attached' : undefined}
                    right={<AmountText value={expense.amount} currency={trip.currency} />}
                    accessibilityLabel={`${expense.description || expense.category}, ${expense.amount < 0 ? 'refund' : 'expense'} ${formatAccessibleMoney(expense.amount, { currency: trip.currency })}, ${expense.date}, paid by ${payer}`}
                    onPress={offlineView ? undefined : () => router.push({
                      pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: expense.id },
                    })}
                    showChevron={false}
                  />
                );
              })}
            </>
          )}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardLabel: { opacity: 0.85 },
  cardSubtitle: { opacity: 0.8 },
  netAmount: { marginTop: SPACING.sm, textAlign: 'left' },
  reconciliation: {
    flexDirection: 'row', alignItems: 'stretch', borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: SPACING.md, paddingTop: SPACING.md,
  },
  reconciliationItem: { flex: 1, gap: 2 },
  reconciliationDivider: { width: StyleSheet.hairlineWidth, marginHorizontal: SPACING.md },
  transactionHeading: { gap: 2, marginTop: SPACING.xs },
});
