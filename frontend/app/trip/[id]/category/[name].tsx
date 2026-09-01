import React, { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../../src/api';
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
  return `${percentage.toFixed(0)}% · ${pluralize(expenseCount, 'transaction')}`;
}

export default function CategoryDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const decoded = decodeCategoryParam(name);
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    setLoadError(null);
    try {
      const [nextTrip, nextExpenses] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<Expense[]>(`/trips/${id}/expenses`),
      ]);
      setTrip(nextTrip);
      setExpenses(nextExpenses);
    } catch (err: any) {
      const message = err.message || 'Could not load this category';
      setLoadError(message);
      toast.show(message, 'error');
    } finally {
      setRefreshing(false);
      setLoaded(true);
    }
  }, [id, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const displayNames = useMemo(() => memberDisplayNames(trip?.members), [trip?.members]);
  const memberById = (memberId: string) => displayNames[memberId] || 'Unknown payer';
  const breakdown = useMemo(
    () => buildCategorySpendBreakdown(expenses, trip?.members, decoded),
    [decoded, expenses, trip?.members],
  );

  return (
    <Screen edges={['left', 'right', 'bottom']} refreshing={refreshing} onRefresh={load} testID="category-detail-screen">
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
          <Card testID="category-summary" variant="primary" padding="lg" radius={RADIUS.xl}>
            <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>{decoded}</T>
            <AmountText
              value={breakdown.net}
              currency={trip?.currency}
              variant="moneyLg"
              color={colors.primaryText}
              style={{ marginTop: 4 }}
            />
            <T color={colors.primaryText} style={{ opacity: 0.8, marginTop: 4 }}>
              {pluralize(breakdown.transactionCount, 'transaction')} · net total
            </T>
            <View style={[styles.reconciliation, { borderTopColor: `${colors.primaryText}33` }]}>
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.reconciliationLabel}>Gross paid</T>
                <T variant="h4" color={colors.primaryText}>
                  {formatMoney(breakdown.grossPaid, { currency: trip?.currency })}
                </T>
              </View>
              <View style={[styles.reconciliationDivider, { backgroundColor: `${colors.primaryText}33` }]} />
              <View style={styles.reconciliationItem}>
                <T variant="caption" color={colors.primaryText} style={styles.reconciliationLabel}>Refunds</T>
                <T variant="h4" color={colors.primaryText}>
                  {formatMoney(breakdown.refunds, { currency: trip?.currency })}
                </T>
              </View>
            </View>
          </Card>

          <Card testID="category-payer-breakdown">
            <SpendBarChart
              summary={breakdown.payerSummary}
              displayNames={displayNames}
              currency={trip?.currency || ''}
              title="Who paid"
              summaryText={`${formatMoney(breakdown.grossPaid, { currency: trip?.currency })} fronted before refunds`}
              emptyMessage="No positive spending to rank in this category."
              rowDetail={(payer, grossPaid) => payerRowDetail(payer.paid, payer.expense_count, grossPaid)}
            />
          </Card>

          <View style={styles.transactionHeading}>
            <T variant="label">Transactions</T>
            <T variant="caption" muted>Largest spends first · refunds follow</T>
          </View>
          {breakdown.transactions.map((expense) => (
            <ListRow
              key={expense.id}
              testID={`category-transaction-${expense.id}`}
              title={expense.description || decoded}
              subtitle={`${expense.date}${expense.time ? ` · ${formatTime12h(expense.time)}` : ''} · by ${memberById(expense.paid_by_member_id)}${expense.original_currency && expense.original_currency !== trip?.currency && expense.original_amount != null ? ` · originally ${formatMoney(Number(expense.original_amount), { currency: expense.original_currency })}` : ''}`}
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
