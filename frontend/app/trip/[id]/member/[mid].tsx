import React, { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../../src/api';
import { useTheme } from '../../../../src/ThemeContext';
import { RADIUS } from '../../../../src/theme';
import { pluralize, formatMoney } from '../../../../src/format';
import { formatTime12h } from '../../../../src/time';
import T from '../../../../src/T';
import { memberDisplayNames } from '../../../../src/displayNames';
import { memberSpendHistory, type MemberSpendExpense } from '../../../../src/memberSpend';
import { sortExpensesDesc } from '../../../../src/expenseSort';
import { Screen, Card, Icon, ListRow, EmptyState, AmountText, SkeletonCard, useToast } from '../../../../src/ui';

type Member = { id: string; name: string; kind?: 'individual' | 'family'; family_members?: string[] };
type Trip = { id: string; name: string; currency: string; members: Member[] };

// Per-member spend drill-down (Phase 17): opened from SpendBarChart when a name/bar is tapped. Reuses
// the category-drill-down fetch/filter pattern — re-fetch the trip + expenses (the list already carries
// the calculator-derived `shares`), then select the expenses THIS entity fronted via
// memberSpendHistory. The header total sums those fronted amounts and so reconciles EXACTLY with the
// entity's gross-spend bar; each row's "their share" caption is DISPLAY-only and never summed.
export default function MemberSpendDetail() {
  const { id, mid } = useLocalSearchParams<{ id: string; mid: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<MemberSpendExpense[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [t, e] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<MemberSpendExpense[]>(`/trips/${id}/expenses`),
      ]);
      setTrip(t); setExpenses(e);
    } catch (err: any) { toast.show(err.message || 'Could not load', 'error'); }
    setRefreshing(false);
    setLoaded(true);
  }, [id, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const member = trip?.members.find((m) => m.id === mid);
  const isFamily = member?.kind === 'family';
  const displayNames = memberDisplayNames(trip?.members);
  const name = displayNames[mid as string] || member?.name || '?';
  const { rows, total } = memberSpendHistory(expenses, mid as string);
  const ordered = sortExpensesDesc(rows);

  return (
    <Screen edges={['bottom']} refreshing={refreshing} onRefresh={load}>
      <Card variant="primary" padding="lg" radius={RADIUS.xl}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={isFamily ? 'users' : 'user'} size={16} color={colors.primaryText} />
          <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>
            {name}{isFamily ? ' (Family)' : ''}
          </T>
        </View>
        <AmountText value={total} currency={trip?.currency} variant="moneyLg" color={colors.primaryText} style={{ marginTop: 4 }} />
        <T color={colors.primaryText} style={{ opacity: 0.8, marginTop: 4 }}>{pluralize(ordered.length, 'transaction')} fronted</T>
      </Card>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : ordered.length === 0 ? (
        <EmptyState icon="receipt" title="No spending yet" body={`${name} hasn't fronted any expenses on this trip.`} testID="member-spend-empty" />
      ) : (
        ordered.map((r) => (
          <ListRow
            key={r.id}
            title={r.description || r.category}
            subtitle={`${r.date}${r.time ? ` · ${formatTime12h(r.time)}` : ''} · ${r.category} · ${r.split_mode === 'PER_FAMILY' ? 'Per family' : 'Per person'}`}
            meta={r.share != null ? `their share ${formatMoney(r.share, { currency: trip?.currency })}` : undefined}
            right={<AmountText value={r.amount} currency={trip?.currency} />}
            onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: r.id } })}
            showChevron={false}
          />
        ))
      )}
    </Screen>
  );
}
