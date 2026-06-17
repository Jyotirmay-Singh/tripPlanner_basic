import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Share, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT } from '../../../src/theme';
import T from '../../../src/T';
import Badge from '../../../src/Badge';
import DonutChart, { paletteForMode } from '../../../src/DonutChart';
import { canModifyExpense } from '../../../src/permissions';
import { compositionLabel } from '../../../src/composition';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; travel_date: string; budget?: number; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };
type Expense = { id: string; kind: 'expense' | 'income'; amount: number; category: string; description?: string; date: string; paid_by_member_id: string; split_member_ids: string[]; created_by?: string | null };
type Balances = { net: Record<string, number>; transfers: { from_member_id: string; to_member_id: string; amount: number }[]; members: Member[]; currency: string; per_person: { member_id: string; member_name: string; kind: string; people_count: number; net_total: number; net_per_person: number; family_members: string[] }[] };

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, mode } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<'summary' | 'expenses' | 'balances' | 'members'>('summary');

  const load = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const [t, e, b] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<Expense[]>(`/trips/${id}/expenses`),
        api<Balances>(`/trips/${id}/balances`),
      ]);
      setTrip(t); setExpenses(e); setBalances(b);
    } catch (err: any) { Alert.alert('Error', err.message); }
    setRefreshing(false);
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shareCode = async () => {
    if (!trip) return;
    await Share.share({ message: `Join my trip "${trip.name}" on Trip Splitter. Code: ${trip.code}` });
  };

  const onDelete = () => {
    if (!trip) return;
    Alert.alert('Delete trip?', 'This removes all expenses and balances.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive',
        onPress: async () => {
          try { await api(`/trips/${trip.id}`, { method: 'DELETE' }); router.back(); }
          catch (e: any) { Alert.alert('Error', e.message); }
        },
      },
    ]);
  };

  if (!trip) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}><T style={{ padding: SPACING.lg }}>Loading…</T></SafeAreaView>;
  }

  const memberById = (mid: string) => trip.members.find((m) => m.id === mid);
  const totalSpent = expenses.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0);
  const over = trip.budget ? totalSpent > trip.budget : false;
  const isOwner = trip.owner_id === user?.id;
  const adminIds = trip.admin_ids ?? [];
  const meIsAdmin = !!user && adminIds.includes(user.id);
  // Role of a member's linked app user (only app users can hold a role). Owner supersedes Admin.
  const roleOf = (m: Member): 'owner' | 'admin' | null => {
    if (!m.user_id) return null;
    if (m.user_id === trip.owner_id) return 'owner';
    return adminIds.includes(m.user_id) ? 'admin' : null;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, paddingBottom: LAYOUT.scrollBottomInset, gap: SPACING.md }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        {/* Header card */}
        <View style={[styles.header, { backgroundColor: colors.primary }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
            <T variant="label" color={colors.primaryText} style={{ opacity: 0.8 }}>{trip.travel_date}</T>
            <TouchableOpacity testID="trip-share" onPress={shareCode} style={[styles.codeChip, { backgroundColor: colors.overlayOnPrimary }]}>
              <Ionicons name="share-outline" size={14} color={colors.primaryText} />
              <T color={colors.primaryText} style={{ fontWeight: '700' }}>{trip.code}</T>
            </TouchableOpacity>
          </View>
          <T variant="h1" color={colors.primaryText} style={{ marginTop: SPACING.xs }}>{trip.name}</T>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
            <Ionicons name="people" size={14} color={colors.primaryText} />
            <T color={colors.primaryText} style={{ opacity: 0.85 }}>
              {compositionLabel(trip.members)}
            </T>
          </View>
          <View style={{ flexDirection: 'row', gap: SPACING.md, marginTop: SPACING.md }}>
            <View>
              <T variant="label" color={colors.primaryText} style={{ opacity: 0.7 }}>Spent</T>
              <T variant="h2" color={colors.primaryText}>{totalSpent.toFixed(2)} {trip.currency}</T>
            </View>
            {trip.budget ? (
              <View>
                <T variant="label" color={colors.primaryText} style={{ opacity: 0.7 }}>Budget</T>
                <T variant="h2" color={over ? colors.owing : colors.primaryText}>{trip.budget.toFixed(2)}</T>
              </View>
            ) : null}
          </View>
        </View>

        {/* Actions row */}
        <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
          <TouchableOpacity testID="trip-add-expense" onPress={() => router.push(`/trip/${id}/add-expense`)}
            style={[styles.actionBtn, { backgroundColor: colors.primary }]}>
            <Ionicons name="add" size={16} color={colors.primaryText} />
            <T color={colors.primaryText} style={{ fontWeight: '700' }}>Expense</T>
          </TouchableOpacity>
          <TouchableOpacity testID="trip-settle-up" onPress={() => router.push(`/trip/${id}/settle-up`)}
            style={[styles.actionBtn, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
            <Ionicons name="git-compare-outline" size={16} color={colors.textMain} />
            <T style={{ fontWeight: '700' }}>Settle Up</T>
          </TouchableOpacity>
          <TouchableOpacity testID="trip-edit" onPress={() => router.push(`/trip/${id}/edit`)}
            style={[styles.iconBtn, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
            <Ionicons name="pencil-outline" size={18} color={colors.textMain} />
          </TouchableOpacity>
          {isOwner && (
            <TouchableOpacity testID="trip-delete" onPress={onDelete}
              style={[styles.iconBtn, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}>
              <Ionicons name="trash-outline" size={18} color={colors.owing} />
            </TouchableOpacity>
          )}
        </View>

        {/* Tabs */}
        <View style={[styles.tabs, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }]}>
          {(['summary', 'expenses', 'balances', 'members'] as const).map((k) => (
            <TouchableOpacity key={k}
              testID={`trip-tab-${k}`}
              onPress={() => setTab(k)}
              style={[styles.tab, tab === k && { backgroundColor: colors.primary }]}>
              <T variant="caption" style={{ fontWeight: '700', textTransform: 'capitalize' }}
                color={tab === k ? colors.primaryText : colors.textMuted}>
                {k}
              </T>
            </TouchableOpacity>
          ))}
        </View>

        {tab === 'summary' && (() => {
          const myMember = trip.members.find((m) => m.user_id === user?.id);
          const myNet = myMember && balances ? balances.net[myMember.id] || 0 : 0;
          const expenseCount = expenses.filter((e) => e.kind === 'expense').length;
          const incomeTotal = expenses.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
          const byCat: Record<string, number> = {};
          expenses.filter((e) => e.kind === 'expense').forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
          const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
          const palette = paletteForMode(mode);
          const slices = sortedCats.map(([k, v], i) => ({
            key: k, label: k, value: v, color: palette[i % palette.length],
          }));
          const budgetPct = trip.budget ? Math.min(100, (totalSpent / trip.budget) * 100) : 0;
          return (
            <View style={{ gap: SPACING.md }}>
              {myMember && (
                <View style={[styles.youCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
                  <View style={[styles.youBadge, { backgroundColor: colors.primary }]}>
                    <T color={colors.primaryText} variant="label">You</T>
                  </View>
                  <View style={{ flex: 1 }}>
                    <T variant="h3">{myMember.name}{myMember.kind === 'family' ? ' (Family)' : ''}</T>
                    <T variant="caption" muted>
                      {myMember.kind === 'family'
                        ? `Your family of ${myMember.family_members.length}: ${myMember.family_members.join(', ')}`
                        : 'Individual member'}
                    </T>
                  </View>
                  <T variant="h3" color={myNet < 0 ? colors.owing : myNet > 0 ? colors.owed : colors.textMuted}>
                    {myNet >= 0 ? '+' : ''}{myNet.toFixed(2)}
                  </T>
                </View>
              )}

              {trip.budget ? (
                <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: 'column', alignItems: 'stretch' }]}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <T variant="label" muted>Budget used</T>
                    <T variant="caption" color={over ? colors.owing : colors.textMain}>
                      {totalSpent.toFixed(2)} / {trip.budget.toFixed(2)} {trip.currency}
                    </T>
                  </View>
                  <View style={{ height: 8, backgroundColor: colors.surfaceMuted, borderRadius: 4, marginTop: 6, overflow: 'hidden' }}>
                    <View style={{ height: '100%', width: `${budgetPct}%`, backgroundColor: over ? colors.owing : colors.primary }} />
                  </View>
                </View>
              ) : null}

              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                <View style={[styles.miniStat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <T variant="label" muted>Transactions</T>
                  <T variant="h2" style={{ marginTop: 2 }}>{expenseCount}</T>
                </View>
                <View style={[styles.miniStat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <T variant="label" muted>Income</T>
                  <T variant="h2" color={colors.owed} style={{ marginTop: 2 }}>+{incomeTotal.toFixed(0)}</T>
                </View>
              </View>

              {slices.length > 0 && (
                <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: 'column', alignItems: 'stretch' }]}>
                  <T variant="label" muted style={{ marginBottom: SPACING.sm }}>Spend by category · tap to drill down</T>
                  <DonutChart
                    data={slices}
                    centerValue={totalSpent.toFixed(0)}
                    centerLabel={trip.currency}
                    onSlicePress={(s) => router.push({
                      pathname: '/trip/[id]/category/[name]',
                      params: { id: id as string, name: encodeURIComponent(s.key) },
                    })}
                  />
                </View>
              )}
            </View>
          );
        })()}

        {tab === 'expenses' && (
          <View style={{ gap: SPACING.sm }}>
            {expenses.length === 0 && <T muted style={{ padding: SPACING.md }}>No transactions yet.</T>}
            {expenses.map((e) => (
              <TouchableOpacity
                key={e.id}
                testID={`expense-item-${e.id}`}
                onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
                style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={[styles.catDot, { backgroundColor: e.kind === 'income' ? colors.owed : colors.primary }]} />
                <View style={{ flex: 1 }}>
                  <T variant="h3">{e.description || e.category}</T>
                  <T muted variant="caption">
                    {e.date} · {e.category} · by {memberById(e.paid_by_member_id)?.name || '?'}
                  </T>
                </View>
                <T variant="h3" color={e.kind === 'income' ? colors.owed : colors.textMain}>
                  {e.kind === 'income' ? '+' : ''}{e.amount.toFixed(2)}
                </T>
                {/* Step 17: only the expense creator or a trip admin sees the inline delete. */}
                {canModifyExpense(e, user?.id, trip) && (
                  <TouchableOpacity
                    testID={`expense-del-${e.id}`}
                    onPress={() => {
                      Alert.alert('Delete transaction?', '', [
                        { text: 'Cancel', style: 'cancel' },
                        {
                          text: 'Delete', style: 'destructive',
                          onPress: async () => {
                            try { await api(`/trips/${id}/expenses/${e.id}`, { method: 'DELETE' }); load(); }
                            catch (err: any) { Alert.alert('Error', err.message); }
                          },
                        },
                      ]);
                    }}
                    style={{ padding: 6, marginLeft: 4 }}>
                    <Ionicons name="trash-outline" size={18} color={colors.owing} />
                  </TouchableOpacity>
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}

        {tab === 'balances' && balances && (
          <View style={{ gap: SPACING.sm }}>
            {balances.per_person.map((pp) => (
              <View key={pp.member_id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border, flexDirection: 'column', alignItems: 'stretch' }]}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <T variant="h3">
                      {pp.member_name}
                      {pp.member_id === trip.members.find((m) => m.user_id === user?.id)?.id ? '  ·  You' : ''}
                    </T>
                    <T variant="caption" muted>
                      {pp.kind}{pp.kind === 'family' ? ` · ${pp.people_count} ${pp.people_count === 1 ? 'person' : 'people'}` : ''}
                    </T>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <T variant="h3" color={pp.net_total < 0 ? colors.owing : pp.net_total > 0 ? colors.owed : colors.textMuted}>
                      {pp.net_total >= 0 ? '+' : ''}{pp.net_total.toFixed(2)}
                    </T>
                    {pp.kind === 'family' && pp.people_count > 1 && (
                      <T variant="caption" muted>
                        {pp.net_per_person >= 0 ? '+' : ''}{pp.net_per_person.toFixed(2)} per person
                      </T>
                    )}
                  </View>
                </View>
                {pp.kind === 'family' && pp.family_members.length > 0 && (
                  <View style={{ marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
                    {pp.family_members.map((fname, fi) => (
                      <View key={fi} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                        <T variant="caption" muted>↳ {fname}</T>
                        <T variant="caption" color={pp.net_per_person < 0 ? colors.owing : pp.net_per_person > 0 ? colors.owed : colors.textMuted}>
                          {pp.net_per_person >= 0 ? '+' : ''}{pp.net_per_person.toFixed(2)}
                        </T>
                      </View>
                    ))}
                  </View>
                )}
              </View>
            ))}
            {balances.transfers.length > 0 && (
              <>
                <T variant="label" muted style={{ marginTop: SPACING.md }}>Suggested settlements</T>
                {balances.transfers.map((t, i) => (
                  <View key={i} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                    <T>
                      <T color={colors.owing}>{memberById(t.from_member_id)?.name}</T>
                      <T muted> → </T>
                      <T color={colors.owed}>{memberById(t.to_member_id)?.name}</T>
                    </T>
                    <T variant="h3" style={{ marginLeft: 'auto' }}>{t.amount.toFixed(2)}</T>
                  </View>
                ))}
              </>
            )}
          </View>
        )}

        {tab === 'members' && (
          <View style={{ gap: SPACING.sm }}>
            {meIsAdmin ? (
              <TouchableOpacity testID="trip-add-member"
                onPress={() => router.push(`/trip/${id}/add-member`)}
                style={[styles.addRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <Ionicons name="add" size={18} color={colors.primary} />
                <T color={colors.primary} style={{ fontWeight: '700' }}>Add member or family</T>
              </TouchableOpacity>
            ) : (
              <T testID="members-readonly-note" variant="caption" muted style={{ paddingHorizontal: SPACING.xs }}>
                Only trip admins can add or change members.
              </T>
            )}
            {trip.members.map((m) => {
              const role = roleOf(m);
              return (
                <View key={m.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <View style={[styles.memberIcon, { backgroundColor: colors.surfaceMuted }]}>
                    <Ionicons name={m.kind === 'family' ? 'people' : 'person'} size={18} color={colors.primary} />
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                      <T variant="h3">{m.name}{m.kind === 'family' ? ` (${m.family_members.length})` : ''}</T>
                      {role === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
                      {role === 'admin' ? <Badge label="Admin" color={colors.owed} /> : null}
                      {m.user_id === user?.id ? <Badge label="You" color={colors.textMuted} /> : null}
                    </View>
                    <T variant="caption" muted>
                      {m.kind === 'family' ? `Family: ${m.family_members.join(', ') || '—'}` : (m.user_id ? 'App user' : 'Individual')}
                      {m.email ? ` · ${m.email}` : ''}
                    </T>
                  </View>
                  {meIsAdmin && (
                    <TouchableOpacity
                      testID={`member-manage-${m.id}`}
                      onPress={() => router.push({ pathname: '/trip/[id]/manage-member', params: { id: id as string, mid: m.id } })}
                      style={{ padding: 8 }}>
                      <Ionicons name="ellipsis-horizontal" size={20} color={colors.primary} />
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
        )}

      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  header: { padding: SPACING.lg, borderRadius: RADIUS.xl },
  codeChip: {
    flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: RADIUS.pill, alignItems: 'center',
  },
  actionBtn: { flex: 1, flexDirection: 'row', gap: 6, paddingVertical: 12, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
  iconBtn: { width: 44, height: 44, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
  tabs: {
    flexDirection: 'row', padding: 4, borderRadius: RADIUS.pill, borderWidth: 1,
    justifyContent: 'space-between',
  },
  tab: { flex: 1, paddingVertical: 10, alignItems: 'center', borderRadius: RADIUS.pill },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
  catDot: { width: 10, height: 10, borderRadius: 5 },
  addRow: {
    flexDirection: 'row', gap: SPACING.sm, padding: SPACING.md,
    borderRadius: RADIUS.lg, borderWidth: 1, alignItems: 'center', justifyContent: 'center',
  },
  memberIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  youCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 2,
  },
  youBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill },
  miniStat: { flex: 1, padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1 },
  iconAction: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: RADIUS.pill, borderWidth: 1,
    marginLeft: 6,
  },
});
