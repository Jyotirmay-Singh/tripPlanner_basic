import { categoryIcon, categoryAccent, categoryBadgeColor } from '../../../../src/categories';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api, readExpenses } from '../../../../src/api';
import { useAuth } from '../../../../src/AuthContext';
import { useTheme } from '../../../../src/ThemeContext';
import { RADIUS, SPACING } from '../../../../src/theme';
import { formatMoney, pluralize } from '../../../../src/format';
import { formatTime12h } from '../../../../src/time';
import T from '../../../../src/T';
import { memberDisplayNames } from '../../../../src/displayNames';
import SpendBarChart from '../../../../src/SpendBarChart';
import { buildCategorySpendBreakdown } from '../../../../src/categorySpend';
import { decodeCategoryParam } from '../../../../src/categoryRoute';
import { Screen, Card, ListRow, EmptyState, AmountText, SkeletonCard, useToast } from '../../../../src/ui';

type Member = { id: string; name: string; kind?: 'individual' | 'family' };
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
};

function payerRowDetail(paid: number, expenseCount: number, grossPaid: number): string {
  const percentage = grossPaid > 0 ? (paid / grossPaid) * 100 : 0;
  return `${percentage.toFixed(0)}% of payments · ${pluralize(expenseCount, 'transaction')}`;
}

export default function CategoryDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const decoded = decodeCategoryParam(name);
  const { colors, mode } = useTheme();
  const router = useRouter();
  const { show: showToast } = useToast();
  const { user } = useAuth();
  const loadGeneration = useRef(0);
  const [readScope, setReadScope] = useState<{ accountId: string; tripId: string } | null>(null);
  const [dataScope, setDataScope] = useState<{ accountId: string; tripId: string } | null>(null);
  const [storedTrip, setTrip] = useState<Trip | null>(null);
  const [storedExpenses, setExpenses] = useState<Expense[]>([]);
  const [storedComplete, setComplete] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [storedLoaded, setLoaded] = useState(false);
  const [storedLoadError, setLoadError] = useState<string | null>(null);

  const scopeMatches = readScope?.accountId === user?.id && readScope?.tripId === id;
  // A completed request cannot assign an earlier successful payload to a new scope.
  const dataScopeMatches = dataScope?.accountId === user?.id && dataScope?.tripId === id;
  const trip = dataScopeMatches ? storedTrip : null;
  const expenses = useMemo(() => dataScopeMatches ? storedExpenses : [], [dataScopeMatches, storedExpenses]);
  const complete = dataScopeMatches && storedComplete;
  const loaded = scopeMatches && storedLoaded && (!refreshing || dataScopeMatches);
  const loadError = scopeMatches ? storedLoadError : null;

  const load = useCallback(async () => {
    if (!id || !user?.id) return;
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    setLoadError(null);
    try {
      const [nextTrip, nextExpenses] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        readExpenses<Expense>(id as string),
      ]);
      if (generation !== loadGeneration.current) return;
      setDataScope({ accountId: user.id, tripId: id as string });
      setTrip(nextTrip);
      setExpenses(nextExpenses.items);
      setComplete(nextExpenses.complete);
    } catch (err: any) {
      if (generation !== loadGeneration.current) return;
      const message = err.message || 'Could not load this category';
      setLoadError(message);
      showToast(message, 'error');
    } finally {
      if (generation === loadGeneration.current) {
        setReadScope({ accountId: user.id, tripId: id as string });
        setRefreshing(false);
        setLoaded(true);
      }
    }
  }, [id, user?.id, showToast]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  const displayNames = useMemo(() => memberDisplayNames(trip?.members), [trip?.members]);
  const memberById = (memberId: string) => displayNames[memberId] || 'Unknown payer';
  const breakdown = useMemo(
    () => buildCategorySpendBreakdown(
      expenses, trip?.members, decoded, trip?.currency || 'INR'
    ),
    [decoded, expenses, trip?.currency, trip?.members],
  );

  return (
    <Screen edges={['left', 'right', 'bottom']} refreshing={refreshing} onRefresh={load} testID="category-detail-screen">
      <T variant="h3">{decoded}</T>
      {!complete && loaded ? <T muted>Category totals need a complete refresh</T> : null}
      <Stack.Screen options={{ title: decoded || 'Category' }} />
      {!loaded ? (
        <SkeletonCard count={4} />
      ) : loadError ? (
        <EmptyState
          icon="alert"
          title="Could not load category"
          body={loadError}
          ctaLabel="Try again"
          ctaIcon="refresh"
          onCta={load}
          testID="category-load-error"
        />
      ) : breakdown.transactionCount === 0 ? (
        <EmptyState icon="tag" title="Nothing here yet" body={`No transactions filed under ${decoded}.`} testID="category-empty" />
      ) : (
        <>
          {complete ? <Card testID="category-summary" variant="primary" padding="lg" radius={RADIUS.xl}>
            <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>Net spend</T>
            <AmountText
              value={breakdown.net}
              currency={trip?.currency}
              variant="moneyLg"
              color={colors.primaryText}
              style={{ marginTop: 4, textAlign: 'left' }}
            />
            <T color={colors.primaryText} style={{ opacity: 0.8, marginTop: 4 }}>
              {pluralize(breakdown.transactionCount, 'transaction')}
            </T>
            <View style={[styles.reconciliation, { borderTopColor: `${colors.primaryText}33` }]}>
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.reconciliationLabel}>Paid</T>
                <T variant="h4" color={colors.primaryText}>
                  {formatMoney(breakdown.grossPaid, { currency: trip?.currency })}
                </T>
              </View>
              <View style={[styles.reconciliationDivider, { backgroundColor: `${colors.primaryText}33` }]} />
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.reconciliationLabel}>Refunded</T>
                <T variant="h4" color={colors.primaryText}>
                  {formatMoney(breakdown.refunds, { currency: trip?.currency })}
                </T>
              </View>
            </View>
          </Card> : null}

          {complete ? <Card testID="category-payer-breakdown">
            <SpendBarChart
              summary={breakdown.payerSummary}
              displayNames={displayNames}
              currency={trip?.currency || ''}
              title="Paid by"
              summaryText={pluralize(breakdown.payerSummary.count, 'payer')}
              emptyMessage="No positive spending to rank in this category."
              rowDetail={(payer, grossPaid) => payerRowDetail(payer.paid, payer.expense_count, grossPaid)}
            />
          </Card> : null}

          <View style={styles.transactionHeading}>
            <T variant="label">Transactions</T>
            <T variant="caption" muted>Largest spends first · refunds follow</T>
          </View>
          {breakdown.transactions.map((expense) => (
            <ListRow
              wrapText
              icon={categoryIcon(expense.category)}
              iconColor={categoryAccent(expense.category, mode)}
              iconBg={categoryBadgeColor(expense.category, mode, colors.surface)}
              key={expense.id}
              testID={`category-transaction-${expense.id}`}
              title={expense.description || decoded}
              subtitle={`${expense.date}${expense.time ? ` · ${formatTime12h(expense.time)}` : ''} · by ${memberById(expense.paid_by_member_id)}${expense.original_currency && expense.original_currency !== trip?.currency && expense.original_amount != null ? ` · originally ${formatMoney(Number(expense.original_amount), { currency: expense.original_currency, currencyDisplay: 'code' })}` : ''}`}
              meta={expense.amount < 0 ? 'Refund' : undefined}
              right={<AmountText value={expense.amount} currency={trip?.currency} />}
              onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: expense.id } })}
              showChevron={false}
            />
          ))}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  reconciliation: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: SPACING.md,
    paddingTop: SPACING.md,
  },
  reconciliationItem: { flex: 1, gap: 2 },
  reconciliationDivider: { width: StyleSheet.hairlineWidth, marginHorizontal: SPACING.md },
  reconciliationLabel: { opacity: 0.72 },
  transactionHeading: { gap: 2, marginTop: SPACING.xs },
});
