import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, Share, Image } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { api, getToken, receiptUrl, spendSummary } from '../../../src/api';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, LAYOUT, CONTENT_MAX_WIDTH, COMPONENT_SIZE, FONTS } from '../../../src/theme';
import T from '../../../src/T';
import Badge from '../../../src/Badge';
import DonutChart, { paletteForMode } from '../../../src/DonutChart';
import SpendBarChart from '../../../src/SpendBarChart';
import { type SpendSummary } from '../../../src/spend';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import { canModifyExpense, roleOf, canEditTripSettings, canManageMembers, canDeleteTrip } from '../../../src/permissions';
import { compositionLabel } from '../../../src/composition';
import { memberDisplayNames, familyMemberDisplayNames } from '../../../src/displayNames';
import { billLabel } from '../../../src/bill';
import { sortExpensesDesc } from '../../../src/expenseSort';
import { hasShareBreakdown, shareVerbs, type ExpenseShares } from '../../../src/expenseShares';
import { tripTabFromParam, type TripTabKey } from '../../../src/tripTabs';
import { isTripSettled } from '../../../src/tripSettled';
import { formatCompactMoney, formatMoney } from '../../../src/format';
import { formatTripDates } from '../../../src/date';
import { formatTime12h } from '../../../src/time';
import { categoryDetailPath } from '../../../src/categoryRoute';
import TripChat from '../../../src/TripChat';
import { resolveOptimisticSender, unreadBadge } from '../../../src/chat';
import { useTripChat } from '../../../src/useTripChat';
import {
  Card, Button, IconButton, Icon, SegmentedControl, StatCard, ProgressBar,
  EmptyState, ResponsiveAmountText, SkeletonCard, useToast,
} from '../../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; family_member_ids?: string[] | null; family_member_emails?: (string | null)[] | null; family_member_user_ids?: (string | null)[] | null; user_id?: string | null; email?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number | null; currency: string; owner_id: string; admin_ids: string[]; members: Member[] };
type Expense = { id: string; amount: number; category: string; description?: string; date: string; time?: string | null; created_at?: string | null; paid_by_member_id: string; split_member_ids: string[]; created_by?: string | null; has_receipt?: boolean; receipt_id?: string; shares?: ExpenseShares };
type Balances = { net: Record<string, number>; transfers: { from_member_id: string; to_member_id: string; amount: number }[]; members: Member[]; currency: string; per_person: { member_id: string; member_name: string; kind: string; people_count: number; net_total: number; net_per_person: number; family_members: string[]; members?: { id: string; name: string; net: number }[] }[] };

type TabKey = TripTabKey;
const TABS: { value: TabKey; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'expenses', label: 'Expenses' },
  { value: 'balances', label: 'Balances' },
  { value: 'members', label: 'Members' },
  { value: 'chat', label: 'Chat' },
];

type TripIdentityHeaderProps = {
  trip: Pick<Trip, 'name' | 'code' | 'start_date' | 'end_date' | 'travel_date' | 'members'>;
  onShare: () => void;
};

/** Identity-only hero. Financial context belongs to BudgetUsageCard in the Summary tab. */
function TripIdentityHeader({ trip, onShare }: TripIdentityHeaderProps) {
  const { colors } = useTheme();

  return (
    <Card testID="trip-identity-header" variant="primary" padding="lg" radius={RADIUS.xl}>
      <View style={styles.heroContent}>
        <View style={styles.heroMetaRow}>
          <T testID="trip-date-range" variant="label" color={colors.primaryText} style={styles.heroDate}>
            {formatTripDates(trip)}
          </T>
          <TouchableOpacity
            testID="trip-share"
            onPress={onShare}
            accessibilityRole="button"
            accessibilityLabel={`Share trip code ${trip.code}`}
            accessibilityHint="Opens sharing options for this trip"
            style={[styles.codeChip, { backgroundColor: colors.overlayOnPrimary }]}
          >
            <Icon name="share" size={14} color={colors.primaryText} />
            <T color={colors.primaryText} style={styles.codeText}>{trip.code}</T>
          </TouchableOpacity>
        </View>
        <T testID="trip-name" variant="h1" color={colors.primaryText}>{trip.name}</T>
        <View style={styles.compositionRow}>
          <Icon name="users" size={14} color={colors.primaryText} />
          <T testID="trip-participant-summary" color={colors.primaryText} style={styles.compositionText}>
            {compositionLabel(trip.members)}
          </T>
        </View>
      </View>
    </Card>
  );
}

type BudgetUsageCardProps = {
  spent: number;
  budget?: number | null;
  currency: string;
};

/** The single authoritative spent-vs-budget presentation on the Trip screen. */
function BudgetUsageCard({ spent, budget, currency }: BudgetUsageCardProps) {
  const { colors } = useTheme();
  const validSpent = Number.isFinite(spent);
  const missingBudget = budget == null || budget === 0;
  const validBudget = typeof budget === 'number' && Number.isFinite(budget) && budget > 0;
  const spentLabel = validSpent ? formatMoney(spent, { currency }) : null;

  if (!validSpent || !validBudget) {
    const stateLabel = missingBudget && validSpent ? 'No budget set' : 'Budget usage unavailable';
    return (
      <Card testID="trip-budget-used-card">
        <View style={styles.budgetUsageContent}>
          <T variant="label" muted>Budget used</T>
          {spentLabel ? (
            <T testID="trip-budget-used-spent" variant="caption">{spentLabel} spent</T>
          ) : null}
          <T testID="trip-budget-used-state" variant="caption" muted>{stateLabel}</T>
        </View>
      </Card>
    );
  }

  const ratio = spent / budget;
  const overAmount = Math.max(0, spent - budget);
  const budgetLabel = formatMoney(budget, { currency });
  const overLabel = overAmount > 0 ? formatMoney(overAmount, { currency }) : null;
  const accessibilityValueText = overLabel
    ? `${spentLabel} of ${budgetLabel}; ${overLabel} over budget`
    : `${spentLabel} of ${budgetLabel}`;

  return (
    <Card testID="trip-budget-used-card">
      <View style={styles.budgetUsageContent}>
        <T variant="label" muted>Budget used</T>
        <View style={styles.budgetUsageValues}>
          <T
            testID="trip-budget-used-spent"
            variant="caption"
            color={overAmount > 0 ? colors.danger : colors.textMain}
            style={styles.budgetAmountText}
          >
            {spentLabel}
          </T>
          <T variant="caption" muted>of</T>
          <T
            testID="trip-budget-used-total"
            variant="caption"
            color={overAmount > 0 ? colors.danger : colors.textMain}
            style={styles.budgetAmountText}
          >
            {budgetLabel}
          </T>
        </View>
        {overLabel ? (
          <View testID="trip-budget-overage" style={styles.overBudgetRow}>
            <Icon name="alert" size={14} color={colors.danger} />
            <T variant="caption" color={colors.danger} style={styles.overBudgetText}>{overLabel} over budget</T>
          </View>
        ) : null}
        <ProgressBar
          testID="trip-budget-progress"
          progress={ratio}
          accessibilityLabel="Budget used"
          accessibilityValueText={accessibilityValueText}
        />
      </View>
    </Card>
  );
}

export default function TripDetail() {
  const { id, tab: tabParam } = useLocalSearchParams<{ id: string; tab?: string }>();
  const { colors, mode } = useTheme();
  const { user, chatCapability, handleAuthenticationRequired } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [trip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<TabKey>(() => tripTabFromParam(tabParam));

  // Handles both a cold notification launch and a tap while this trip screen is already mounted.
  useEffect(() => {
    setTab(tripTabFromParam(tabParam));
  }, [tabParam]);
  const [token, setToken] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Per-expense "Split details" disclosure state (collapsed by default), keyed by expense id.
  const [expandedShares, setExpandedShares] = useState<Record<string, boolean>>({});
  // One themed confirm dialog drives both trip-delete and per-expense-delete.
  const [confirm, setConfirm] = useState<null | { title: string; message?: string; onYes: () => void; yesId?: string }>(null);

  const load = useCallback(async () => {
    if (!id) return;
    setRefreshing(true);
    try {
      const [t, e, b, s, tok] = await Promise.all([
        api<Trip>(`/trips/${id}`),
        api<Expense[]>(`/trips/${id}/expenses`),
        api<Balances>(`/trips/${id}/balances`),
        spendSummary(id),
        getToken(),
      ]);
      setTrip(t); setExpenses(e); setBalances(b); setSpend(s); setToken(tok);
    } catch (err: any) { toast.show(err.message || 'Could not load this trip', 'error'); }
    setRefreshing(false);
  }, [id, toast]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const optimisticSender = resolveOptimisticSender(trip?.members, user?.id);
  const chat = useTripChat({
    tripId: id || '',
    userId: user?.id,
    sender: optimisticSender,
    active: tab === 'chat',
    capability: chatCapability,
    onAuthenticationRequired: handleAuthenticationRequired,
  });

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
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
        <View style={{ padding: SPACING.lg, gap: SPACING.md }}>
          <SkeletonCard count={4} />
        </View>
      </SafeAreaView>
    );
  }

  // Derived, disambiguated display labels (rules a/b/c). Stored names/IDs are untouched.
  const displayNames = memberDisplayNames(trip.members);
  // Signed totals: a negative transaction (money back) nets the total down.
  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0);
  // Trip-level "Settled" badge signal — reuses the SAME empty-transfers value the settle-up screen
  // uses for "All square!" (display-only; never recomputed). Every transaction card shows the badge
  // once the whole trip squares up.
  const tripSettled = isTripSettled(balances);
  // Role gating routes through the shared src/permissions.ts matrix (mirror of the backend).
  const meCanEditSettings = canEditTripSettings(trip, user?.id);
  const meCanManageMembers = canManageMembers(trip, user?.id);
  const meCanDeleteTrip = canDeleteTrip(trip, user?.id);
  const memberRole = (m: Member): 'owner' | 'admin' | null => {
    if (!m.user_id) return null;
    const r = roleOf(trip, m.user_id);
    return r === 'owner' || r === 'admin' ? r : null;
  };

  const tripTabs = TABS.map((item) => (
    item.value === 'chat' ? { ...item, badge: unreadBadge(chat.unreadCount) } : item
  ));

  const tripHeader = (
    <>
      <TripIdentityHeader trip={trip} onShare={shareCode} />

      <View style={styles.actionsRow}>
        <View style={styles.actionButton}>
          <Button label="Expense" icon="plus" onPress={() => router.push(`/trip/${id}/add-expense`)} fullWidth testID="trip-add-expense" style={styles.actionButtonControl} />
        </View>
        <View style={styles.actionButton}>
          <Button label="Settle Up" icon="arrow-left-right" variant="secondary" onPress={() => router.push(`/trip/${id}/settle-up`)} fullWidth testID="trip-settle-up" style={styles.actionButtonControl} />
        </View>
        {meCanEditSettings && (
          <IconButton name="pencil" variant="surface" onPress={() => router.push(`/trip/${id}/edit`)} accessibilityLabel="Edit trip" testID="trip-edit" size={18} touchSize={COMPONENT_SIZE.minTouchTarget} />
        )}
        {meCanDeleteTrip && (
          <IconButton name="trash" variant="surface" color={colors.danger} onPress={onDelete} accessibilityLabel="Delete trip" testID="trip-delete" size={18} touchSize={COMPONENT_SIZE.minTouchTarget} />
        )}
      </View>

      <SegmentedControl segments={tripTabs} value={tab} onChange={setTab} layout="adaptive" testIDPrefix="trip-tab" />
    </>
  );

  const tripConfirmModal = (
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
  );

  if (tab === 'chat') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
        <TripChat
          header={(
            <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, padding: SPACING.lg, paddingBottom: 0, gap: SPACING.md }}>
              {tripHeader}
            </View>
          )}
          controller={chat}
          currentUserId={user?.id}
          isOwner={trip.owner_id === user?.id}
          canSend={!!optimisticSender}
        />
        {tripConfirmModal}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        contentContainerStyle={{ padding: SPACING.lg, paddingBottom: LAYOUT.scrollBottomInset, alignItems: 'center' }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
          {tripHeader}

          {tab === 'summary' && (() => {
            const myMember = trip.members.find((m) => m.user_id === user?.id);
            const myNet = myMember && balances ? balances.net[myMember.id] || 0 : 0;
            const expenseCount = expenses.length;
            // Money returned to the group (sum of negative transactions), shown as a positive figure.
            const refundsTotal = expenses.filter((e) => e.amount < 0).reduce((s, e) => s - e.amount, 0);
            const byCat: Record<string, number> = {};
            expenses.forEach((e) => { byCat[e.category] = (byCat[e.category] || 0) + e.amount; });
            // Only positive net categories make sense as donut slices (a fully-refunded category nets <= 0).
            const sortedCats = Object.entries(byCat).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
            const palette = paletteForMode(mode);
            const slices = sortedCats.map(([k, v], i) => ({ key: k, label: k, value: v, color: palette[i % palette.length] }));
            return (
              <View style={{ gap: SPACING.md }}>
                {myMember && (
                  <View style={[styles.youCard, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
                    <View style={[styles.youBadge, { backgroundColor: colors.primary }]}>
                      <T color={colors.primaryText} variant="label">You</T>
                    </View>
                    <View style={styles.youIdentity}>
                      <T variant="h4">{displayNames[myMember.id]}{myMember.kind === 'family' ? ' (Family)' : ''}</T>
                      <T variant="caption" muted>
                        {myMember.kind === 'family'
                          ? `Your family of ${myMember.family_members.length}: ${familyMemberDisplayNames(myMember).join(', ')}`
                          : 'Individual member'}
                      </T>
                    </View>
                    <ResponsiveAmountText
                      value={myNet}
                      currency={trip.currency}
                      signed
                      showCurrency={false}
                      label="Your balance"
                      color={myNet < 0 ? colors.danger : myNet > 0 ? colors.success : colors.textMuted}
                      testID="trip-my-balance"
                    />
                  </View>
                )}

                <BudgetUsageCard spent={totalSpent} budget={trip.budget} currency={trip.currency} />

                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  <StatCard label="Transactions" value={String(expenseCount)} icon="receipt" />
                  <StatCard label="Refunds" value={formatMoney(refundsTotal)} valueColor={colors.success} icon="arrow-down" />
                </View>

                {slices.length > 0 && (
                  <Card>
                    <T variant="label" muted style={{ marginBottom: SPACING.sm }}>Spend by category · tap to drill down</T>
                    <DonutChart
                      data={slices}
                      centerValue={formatCompactMoney(totalSpent)}
                      centerLabel={trip.currency}
                      centerAccessibilityLabel={`Total spent, ${formatMoney(totalSpent, { currency: trip.currency })}`}
                      onSlicePress={(s) => router.push(categoryDetailPath(id as string, s.key) as Href)}
                    />
                  </Card>
                )}

                {expenseCount > 0 && (
                  <Card>
                    <SpendBarChart
                      summary={spend}
                      displayNames={displayNames}
                      currency={trip.currency}
                      onBarPress={(b) => router.push({
                        pathname: '/trip/[id]/member/[mid]',
                        params: { id: id as string, mid: b.entity_id },
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
                <EmptyState icon="receipt" title="No transactions yet" body="Add an expense (or a negative amount for money back) to start tracking this trip." ctaLabel="Add transaction" ctaIcon="plus" onCta={() => router.push(`/trip/${id}/add-expense`)} testID="expenses-empty" />
              ) : sortExpensesDesc(expenses).map((e) => (
                <Card key={e.id} onPress={() => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
                  testID={`expense-item-${e.id}`}>
                  <View style={styles.rowCard}>
                    <View style={[styles.catDot, { backgroundColor: e.amount < 0 ? colors.success : colors.primary }]} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T variant="h4" numberOfLines={1}>{e.description || e.category}</T>
                      <T muted variant="caption" numberOfLines={1}>
                        {e.date}{e.time ? ` · ${formatTime12h(e.time)}` : ''} · {e.category} · by {displayNames[e.paid_by_member_id] || '?'}
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
                    <View style={{ alignItems: 'flex-end', gap: 4 }}>
                      {tripSettled ? <Badge label="Settled" color={colors.success} /> : null}
                    <ResponsiveAmountText
                      value={e.amount}
                      currency={trip.currency}
                      showCurrency={false}
                      label="Transaction amount"
                      color={e.amount < 0 ? colors.success : colors.textMain}
                    />
                    </View>
                    {canModifyExpense(e, user?.id, trip) && (
                      <IconButton name="trash" onPress={() => deleteExpense(e)} accessibilityLabel="Delete transaction" testID={`expense-del-${e.id}`} size={18} color={colors.danger} />
                    )}
                  </View>
                  {/* DISPLAY-only "Split details": payer fronted the money; participants owe computed
                      shares (negative amounts read as credits via the minus sign). Its own touchable
                      so tapping it toggles instead of navigating to the edit screen. */}
                  {hasShareBreakdown(e.shares) && (() => {
                    const sh = e.shares as ExpenseShares;
                    const verbs = shareVerbs();
                    const open = !!expandedShares[e.id];
                    return (
                      <View style={{ marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
                        <TouchableOpacity
                          testID={`expense-split-toggle-${e.id}`}
                          onPress={() => setExpandedShares((s) => ({ ...s, [e.id]: !s[e.id] }))}
                          accessibilityRole="button"
                          accessibilityLabel={`${open ? 'Hide' : 'Show'} split details`}
                          style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                        >
                          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={colors.primary} />
                          <T variant="caption" color={colors.primary} style={{ fontWeight: '700' }}>Split details</T>
                        </TouchableOpacity>
                        {open && (
                          <View style={{ marginTop: SPACING.sm, gap: 4 }}>
                            <T variant="caption" muted>
                              {displayNames[sh.payer_id] || '?'} {verbs.payerVerb} {formatMoney(sh.amount, { currency: trip.currency })}
                            </T>
                            {sh.entities.map((ent) => (
                              <View key={ent.id} style={{ gap: 2 }}>
                                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: SPACING.sm }}>
                                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                                    <T variant="caption" numberOfLines={1}>{ent.name}</T>
                                    {ent.is_payer ? <Badge label={verbs.payerVerb} color={colors.textMuted} /> : null}
                                  </View>
                                  <T variant="caption" muted>{verbs.participantVerb} {formatMoney(ent.share)}</T>
                                </View>
                                {ent.members.map((sub) => (
                                  <View key={sub.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.sm, paddingLeft: SPACING.md }}>
                                    <T variant="caption" muted numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>↳ {sub.name}</T>
                                    <T variant="caption" muted>{formatMoney(sub.share)}</T>
                                  </View>
                                ))}
                              </View>
                            ))}
                          </View>
                        )}
                      </View>
                    );
                  })()}
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
                          <T variant="h4" numberOfLines={1}>{displayNames[pp.member_id] || pp.member_name}</T>
                          {mine ? <Badge label="You" color={colors.textMuted} /> : null}
                        </View>
                        <T variant="caption" muted>
                          {pp.kind}{pp.kind === 'family' ? ` · ${pp.people_count} ${pp.people_count === 1 ? 'person' : 'people'}` : ''}
                        </T>
                      </View>
                      <View style={{ alignItems: 'flex-end' }}>
                    <ResponsiveAmountText
                      value={pp.net_total}
                      currency={trip.currency}
                      signed
                      showCurrency={false}
                      label={`${displayNames[pp.member_id] || pp.member_name} balance`}
                      color={pp.net_total < 0 ? colors.danger : pp.net_total > 0 ? colors.success : colors.textMuted}
                    />
                        {pp.kind === 'family' && pp.people_count > 1 && (
                          <T variant="caption" muted>{formatMoney(pp.net_per_person, { signed: true })} per person</T>
                        )}
                      </View>
                    </View>
                    {pp.kind === 'family' && pp.family_members.length > 0 && (
                      <View style={{ marginTop: SPACING.sm, paddingTop: SPACING.sm, borderTopWidth: 1, borderTopColor: colors.border }}>
                        {(pp.members && pp.members.length > 0
                          ? pp.members
                          : familyMemberDisplayNames({ id: pp.member_id, name: pp.member_name, family_members: pp.family_members })
                              .map((fname, fi) => ({ id: `${pp.member_id}:${fi}`, name: fname, net: pp.net_per_person }))
                        ).map((fm) => (
                          <View key={fm.id} style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 }}>
                            <T variant="caption" muted>↳ {fm.name}</T>
                            <T variant="caption" color={fm.net < 0 ? colors.danger : fm.net > 0 ? colors.success : colors.textMuted}>
                              {formatMoney(fm.net, { signed: true })}
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
                          <T color={colors.danger} style={{ fontWeight: '700' }}>{displayNames[tr.from_member_id]}</T>
                          <T muted>  pays  </T>
                          <T color={colors.success} style={{ fontWeight: '700' }}>{displayNames[tr.to_member_id]}</T>
                        </T>
                      </View>
                  <ResponsiveAmountText
                    value={tr.amount}
                    currency={trip.currency}
                    showCurrency={false}
                    label="Settlement amount"
                  />
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
                const manageBtn = meCanManageMembers ? (
                  <IconButton name="more-vertical" onPress={() => router.push({ pathname: '/trip/[id]/manage-member', params: { id: id as string, mid: m.id } })}
                    accessibilityLabel={`Manage ${displayNames[m.id]}`} testID={`member-manage-${m.id}`} size={20} color={colors.primary} />
                ) : null;
                const badges = (
                  <>
                    {role === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
                    {role === 'admin' ? <Badge label="Admin" color={colors.success} /> : null}
                    {m.user_id === user?.id ? <Badge label="You" color={colors.textMuted} /> : null}
                  </>
                );

                // Family: a card that lists its members VERTICALLY (one row per member: name + email
                // when present, otherwise nothing). Phase 26/27: a family carries no email/account of
                // its own — identity lives on the sub-rows (a linked member shows Owner/Admin/You/Linked).
                if (m.kind === 'family') {
                  const subNames = familyMemberDisplayNames(m);
                  const subEmails = m.family_member_emails || [];
                  const subUserIds = m.family_member_user_ids || [];
                  return (
                    <Card key={m.id}>
                      <View style={styles.rowCard}>
                        <View style={[styles.memberIcon, { backgroundColor: colors.surfaceMuted }]}>
                          <Icon name="users" size={18} color={colors.primary} />
                        </View>
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                            <T variant="h4">{displayNames[m.id]} ({m.family_members.length})</T>
                            {badges}
                          </View>
                        </View>
                        {manageBtn}
                      </View>
                      <View style={{ marginTop: SPACING.sm, marginLeft: 20, paddingLeft: SPACING.md, paddingRight: SPACING.xs, gap: SPACING.xs, borderLeftWidth: 2, borderLeftColor: colors.border }}>
                        {subNames.length === 0 ? (
                          <T variant="caption" muted>—</T>
                        ) : subNames.map((nm, i) => {
                          // Phase 26: identity lives on the member. A linked sub-member shows its
                          // trip role (Owner/Admin, incl. the owner who is now a family member) and
                          // whether it's you; a linked-but-plain member shows "Linked".
                          const uid = subUserIds[i];
                          const subRole = uid ? roleOf(trip, uid) : null;
                          return (
                          <View key={i} testID={`member-${m.id}-sub-${i}`} style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.md }}>
                            <T numberOfLines={1} style={{ flexShrink: 1, minWidth: 0 }}>{nm}</T>
                            {subRole === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
                            {subRole === 'admin' ? <Badge label="Admin" color={colors.success} /> : null}
                            {uid && uid === user?.id ? (
                              <Badge label="You" color={colors.textMuted} />
                            ) : uid && subRole !== 'owner' && subRole !== 'admin' ? (
                              <Badge label="Linked" color={colors.success} />
                            ) : null}
                            {/* Phase 27: an empty email renders as nothing (no placeholder). */}
                            {subEmails[i] ? (
                              <T variant="caption" muted numberOfLines={1} style={{ flex: 1, textAlign: 'right', paddingRight: 2 }}>
                                {subEmails[i]}
                              </T>
                            ) : null}
                          </View>
                          );
                        })}
                      </View>
                    </Card>
                  );
                }

                // Individual: unchanged single-row card.
                return (
                  <Card key={m.id} style={styles.rowCard}>
                    <View style={[styles.memberIcon, { backgroundColor: colors.surfaceMuted }]}>
                      <Icon name="user" size={18} color={colors.primary} />
                    </View>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm }}>
                        <T variant="h4">{displayNames[m.id]}</T>
                        {badges}
                      </View>
                      <T variant="caption" muted numberOfLines={1}>
                        {m.user_id ? 'App user' : 'Individual'}{m.email ? ` · ${m.email}` : ''}
                      </T>
                    </View>
                    {manageBtn}
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <ReceiptViewer uri={viewerUri} visible={!!viewerUri} onClose={() => setViewerUri(null)} />

      {tripConfirmModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  heroContent: { gap: SPACING.sm },
  heroMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  heroDate: { opacity: 0.85, flexGrow: 1, flexShrink: 1, minWidth: 0 },
  codeChip: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    gap: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    maxWidth: '100%',
    flexShrink: 1,
  },
  codeText: { fontFamily: FONTS.bodyBold, flexShrink: 1, minWidth: 0 },
  compositionRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.sm,
  },
  compositionText: { opacity: 0.85, flex: 1, minWidth: 0 },
  actionsRow: {
    flexDirection: 'row', flexWrap: 'wrap', gap: SPACING.sm, alignItems: 'center',
  },
  actionButton: { flexGrow: 1, flexShrink: 0, maxWidth: '100%' },
  actionButtonControl: { minHeight: COMPONENT_SIZE.minTouchTarget },
  budgetUsageContent: { gap: SPACING.sm },
  budgetUsageValues: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'baseline',
    columnGap: SPACING.xs,
    rowGap: SPACING.xs,
  },
  budgetAmountText: { maxWidth: '100%', flexShrink: 1, minWidth: 0 },
  overBudgetRow: { flexDirection: 'row', alignItems: 'flex-start', gap: SPACING.xs },
  overBudgetText: { flex: 1, minWidth: 0 },
  rowCard: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  catDot: { width: 10, height: 10, borderRadius: 5 },
  billThumb: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1 },
  memberIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  transferIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  youCard: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 2,
  },
  youIdentity: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  youBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill },
});
