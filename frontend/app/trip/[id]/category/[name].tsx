import React, { useCallback, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../../src/api';
import { useTheme } from '../../../../src/ThemeContext';
import { RADIUS } from '../../../../src/theme';
import { pluralize } from '../../../../src/format';
import { formatTime12h } from '../../../../src/time';
import T from '../../../../src/T';
import { memberDisplayNames } from '../../../../src/displayNames';
import { Screen, Card, ListRow, EmptyState, AmountText, SkeletonCard, useToast } from '../../../../src/ui';

type Member = { id: string; name: string };
type Trip = { id: string; name: string; currency: string; members: Member[] };
type Expense = { id: string; kind: string; amount: number; category: string; description?: string; date: string; time?: string | null; paid_by_member_id: string };

export default function CategoryDetail() {
  const { id, name } = useLocalSearchParams<{ id: string; name: string }>();
  const decoded = decodeURIComponent(name as string);
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [t, e] = await Promise.all([api<Trip>(`/trips/${id}`), api<Expense[]>(`/trips/${id}/expenses`)]);
      setTrip(t); setExpenses(e);
    } catch (err: any) { toast.show(err.message || 'Could not load', 'error'); }
    setRefreshing(false);
    setLoaded(true);
  }, [id, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const filtered = expenses.filter((e) => e.kind === 'expense' && e.category === decoded);
  const total = filtered.reduce((s, e) => s + e.amount, 0);
  const displayNames = memberDisplayNames(trip?.members);
  const memberById = (mid: string) => displayNames[mid] || '?';

  return (
    <Screen edges={['bottom']} refreshing={refreshing} onRefresh={load}>
      <Card variant="primary" padding="lg" radius={RADIUS.xl}>
        <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>{decoded}</T>
        <AmountText value={total} currency={trip?.currency} variant="moneyLg" color={colors.primaryText} style={{ marginTop: 4 }} />
        <T color={colors.primaryText} style={{ opacity: 0.8, marginTop: 4 }}>{pluralize(filtered.length, 'transaction')}</T>
      </Card>

      {!loaded ? (
        <SkeletonCard count={3} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="tag" title="Nothing here yet" body={`No transactions filed under ${decoded}.`} testID="category-empty" />
      ) : (
        filtered.map((e) => (
          <ListRow
            key={e.id}
            title={e.description || decoded}
            subtitle={`${e.date}${e.time ? ` · ${formatTime12h(e.time)}` : ''} · by ${memberById(e.paid_by_member_id)}`}
            right={<AmountText value={e.amount} />}
            onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
            showChevron={false}
          />
        ))
      )}
    </Screen>
  );
}
