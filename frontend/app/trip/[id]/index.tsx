import React, { useCallback, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Share, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { api, getToken, receiptUrl } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import Badge from '../../../src/Badge';
import DonutChart, { paletteForMode } from '../../../src/DonutChart';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import { canModifyExpense, roleOf, canEditTripSettings, canManageMembers, canDeleteTrip } from '../../../src/permissions';
import { compositionLabel } from '../../../src/composition';
import { receiptExpenses, billLabel } from '../../../src/gallery';
import { formatMoney } from '../../../src/format';
import { formatTripDates } from '../../../src/date';
import {
  Card, Button, IconButton, Icon, SegmentedControl, StatCard, ProgressBar,
  EmptyState, AmountText, SkeletonCard, useToast,
} from '../../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };
type Expense = { id: string; kind: 'expense' | 'income'; amount: number; category: string; description?: string; date: string; paid_by_member_id: string; split_member_ids: string[]; created_by?: string | null; has_receipt?: boolean; receipt_id?: string };
type Balances = { net: Record<string, number>; transfers: { from_member_id: string; to_member_id: string; amount: number }[]; members: Member[]; currency: string; per_person: { member_id: string; member_name: string; kind: string; people_count: number; net_total: number; net_per_person: number; family_members: string[] }[] };

type TabKey = 'summary' | 'expenses' | 'balances' | 'members' | 'gallery';
const TABS: { value: TabKey; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'balances', label: 'Balances' },
  { value: 'members', label: 'Members' },
  { value: 'gallery', label: 'Gallery' },
];

export default function TripDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors, mode } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>('summary');
  const [token, setToken] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // One themed confirm dialog drives both trip-delete and per-expense-delete.
  const [confirm, setConfirm] = useState<null | { title: string; message?: string; onYes: () => void; yesId?: string }>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const [t, e, b, tok] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<Expense[]>(`/trips/${id}/expenses`),
        api<Balances>(`/trips/${id}/balances`),
        getToken(),
      ]);
      setTrip(t); setExpenses(e); setBalances(b); setToken(tok);
    } catch (err: any) { toast.show(err.message || 'Could not load this trip', 'error'); }
    setRefreshing(false);
  }, [id, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const shareCode = async () => {
    if (!trip) return;
    await Share.share({ message: `Join my trip "${trip.name}" on Trip Splitter. Code: ${trip.code}` });
  };

  const onDelete = () => {
    if (!trip) return;
    setConfirm({
      title: 'Delete trip?',
      message: 'This removes all expenses and balances. This cannot be undone.',
      yesId: 'trip-delete-confirm',
      onYes: async () => {
        setConfirm(null);
        try { await api(`/trips/${trip.id}`, { method: 'DELETE' }); router.back(); }
        catch (e: any) { toast.show(e.message || 'Delete failed', 'error'); }
      },
    });
  };

  const deleteExpense = (e: Expense) => {
    setConfirm({
      title: 'Delete transaction?',
      message: `${e.description || e.category} · ${formatMoney(e.amount, { currency: trip?.currency })}`,
      yesId: 'expense-delete-confirm',
      onYes: async () => {
        setConfirm(null);
        try { await api(`/trips/${id}/expenses/${e.id}`, { method: 'DELETE' }); load(); }
        catch (err: any) { toast.show(err.message || 'Delete failed', 'error'); }
      },
    });
  };

  if (!trip) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
        <View style={{ padding: SPACING.lg, gap: SPACING.md }}>
          <SkeletonCard count={4} />
        </View>
      </SafeAreaView>
    );
  }

  const memberById = (mid: string) => trip.members.find((m) => m.id === mid);
  const totalSpent = expenses.filter((e) => e.kind === 'expense').reduce((s, e) => s + e.amount, 0);
  const over = trip.budget ? totalSpent > trip.budget : false;
  // Role gating routes through the shared src/permissions.ts matrix (mirror of the backend).
  const meCanEditSettings = canEditTripSettings(trip, user?.id);
  const meCanManageMembers = canManageMembers(trip, user?.id);
  const meCanDeleteTrip = canDeleteTrip(trip, user?.id);
  const memberRole = (m: Member): 'owner' | 'admin' | null => {
    if (!m.user_id) return null;
    const r = roleOf(trip, m.user_id);
    return r === 'owner' || r === 'admin' ? r : null;
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, paddingBottom: LAYOUT.scrollBottomInset, alignItems: 'center' }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
          {/* Header card */}
          <Card variant="primary" padding="lg" radius={RADIUS.xl}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <T variant="label" color={colors.primaryText} style={{ opacity: 0.85 }}>{formatTripDates(trip)}</T>
              <TouchableOpacity testID="trip-share" onPress={shareCode} accessibilityRole="button" accessibilityLabel="Share trip code"
                style={[styles.codeChip, { backgroundColor: colors.overlayOnPrimary }]}>
                <Icon name="share" size={14} color={colors.primaryText} />
                <T color={colors.primaryText} style={{ fontWeight: '700' }}>{trip.code}</T>
              </TouchableOpacity>
            </View>
            <T variant="h1" color={colors.primaryText} style={{ marginTop: SPACING.xs }}>{trip.name}</T>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <Icon name="users" size={14} color={colors.primaryText} />
              <T color={colors.primaryText} style={{ opacity: 0.85 }}>{compositionLabel(trip.members)}</T>
            </View>
            <View style={{ flexDirection: 'row', gap: SPACING.xl, marginTop: SPACING.md }}>
              <View>
                <T variant="label" color={colors.primaryText} style={{ opacity: 0.7 }}>Spent</T>
                <AmountText value={totalSpent} currency={trip.currency} color={colors.primaryText} style={{ marginTop: 2 }} />
              </View>
              {trip.budget ? (
                <View>
                  <T variant="label" color={colors.primaryText} style={{ opacity: 0.7 }}>Budget</T>
                  <AmountText value={trip.budget} color={over ? colors.warning : colors.primaryText} style={{ marginTop: 2 }} />
                </View>
              ) : null}
            </View>
          </Card>

          {/* Actions row */}
          <View style={{ flexDirection: 'row', gap: SPACING.sm, alignItems: 'center' }}>
            <View style={{ flex: 1 }}>
              <Button label="Expense" icon="plus" onPress={() => router.push(`/trip/${id}/add-expense`)} fullWidth testID="trip-add-expense" />
            </View>
            <View style={{ flex: 1 }}>
              <Button label="Settle Up" icon="arrow-left-right" variant="secondary" onPress={() => router.push(`/trip/${id}/settle-up`)} fullWidth testID="trip-settle-up" />
            </View>
            {meCanEditSettings && (
              <IconButton name="pencil" variant="surface" onPress={() => router.push(`/trip/${id}/edit`)} accessibilityLabel="Edit trip" testID="trip-edit" size={18} />
            )}
            {meCanDeleteTrip && (
              <IconButton name="trash" variant="surface" color={colors.danger} onPress={onDelete} accessibilityLabel="Delete trip" testID="trip-delete" size={18} />
            )}
          </View>

          {/* Tabs */}
          <SegmentedControl segments={TABS} value={tab} onChange={setTab} scrollable testIDPrefix="trip-tab" />

          {tab === 'summary' && (() => {
            const myMember = trip.members.find((m) => m.user_id === user?.id);
            const myNet = myMember && balances ? balances.net[myMember.id] || 0 : 0;
            const expenseCount = expenses.filter((e) => e.kind === 'expense').length;
            const incomeTotal = expenses.filter((e) => e.kind === 'income').reduce((s, e) => s + e.amount, 0);
            const byCat: Record<string, number> = {};
            expenses.filter((e) => e.kind === 'expense').forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
            const sortedCats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
            const palette = paletteForMode(mode);
            const slices = sortedCats.map(([k, v], i) => ({ key: k, label: k, value: v, color: palette[i % palette.length] }));
            const budgetPct = trip.budget ? totalSpent / trip.budget : 0;
            return (
              <View style={{ gap: SPACING.md }}>
                {myMember && (
                  <View style={[styles.youCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
                    <View style={[styles.youBadge, { backgroundColor: colors.primary }]}>
                      <T color={colors.primaryText} variant="label">You</T>
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T variant="h4">{myMember.name}{myMember.kind === 'family' ? ' (Family)' : ''}</T>
                      <T variant="caption" muted numberOfLines={1}>
                        {myMember.kind === 'family'
                          ? `Your family of ${myMember.family_members.length}: ${myMember.family_members.join(', ')}`
                          : 'Individual member'}
                      </T>
                    </View>
                    <AmountText value={myNet} signed color={myNet < 0 ? colors.danger : myNet > 0 ? colors.success : colors.textMuted} />
                  </View>
                )}

                {trip.budget ? (
                  <Card>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                      <T variant="label" muted>Budget used</T>
                      <T variant="caption" color={over ? colors.danger : colors.textMain}>
                        {formatMoney(totalSpent)} / {formatMoney(trip.budget)} {trip.currency}
                      </T>
                    </View>
                    <ProgressBar progress={budgetPct} />
                  </Card>
                ) : null}

                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  <StatCard label="Transactions" value={String(expenseCount)} icon="receipt" />
                  <StatCard label="Income" value={formatMoney(incomeTotal, { signed: true })} valueColor={colors.success} icon="arrow-down" />
                </View>

                {slices.length > 0 && (
                  <Card>
                    <T variant="label" muted style={{ marginBottom: SPACING.sm }}>Spend by category · tap to drill down</T>
                    <DonutChart
                      data={slices}
                      centerValue={formatMoney(totalSpent)}
                      centerLabel={trip.currency}
                      onSlicePress={(s) => router.push({
                        pathname: '/trip/[id]/category/[name]',
                        params: { id: id as string, name: encodeURIComponent(s.key) },
                      })}
                    />
                  </Card>
                )}
              </View>
            );
          })()}

          {tab === 'expenses' && (
            <View style={{ gap: SPACING.sm }}>
              {expenses.length === 0 ? (
                <EmptyState icon="receipt" title="No transactions yet" body="Add an expense or income to start tracking this trip." ctaLabel="Add transaction" ctaIcon="plus" onCta={() => router.push(`/trip/${id}/add-expense`)} testID="expenses-empty" />
              ) : expenses.map((e) => (
                <Card key={e.id} onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
                  testID={`expense-item-${e.id}`} style={styles.rowCard}>
                  <View style={[styles.catDot, { backgroundColor: e.kind === 'income' ? colors.success : colors.primary }]} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <T variant="h4" numberOfLines={1}>{e.description || e.category}</T>
                    <T muted variant="caption" numberOfLines={1}>
                      {e.date} · {e.category} · by {memberById(e.paid_by_member_id)?.name || '?'}
                    </T>
                    {e.has_receipt ? (
                      token ? (
                        <TouchableOpacity testID={`expense-bill-${e.id}`} onPress={() => setViewerUri(receiptUrl(id as string, e.id, token))} style={{ marginTop: 6 }} accessibilityLabel="View bill">
                          <Image source={{ uri: receiptUrl(id as string, e.id, token) }} style={[styles.billThumb, { borderColor: colors.border }]} />
                        </TouchableOpacity>
                      ) : null
                    ) : (
                      <T variant="caption" color={colors.textMuted} style={{ marginTop: 4 }}>{billLabel(e)}</T>
                    )}
                  </View>
                  <AmountText value={e.amount} signed={e.kind === 'income'} color={e.kind === 'income' ? colors.success : colors.textMain} />
                  {canModifyExpense(e, user?.id, trip) && (
                    <IconButton name="trash" onPress={() => deleteExpense(e)} accessibilityLabel="Delete transaction" testID={`expense-del-${e.id}`} size={18} color={colors.danger} />
                  )}
                </Card>
              ))}
            </View>
          )}

          {tab === 'balances' && balances && (
            <View style={{ gap: SPACING.sm }}>
              {balances.per_person.map((pp) => {
                const mine = pp.member_id === trip.members.find((m) => m.user_id === user?.id)?.id;
                return (
                  <Card key={pp.member_id}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                          <T variant="h4" numberOfLines={1}>{pp.member_name}</T>
                          {mine ? <Badge label="You" color={colors.textMuted} /> : null}
                        </View>
                        <T variant="caption" muted>
                          {pp.kind}{pp.kind === 'family' ? ` · ${pp.people_count} ${pp.people_count === 1 ? 'person' : 'people'}` : ''}
                        </T>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                        <AmountText value={pp.net_total} signed color={pp.net_total < 0 ? colors.danger : pp.net_total > 0 ? colors.success : colors.textMuted} />
                        {pp.kind === 'family' && pp.people_count > 1 && (
                          <T variant="caption" muted>{formatMoney(pp.net_per_person, { signed: true })} per person</T>
                        )}
                      </View>
                    </View>
                    {pp.kind === 'family' && pp.family_members.length > 0 && (
                      <View style={{ marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
                        {pp.family_members.map((fname, fi) => (
                          <View key={fi} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                            <T variant="caption" muted>↳ {fname}</T>
                            <T variant="caption" color={pp.net_per_person < 0 ? colors.danger : pp.net_per_person > 0 ? colors.success : colors.textMuted}>
                              {formatMoney(pp.net_per_person, { signed: true })}
                            </T>
                          </View>
                        ))}
                      </View>
                    )}
                  </Card>
                );
              })}
              {balances.transfers.length > 0 && (
                <>
                  <T variant="label" muted style={{ marginTop: SPACING.md }}>Suggested settlements</T>
                  {balances.transfers.map((tr, i) => (
                    <Card key={i} style={styles.rowCard}>
                      <View style={[styles.transferIcon, { backgroundColor: colors.surfaceMuted }]}>
                        <Icon name="arrow-left-right" size={16} color={colors.primary} />
                      </View>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T numberOfLines={1}>
                          <T color={colors.danger} style={{ fontWeight: '700' }}>{memberById(tr.from_member_id)?.name}</T>
                          <T muted>  pays  </T>
                          <T color={colors.success} style={{ fontWeight: '700' }}>{memberById(tr.to_member_id)?.name}</T>
                        </T>
                      </View>
                      <AmountText value={tr.amount} />
                    </Card>
                  ))}
                </>
              )}
            </View>
          )}

          {tab === 'members' && (
            <View style={{ gap: SPACING.sm }}>
              {meCanManageMembers ? (
                <Card onPress={() => router.push(`/trip/${id}/add-member`)} testID="trip-add-member"
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm }}>
                  <Icon name="plus" size={18} color={colors.primary} />
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Add member or family</T>
                </Card>
              ) : (
                <T testID="members-readonly-note" variant="caption" muted style={{ paddingHorizontal: SPACING.xs }}>
                  Only trip admins can add or change members.
                </T>
              )}
              {trip.members.map((m) => {
                const role = memberRole(m);
                return (
                  <Card key={m.id} style={styles.rowCard}>
                    <View style={[styles.memberIcon, { backgroundColor: colors.surfaceMuted }]}>
                      <Icon name={m.kind === 'family' ? 'users' : 'user'} size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                        <T variant="h4">{m.name}{m.kind === 'family' ? ` (${m.family_members.length})` : ''}</T>
                        {role === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
                        {role === 'admin' ? <Badge label="Admin" color={colors.success} /> : null}
                        {m.user_id === user?.id ? <Badge label="You" color={colors.textMuted} /> : null}
                      </View>
                      <T variant="caption" muted numberOfLines={1}>
                        {m.kind === 'family' ? `Family: ${m.family_members.join(', ') || '—'}` : (m.user_id ? 'App user' : 'Individual')}
                        {m.email ? ` · ${m.email}` : ''}
                      </T>
                    </View>
                    {meCanManageMembers && (
                      <IconButton name="more-vertical" onPress={() => router.push({ pathname: '/trip/[id]/manage-member', params: { id: id as string, mid: m.id } })}
                        accessibilityLabel={`Manage ${m.name}`} testID={`member-manage-${m.id}`} size={20} color={colors.primary} />
                    )}
                  </Card>
                );
              })}
            </View>
          )}

          {tab === 'gallery' && (() => {
            const withBills = receiptExpenses(expenses);
            return (
              <View style={{ gap: SPACING.sm }}>
                {withBills.length === 0 ? (
                  <EmptyState icon="image" title="No bills attached yet" body="Attach a receipt photo when adding or editing an expense and it'll show up here." testID="gallery-empty" />
                ) : (
                  <View style={styles.galleryGrid}>
                    {withBills.map((e) => (
                      <TouchableOpacity key={e.id} testID={`gallery-item-${e.id}`} disabled={!token} accessibilityLabel="View bill"
                        onPress={() => token && setViewerUri(receiptUrl(id as string, e.id, token))}
                        style={[styles.galleryCell, { borderColor: colors.border, backgroundColor: colors.surfaceMuted }]}>
                        {token ? <Image source={{ uri: receiptUrl(id as string, e.id, token) }} style={styles.galleryImage} resizeMode="cover" /> : null}
                      </TouchableOpacity>
                    ))}
                  </View>
                )}
              </View>
            );
          })()}
        </View>
      </ScrollView>

      <ReceiptViewer uri={viewerUri} visible={!!viewerUri} onClose={() => setViewerUri(null)} />

      <ConfirmModal
        visible={!!confirm}
        title={confirm?.title || ''}
        message={confirm?.message}
        onRequestClose={() => setConfirm(null)}
        actions={[
          { label: 'Cancel', variant: 'cancel', onPress: () => setConfirm(null) },
          { label: 'Delete', variant: 'destructive', onPress: () => confirm?.onYes(), testID: confirm?.yesId },
        ]}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  codeChip: {
    flexDirection: 'row', gap: 6, paddingHorizontal: 10, paddingVertical: 6,
    borderRadius: RADIUS.pill, alignItems: 'center',
  },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  catDot: { width: 10, height: 10, borderRadius: 5 },
  billThumb: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1 },
  galleryGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  galleryCell: {
    width: '31.5%', aspectRatio: 1, borderRadius: RADIUS.lg, borderWidth: 1,
    overflow: 'hidden', marginBottom: SPACING.sm,
  },
  galleryImage: { width: '100%', height: '100%' },
  memberIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  transferIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  youCard: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 2,
  },
  youBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill },
});
