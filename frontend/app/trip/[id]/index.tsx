import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator, View, ScrollView, TouchableOpacity, StyleSheet, RefreshControl,
  Share, Image, Linking, Platform, Pressable,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter, type Href } from 'expo-router';
import { api, getToken, getTripInviteLink, receiptUrl } from '../../../src/api';
import { loadTripReadBundle, type CompleteTrip, type ReadResult } from '../../../src/offlineReads';
import OfflineReadStatus from '../../../src/OfflineReadStatus';
import { listPendingExpenses, type PendingExpense } from '../../../src/offlineExpenses';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, CONTENT_MAX_WIDTH, COMPONENT_SIZE, FONTS } from '../../../src/theme';
import T from '../../../src/T';
import Badge from '../../../src/Badge';
import DonutChart, { paletteForMode } from '../../../src/DonutChart';
import SpendBarChart from '../../../src/SpendBarChart';
import { type SpendSummary } from '../../../src/spend';
import ReceiptViewer from '../../../src/ReceiptViewer';
import ConfirmModal from '../../../src/ConfirmModal';
import { canModifyExpense, roleOf, canEditTripSettings, canManageMembers, canDeleteTrip } from '../../../src/permissions';
import {
  canShareSecureInvite,
  tripCodeShareMessage,
  tripInviteShareMessage,
} from '../../../src/inviteSharing';
import { compositionLabel } from '../../../src/composition';
import { memberDisplayNames, familyMemberDisplayNames } from '../../../src/displayNames';
import { billLabel } from '../../../src/bill';
import { sortExpensesDesc } from '../../../src/expenseSort';
import { hasShareBreakdown, shareVerbs, type ExpenseShares } from '../../../src/expenseShares';
import { tripTabFromParam, type TripTabKey } from '../../../src/tripTabs';
import { isTripSettled } from '../../../src/tripSettled';
import type { SettlementProjection } from '../../../src/settlementProjection';
import { formatAccessibleMoney, formatMoney } from '../../../src/format';
import { formatTripDates } from '../../../src/date';
import { formatTime12h } from '../../../src/time';
import { formatMobileForDisplay } from '../../../src/mobileNumber';
import { categoryDetailPath } from '../../../src/categoryRoute';
import TripChat from '../../../src/TripChat';
import { resolveOptimisticSender, unreadBadge } from '../../../src/chat';
import { useTripChat } from '../../../src/useTripChat';
import JoinRequestsPanel from '../../../src/JoinRequestsPanel';
import InviteLinksPanel from '../../../src/InviteLinksPanel';
import MembershipCard from '../../../src/MembershipCard';
import { normalizedTripDeletionName } from '../../../src/departure';
import {
  Card, Button, IconButton, Icon, SegmentedControl, StatCard, ProgressBar,
  ActionSheet, EmptyState, ResponsiveAmountText, SkeletonCard, useToast,
} from '../../../src/ui';

type Member = { id: string; name: string; kind: 'individual' | 'family'; family_members: string[]; family_member_ids?: string[] | null; family_member_emails?: (string | null)[] | null; family_member_user_ids?: (string | null)[] | null; family_member_mobile_numbers?: (string | null)[] | null; user_id?: string | null; email?: string | null; mobile_number?: string | null };
type Trip = { id: string; name: string; code: string; start_date?: string; end_date?: string; travel_date?: string; budget?: number | null; currency: string; owner_id: string; admin_ids: string[]; user_ids: string[]; members: Member[] };
type Expense = { id: string; amount: number; currency?: string; original_amount?: string | number | null; original_currency?: string | null; category: string; description?: string; date: string; time?: string | null; created_at?: string | null; paid_by_member_id: string; split_member_ids: string[]; created_by?: string | null; has_receipt?: boolean; receipt_id?: string; shares?: ExpenseShares };
type Balances = { net: Record<string, number>; transfers: { from_member_id: string; to_member_id: string; amount: number }[]; members: Member[]; currency: string; settlement_projection?: SettlementProjection; per_person: { member_id: string; member_name: string; kind: string; people_count: number; net_total: number; net_per_person: number; family_members: string[]; members?: { id: string; name: string; net: number }[] }[] };

type TabKey = TripTabKey;

type MobileContactLineProps = {
  number: string;
  onPress: () => void;
  testID: string;
};

function MobileContactLine({ number, onPress, testID }: MobileContactLineProps) {
  const { colors } = useTheme();
  const formatted = formatMobileForDisplay(number);
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`Mobile ${formatted}`}
      accessibilityHint="Opens call and copy actions"
      style={({ pressed, focused }: any) => [
        styles.contactLine,
        pressed && { opacity: 0.72 },
        focused && Platform.OS === 'web' && {
          outlineWidth: 2,
          outlineColor: colors.primary,
          outlineStyle: 'solid',
          outlineOffset: 2,
        } as any,
      ]}
    >
      <Icon name="phone" size={15} color={colors.primary} />
      <T variant="caption" color={colors.primary} numberOfLines={1}>{formatted}</T>
    </Pressable>
  );
}

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
  sharing?: boolean;
  secureInvite?: boolean;
  shareDisabled?: boolean;
};

/** Identity-only hero. Financial context belongs to BudgetUsageCard in the Summary tab. */
function TripIdentityHeader({ trip, onShare, sharing = false, secureInvite = false,
  shareDisabled = false }: TripIdentityHeaderProps) {
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
            disabled={sharing || shareDisabled}
            accessibilityRole="button"
            accessibilityLabel={secureInvite
              ? `Share secure invitation to ${trip.name}`
              : `Share trip code ${trip.code}`}
            accessibilityHint="Opens sharing options for this trip"
            style={[styles.codeChip, { backgroundColor: colors.overlayOnPrimary }]}
          >
            {sharing
              ? <ActivityIndicator size="small" color={colors.primaryText} />
              : <Icon name="share" size={14} color={colors.primaryText} />}
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
  const spentAccessibleLabel = formatAccessibleMoney(spent, { currency });
  const budgetAccessibleLabel = formatAccessibleMoney(budget, { currency });
  const overAccessibleLabel = overAmount > 0
    ? formatAccessibleMoney(overAmount, { currency })
    : null;
  const accessibilityValueText = overAccessibleLabel
    ? `${spentAccessibleLabel} of ${budgetAccessibleLabel}; ${overAccessibleLabel} over budget`
    : `${spentAccessibleLabel} of ${budgetAccessibleLabel}`;

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
  const {
    id,
    tab: tabParam,
    expenseId: notificationExpenseId,
    messageId: notificationMessageId,
  } = useLocalSearchParams<{
    id: string; tab?: string; expenseId?: string; messageId?: string;
  }>();
  const { colors, mode } = useTheme();
  const {
    user, sessionMode, chatCapability, handleAuthenticationRequired, inviteLinksEnabled, refreshRuntimeConfig,
  } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [storedTrip, setTrip] = useState<Trip | null>(null);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [storedPendingExpenses, setPendingExpenses] = useState<PendingExpense[]>([]);
  const [pendingReadError, setPendingReadError] = useState(false);
  const [balances, setBalances] = useState<Balances | null>(null);
  const [spend, setSpend] = useState<SpendSummary | null>(null);
  const [storedRead, setRead] = useState<ReadResult<CompleteTrip<Trip, Expense, Balances, SpendSummary, unknown>> | null>(null);
  const [readAccountId, setReadAccountId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const loadGeneration = useRef(0);
  const trip = readAccountId === user?.id ? storedTrip : null;
  const read = readAccountId === user?.id ? storedRead : null;
  const pendingExpenses = readAccountId === user?.id ? storedPendingExpenses : [];
  const [tab, setTab] = useState<TabKey>(() => tripTabFromParam(tabParam));

  // Handles both a cold notification launch and a tap while this trip screen is already mounted.
  useEffect(() => {
    setTab(tripTabFromParam(tabParam));
  }, [tabParam]);
  const [token, setToken] = useState<string | null>(null);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  // Per-expense "Split details" disclosure state (collapsed by default), keyed by expense id.
  const [expandedShares, setExpandedShares] = useState<Record<string, boolean>>({});
  const [paymentDetailsExpanded, setPaymentDetailsExpanded] = useState(false);
  const notificationScrollRef = useRef<ScrollView>(null);
  const expensesSectionY = useRef(0);
  const focusedExpenseId = useRef<string | null>(null);

  useEffect(() => {
    focusedExpenseId.current = null;
  }, [notificationExpenseId]);

  useEffect(() => {
    setPaymentDetailsExpanded(false);
  }, [id]);
  // One themed confirm dialog drives both trip-delete and per-expense-delete.
  const [confirm, setConfirm] = useState<null | {
    title: string;
    message?: string;
    onYes: () => void;
    yesId?: string;
    requiresTripName?: boolean;
  }>(null);
  const [deleteTripName, setDeleteTripName] = useState('');
  const [sharingInvite, setSharingInvite] = useState(false);
  const [mobileContact, setMobileContact] = useState<null | {
    number: string;
    name: string;
    testID: string;
  }>(null);

  const load = useCallback(async () => {
    if (!id || !user?.id) return;
    const generation = ++loadGeneration.current;
    setRefreshing(true);
    try {
      const result = await loadTripReadBundle<Trip, Expense, Balances, SpendSummary, unknown>(
        user.id, id, sessionMode === 'offline',
      );
      if (generation !== loadGeneration.current) return;
      setReadAccountId(user.id);
      setRead(result);
      if (result.data) {
        setTrip(result.data.trip);
        setExpenses(result.data.expenses);
        setBalances(result.data.balances);
        setSpend(result.data.spend);
        const currentToken = result.source === 'live' ? await getToken().catch(() => null) : null;
        if (generation === loadGeneration.current) setToken(currentToken);
      } else {
        setTrip(null); setExpenses([]); setBalances(null); setSpend(null); setToken(null);
      }
      try {
        const pending = await listPendingExpenses(user.id, id,
          result.data?.expenses.map((expense) => expense.id) ?? []);
        if (generation === loadGeneration.current) {
          setPendingExpenses(pending);
          setPendingReadError(false);
        }
      } catch {
        if (generation === loadGeneration.current) setPendingReadError(true);
      }
    } catch (error: any) {
      if (generation === loadGeneration.current) {
        setReadAccountId(user.id);
        setRead({ data: null, source: 'unavailable', fetchedAt: null,
          error: error?.message || 'This trip is unavailable.' });
        setTrip(null);
      }
    } finally {
      if (generation === loadGeneration.current) setRefreshing(false);
    }
  }, [id, user?.id, sessionMode]);

  useFocusEffect(useCallback(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]));

  const offlineView = sessionMode === 'offline' || read?.source === 'cache';

  const isApplicationAdmin = user?.is_super_admin === true;
  const optimisticSender = isApplicationAdmin
    ? { name: 'Application Admin' }
    : resolveOptimisticSender(trip?.members, user?.id);
  const chat = useTripChat({
    tripId: id || '',
    userId: user?.id,
    sender: optimisticSender,
    active: tab === 'chat',
    capability: chatCapability,
    onAuthenticationRequired: handleAuthenticationRequired,
  });

  const canCreateSecureInvite = !!trip
    && !offlineView && canShareSecureInvite(trip, user?.id, inviteLinksEnabled, isApplicationAdmin);

  const shareCode = async (knownInviteUrl?: string) => {
    if (!trip) return;
    if (sharingInvite) return;
    setSharingInvite(true);
    try {
      let freshInviteLinksEnabled = false;
      try {
        const config = await refreshRuntimeConfig();
        freshInviteLinksEnabled = config.inviteLinksEnabled;
      } catch {
        toast.show(
          'Could not check secure-link availability. Sharing the trip code instead.',
          'error',
        );
        await Share.share({ message: tripCodeShareMessage(trip.name, trip.code) });
        return;
      }

      if (!canShareSecureInvite(trip, user?.id, freshInviteLinksEnabled, isApplicationAdmin)) {
        if (!freshInviteLinksEnabled) {
          toast.show('Secure invite links are not live yet. Sharing the trip code instead.', 'info');
        }
        await Share.share({ message: tripCodeShareMessage(trip.name, trip.code) });
        return;
      }

      const invite = knownInviteUrl ? { url: knownInviteUrl } : await getTripInviteLink(trip.id);
      await Share.share({
        message: tripInviteShareMessage(trip.name, trip.code, invite.url),
      });
    } catch (error: any) {
      toast.show(
        `Could not load the trip link${error.message ? `: ${error.message}` : ''}. `
          + 'Sharing the trip code instead.',
        'error',
      );
      await Share.share({ message: tripCodeShareMessage(trip.name, trip.code) });
    } finally {
      setSharingInvite(false);
    }
  };

  const onDelete = () => {
    if (!trip) return;
    setDeleteTripName('');
    setConfirm({
      title: `Delete ${trip.name}?`,
      message: 'This permanently removes the trip and all related expenses, balances, payments, receipts, invites, and chat data.',
      yesId: 'trip-delete-confirm',
      requiresTripName: true,
      onYes: async () => {
        setConfirm(null);
        setDeleteTripName('');
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

  const callMobile = async () => {
    const contact = mobileContact;
    setMobileContact(null);
    if (!contact) return;
    const url = `tel:${contact.number}`;
    try {
      if (!await Linking.canOpenURL(url)) {
        toast.show('Calling is not supported on this device.', 'error');
        return;
      }
      await Linking.openURL(url);
    } catch {
      toast.show('Could not start the call. Try again.', 'error');
    }
  };

  const copyMobile = async () => {
    const contact = mobileContact;
    setMobileContact(null);
    if (!contact) return;
    try {
      const copied = await Clipboard.setStringAsync(contact.number);
      if (!copied) {
        toast.show('Could not copy mobile number. Try again.', 'error');
        return;
      }
      toast.show('Mobile number copied', 'success');
    } catch {
      toast.show('Could not copy mobile number. Try again.', 'error');
    }
  };

  if (!trip) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
        <View style={{ padding: SPACING.lg, gap: SPACING.md }}>
          {read?.source === 'unavailable' ? (
            <EmptyState icon="alert" title="Trip unavailable offline"
              body={read.error || 'Open this trip online to save a copy on this device.'}
              ctaLabel="Try again" onCta={load} testID="trip-unavailable" />
          ) : <SkeletonCard count={4} />}
        </View>
      </SafeAreaView>
    );
  }

  // Derived, disambiguated display labels (rules a/b/c). Stored names/IDs are untouched.
  const displayNames = memberDisplayNames(trip.members);
  const expectedDeleteTripName = normalizedTripDeletionName(trip.name);
  // Signed totals: a negative transaction (money back) nets the total down.
  const totalSpent = expenses.reduce((s, e) => s + e.amount, 0);
  // Trip-level "Settled" badge signal — reuses the SAME empty-transfers value the settle-up screen
  // uses for "All square!" (display-only; never recomputed). Every transaction card shows the badge
  // once the whole trip squares up.
  const tripSettled = isTripSettled(balances);
  // Role gating routes through the shared src/permissions.ts matrix (mirror of the backend).
  const meCanEditSettings = canEditTripSettings(trip, user?.id, isApplicationAdmin);
  const meCanManageMembers = canManageMembers(trip, user?.id, isApplicationAdmin);
  const meCanDeleteTrip = canDeleteTrip(trip, user?.id, isApplicationAdmin);
  const applicationAdminIsMember = !!user?.id && (trip.user_ids ?? []).includes(user.id);
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
      <TripIdentityHeader
        trip={trip}
        onShare={shareCode}
        sharing={sharingInvite}
        secureInvite={canCreateSecureInvite}
        shareDisabled={offlineView}
      />

      {read ? <OfflineReadStatus result={read} /> : null}
      {pendingExpenses.length > 0 ? (
        <T variant="caption" muted testID="trip-pending-summary">
          {pendingExpenses.length} Pending sync · confirmed totals exclude pending transactions.
        </T>
      ) : null}
      {pendingReadError ? <T variant="caption" color={colors.warning} testID="trip-pending-read-error">
        Pending transactions could not be read on this device.
      </T> : null}
      {offlineView ? (
        <T variant="caption" muted testID="trip-online-actions-note">
          Saved trip view. Changes and receipt images require a connection.
        </T>
      ) : null}

      {isApplicationAdmin ? (
        <Card variant="muted" testID="trip-privileged-mode">
          <View style={styles.privilegedRow}>
            <View style={[styles.privilegedIcon, { backgroundColor: colors.surface }]}>
              <Icon name="shield-check" size={20} color={colors.primary} />
            </View>
            <View style={styles.privilegedCopy}>
              <T variant="h4">Privileged admin mode</T>
              <T variant="caption" muted>
                {applicationAdminIsMember
                  ? 'Application-wide controls are active. Privileged changes are recorded in the admin activity log.'
                  : 'You are maintaining this trip without joining its roster. Its expenses and balances do not affect your account.'}
              </T>
            </View>
          </View>
        </Card>
      ) : null}

      <View style={styles.actionsRow}>
        <View style={styles.actionButton}>
          <Button label="Expense" icon="plus" onPress={() => router.push(`/trip/${id}/add-expense`)} fullWidth testID="trip-add-expense" style={styles.actionButtonControl} />
        </View>
        <View style={styles.actionButton}>
          <Button label="Settle Up" icon="arrow-left-right" variant="secondary" onPress={() => router.push(`/trip/${id}/settle-up`)} fullWidth testID="trip-settle-up" style={styles.actionButtonControl} />
        </View>
        {meCanEditSettings && !offlineView && (
          <IconButton name="pencil" variant="surface" onPress={() => router.push(`/trip/${id}/edit`)} accessibilityLabel="Edit trip" testID="trip-edit" size={18} touchSize={COMPONENT_SIZE.minTouchTarget} />
        )}
        {meCanDeleteTrip && !offlineView && (
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
      textInput={confirm?.requiresTripName ? {
        value: deleteTripName,
        onChangeText: setDeleteTripName,
        label: `Type “${expectedDeleteTripName}” to confirm`,
        placeholder: expectedDeleteTripName,
        testID: 'trip-delete-name',
      } : undefined}
      onRequestClose={() => { setConfirm(null); setDeleteTripName(''); }}
      actions={[
        {
          label: 'Cancel', variant: 'cancel',
          onPress: () => { setConfirm(null); setDeleteTripName(''); },
        },
        {
          label: 'Delete', variant: 'destructive', onPress: () => confirm?.onYes(),
          testID: confirm?.yesId,
          disabled: !!confirm?.requiresTripName
            && deleteTripName.trim() !== expectedDeleteTripName,
        },
      ]}
    />
  );

  if (tab === 'chat') {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['left', 'right']}>
        <TripChat
          header={(
            <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, padding: SPACING.lg, paddingBottom: 0, gap: SPACING.md }}>
              {tripHeader}
            </View>
          )}
          controller={chat}
          currentUserId={user?.id}
          isOwner={trip.owner_id === user?.id}
          canModerateMessages={isApplicationAdmin}
          canSend={!!optimisticSender}
          focusMessageId={notificationMessageId}
        />
        {tripConfirmModal}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom', 'left', 'right']}>
      <ScrollView
        ref={notificationScrollRef}
        contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={colors.primary} />}
      >
        <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
          {tripHeader}

          {tab === 'summary' && (() => {
            const settlementMembers = balances?.members?.length ? balances.members : trip.members;
            const directlyLinkedMember = user?.id
              ? settlementMembers.find((m) => m.user_id === user.id)
              : undefined;
            const familyLinkedMember = user?.id
              ? settlementMembers.find((m) => (
                  m.kind === 'family' && (m.family_member_user_ids ?? []).includes(user.id)
                ))
              : undefined;
            const myMember = directlyLinkedMember ?? familyLinkedMember;
            const myNet = myMember && balances ? balances.net[myMember.id] || 0 : 0;
            const settlementDisplayNames = settlementMembers === trip.members
              ? displayNames
              : memberDisplayNames(settlementMembers);
            const settlementMemberById = new Map(settlementMembers.map((member) => [member.id, member]));
            const settlementLabel = (memberId: string) => {
              const member = settlementMemberById.get(memberId);
              const label = displayNames[memberId]
                ?? settlementDisplayNames[memberId]
                ?? member?.name
                ?? memberId;
              return member?.kind === 'family' ? `${label} (Family)` : label;
            };
            const relatedTransfers = myMember && balances
              ? balances.transfers.filter((transfer) => (
                  transfer.from_member_id === myMember.id || transfer.to_member_id === myMember.id
                ))
              : [];
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
                    <View style={styles.youSummary}>
                      <View style={[styles.youBadge, { backgroundColor: colors.primary }]}>
                        <T color={colors.primaryText} variant="label">You</T>
                      </View>
                      <View style={styles.youIdentity}>
                        <T variant="h4">{settlementLabel(myMember.id)}</T>
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
                    {relatedTransfers.length > 0 ? (
                      <>
                        <Pressable
                          testID="trip-payment-details-toggle"
                          onPress={() => setPaymentDetailsExpanded((expanded) => !expanded)}
                          accessibilityRole="button"
                          accessibilityLabel={paymentDetailsExpanded
                            ? 'Hide payment details'
                            : 'View payment details'}
                          accessibilityState={{ expanded: paymentDetailsExpanded }}
                          style={styles.paymentDetailsToggle}
                        >
                          <T color={colors.primary} style={styles.paymentDetailsToggleText}>
                            {paymentDetailsExpanded ? 'Hide payment details' : 'View payment details'}
                          </T>
                          <Icon
                            name={paymentDetailsExpanded ? 'chevron-down' : 'chevron-right'}
                            size={18}
                            color={colors.primary}
                          />
                        </Pressable>
                        {paymentDetailsExpanded ? (
                          <View
                            testID="trip-payment-details"
                            style={[styles.paymentDetails, { borderTopColor: colors.border }]}
                          >
                            {relatedTransfers.map((transfer, index) => {
                              const payer = settlementLabel(transfer.from_member_id);
                              const receiver = settlementLabel(transfer.to_member_id);
                              return (
                                <View
                                  key={`${transfer.from_member_id}:${transfer.to_member_id}:${index}`}
                                  testID={`trip-payment-details-transfer-${index}`}
                                  style={styles.paymentTransferRow}
                                >
                                  <T variant="caption" style={styles.paymentTransferSentence}>
                                    <T
                                      variant="caption"
                                      color={colors.danger}
                                      style={styles.paymentPartyName}
                                    >
                                      {payer}
                                    </T>
                                    <T variant="caption"> pays </T>
                                    <T
                                      variant="caption"
                                      color={colors.success}
                                      style={styles.paymentPartyName}
                                    >
                                      {receiver}
                                    </T>
                                  </T>
                                  <ResponsiveAmountText
                                    value={transfer.amount}
                                    currency={trip.currency}
                                    showCurrency={false}
                                    whole={balances?.settlement_projection?.enabled}
                                    variant="caption"
                                    label={`${payer} pays ${receiver}`}
                                    style={styles.paymentTransferAmount}
                                  />
                                </View>
                              );
                            })}
                          </View>
                        ) : null}
                      </>
                    ) : null}
                  </View>
                )}

                <BudgetUsageCard spent={totalSpent} budget={trip.budget} currency={trip.currency} />

                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  <StatCard label="Transactions" value={String(expenseCount)} icon="receipt" />
                  <StatCard
                    label="Refunds"
                    value={formatMoney(refundsTotal, {
                      currency: trip.currency, showCurrency: false,
                    })}
                    valueColor={colors.success}
                    icon="arrow-down"
                  />
                </View>

                {slices.length > 0 && (
                  <Card>
                    <T variant="label" muted style={{ marginBottom: SPACING.sm }}>Spend by category · tap to drill down</T>
                    <DonutChart
                      data={slices}
                      currency={trip.currency}
                      centerValue={formatMoney(totalSpent, { currency: trip.currency })}
                      centerLabel="TOTAL"
                      centerAccessibilityLabel={`Total spent, ${formatAccessibleMoney(totalSpent, { currency: trip.currency })}`}
                      onSlicePress={offlineView ? undefined : (s) => router.push(categoryDetailPath(id as string, s.key) as Href)}
                    />
                  </Card>
                )}

                {expenseCount > 0 && (
                  <Card>
                    <SpendBarChart
                      summary={spend}
                      displayNames={displayNames}
                      currency={trip.currency}
                      onBarPress={offlineView ? undefined : (b) => router.push({
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
            <View
              style={{ gap: SPACING.sm }}
              onLayout={(event) => { expensesSectionY.current = event.nativeEvent.layout.y; }}
            >
              {pendingExpenses.map((item) => {
                const payload = item.payload;
                const amount = Number(payload.amount ?? payload.original_amount ?? 0);
                const status = item.state === 'needs_review' ? 'Needs review · Pending sync' : 'Pending sync';
                return (
                  <Card key={item.clientMutationId}
                    onPress={() => router.push(
                      `/trip/${id}/pending-expense?mutationId=${encodeURIComponent(item.clientMutationId)}` as Href)}
                    testID={`pending-expense-item-${item.clientMutationId}`}>
                    <View style={styles.rowCard}>
                      <View style={[styles.catDot,
                        { backgroundColor: amount < 0 ? colors.success : colors.warning }]} />
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T variant="h4" numberOfLines={1}>
                          {String(payload.description || payload.category)}
                        </T>
                        <T variant="caption" muted>
                          {String(payload.date)} · {String(payload.category)} · by {displayNames[payload.paid_by_member_id] || '?'}
                        </T>
                        <T variant="caption" color={colors.warning}
                          accessibilityLabel={`${status}. Saved on this device; not included in confirmed totals.`}
                          testID={`pending-expense-status-${item.clientMutationId}`}>{status}</T>
                      </View>
                      <ResponsiveAmountText value={amount} currency={trip.currency} showCurrency={false}
                        label="Pending transaction amount" color={amount < 0 ? colors.success : colors.textMain} />
                    </View>
                  </Card>
                );
              })}
              {expenses.length === 0 && pendingExpenses.length === 0 ? (
                <EmptyState icon="receipt" title="No transactions yet" body="Add an expense (or a negative amount for money back) to start tracking this trip." ctaLabel="Add transaction" ctaIcon="plus" onCta={() => router.push(`/trip/${id}/add-expense`)} testID="expenses-empty" />
              ) : sortExpensesDesc(expenses).map((e) => (
                <View
                  key={e.id}
                  onLayout={(event) => {
                    if (e.id !== notificationExpenseId || focusedExpenseId.current === e.id) return;
                    focusedExpenseId.current = e.id;
                    const y = expensesSectionY.current + event.nativeEvent.layout.y;
                    requestAnimationFrame(() => notificationScrollRef.current?.scrollTo({
                      y: Math.max(0, y - SPACING.lg), animated: false,
                    }));
                  }}
                >
                <Card onPress={offlineView ? undefined : () => router.push({ pathname: '/trip/[id]/edit-expense', params: { id: id as string, eid: e.id } })}
                  style={e.id === notificationExpenseId
                    ? { borderColor: colors.primary, borderWidth: 2 }
                    : undefined}
                  testID={`expense-item-${e.id}`}>
                  <View style={styles.rowCard}>
                    <View style={[styles.catDot, { backgroundColor: e.amount < 0 ? colors.success : colors.primary }]} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <T variant="h4" numberOfLines={1}>{e.description || e.category}</T>
                      <T muted variant="caption" numberOfLines={1}>
                        {e.date}{e.time ? ` · ${formatTime12h(e.time)}` : ''} · {e.category} · by {displayNames[e.paid_by_member_id] || '?'}
                      </T>
                      {e.has_receipt ? (
                        token && !offlineView ? (
                          <TouchableOpacity testID={`expense-bill-${e.id}`} onPress={() => setViewerUri(receiptUrl(id as string, e.id, token))} style={{ marginTop: 6 }} accessibilityLabel="View bill">
                            <Image source={{ uri: receiptUrl(id as string, e.id, token) }} style={[styles.billThumb, { borderColor: colors.border }]} />
                          </TouchableOpacity>
                        ) : <T variant="caption" muted>Receipt available online</T>
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
                    {e.original_currency && e.original_currency !== trip.currency
                      && e.original_amount != null ? (
                      <T variant="caption" muted testID={`expense-original-${e.id}`}>
                        originally {formatMoney(Number(e.original_amount), { currency: e.original_currency })}
                      </T>
                    ) : null}
                    </View>
                    {!offlineView && canModifyExpense(e, user?.id, trip, isApplicationAdmin) && (
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
                                  <T variant="caption" muted>
                                    {verbs.participantVerb} {formatMoney(ent.share, {
                                      currency: trip.currency, showCurrency: false,
                                    })}
                                  </T>
                                </View>
                                {ent.members.map((sub) => (
                                  <View key={sub.id} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: SPACING.sm, paddingLeft: SPACING.md }}>
                                    <T variant="caption" muted numberOfLines={1} style={{ flex: 1, minWidth: 0 }}>↳ {sub.name}</T>
                                    <T variant="caption" muted>{formatMoney(sub.share, {
                                      currency: trip.currency, showCurrency: false,
                                    })}</T>
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
                </View>
              ))}
            </View>
          )}

          {tab === 'balances' && balances && (
            <View style={{ gap: SPACING.sm }}>
              {balances.per_person.map((pp) => {
                const mine = pp.member_id === trip.members.find((m) => m.user_id === user?.id)?.id;
                return (
                  <Card key={pp.member_id}>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm }}>
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
                              {formatMoney(fm.net, {
                                currency: trip.currency, signed: true, showCurrency: false,
                              })}
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
                  <T variant="label" muted style={{ marginTop: SPACING.md }}>
                    Suggested settlements
                  </T>
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
                    whole={balances.settlement_projection?.enabled}
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
              {offlineView ? (
                <T variant="caption" muted testID="members-contacts-unavailable">
                  Saved roster. Contact details are available when connected.
                </T>
              ) : null}
              {!offlineView ? <MembershipCard tripId={trip.id} /> : null}
              {canCreateSecureInvite ? (
                <InviteLinksPanel
                  tripId={trip.id}
                  canReset={meCanManageMembers}
                  onShare={shareCode}
                />
              ) : null}
              {meCanManageMembers && !offlineView ? (
                <JoinRequestsPanel tripId={trip.id} onRosterChanged={load} />
              ) : null}
              {meCanManageMembers && !offlineView ? (
                <Card onPress={() => router.push(`/trip/${id}/add-member`)} testID="trip-add-member"
                  style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACING.sm }}>
                  <Icon name="plus" size={18} color={colors.primary} />
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Add member or family</T>
                </Card>
              ) : (
                <T testID="members-readonly-note" variant="caption" muted style={{ paddingHorizontal: SPACING.xs }}>
                  {offlineView ? 'Member changes require a connection.'
                    : 'Only trip admins can add or change members.'}
                </T>
              )}
              {trip.members.map((m) => {
                const role = memberRole(m);
                const manageBtn = meCanManageMembers && !offlineView ? (
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
                  const subMobiles = m.family_member_mobile_numbers || [];
                  const subIds = m.family_member_ids || [];
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
                          const phoneTestID = `member-mobile-${subIds[i] || `${m.id}-${i}`}`;
                          return (
                            <View
                              key={subIds[i] || i}
                              testID={`member-${m.id}-sub-${i}`}
                              style={[
                                styles.familyPerson,
                                i > 0 && {
                                  borderTopWidth: StyleSheet.hairlineWidth,
                                  borderTopColor: colors.border,
                                },
                              ]}
                            >
                              <View style={styles.personHeading}>
                                <T numberOfLines={1} style={styles.personName}>{nm}</T>
                                {subRole === 'owner' ? <Badge label="Owner" color={colors.primary} /> : null}
                                {subRole === 'admin' ? <Badge label="Admin" color={colors.success} /> : null}
                                {uid && uid === user?.id ? (
                                  <Badge label="You" color={colors.textMuted} />
                                ) : uid && subRole !== 'owner' && subRole !== 'admin' ? (
                                  <Badge label="Linked" color={colors.success} />
                                ) : null}
                              </View>
                              {subEmails[i] || subMobiles[i] ? (
                                <View style={styles.contactStack}>
                                  {subEmails[i] ? (
                                    <View style={styles.emailLine}>
                                      <Icon name="mail" size={15} color={colors.textMuted} />
                                      <T variant="caption" muted numberOfLines={1} style={styles.contactText}>
                                        {subEmails[i]}
                                      </T>
                                    </View>
                                  ) : null}
                                  {subMobiles[i] ? (
                                    <MobileContactLine
                                      number={subMobiles[i] as string}
                                      testID={phoneTestID}
                                      onPress={() => setMobileContact({
                                        number: subMobiles[i] as string,
                                        name: nm,
                                        testID: phoneTestID,
                                      })}
                                    />
                                  ) : null}
                                </View>
                              ) : null}
                            </View>
                          );
                        })}
                      </View>
                    </Card>
                  );
                }

                // Individual: unchanged single-row card.
                const phoneTestID = `member-mobile-${m.id}`;
                return (
                  <Card key={m.id}>
                    <View style={styles.rowCard}>
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
                    </View>
                    {m.mobile_number ? (
                      <View style={styles.individualContacts}>
                        <MobileContactLine
                          number={m.mobile_number}
                          testID={phoneTestID}
                          onPress={() => setMobileContact({
                            number: m.mobile_number as string,
                            name: displayNames[m.id],
                            testID: phoneTestID,
                          })}
                        />
                      </View>
                    ) : null}
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <ReceiptViewer uri={viewerUri} visible={!!viewerUri} onClose={() => setViewerUri(null)} />

      <ActionSheet
        visible={!!mobileContact}
        onClose={() => setMobileContact(null)}
        title={mobileContact ? `Contact ${mobileContact.name}` : 'Contact member'}
        message={mobileContact ? formatMobileForDisplay(mobileContact.number) : undefined}
        testID="member-mobile-actions"
        actions={[
          {
            label: 'Call',
            icon: 'call',
            testID: mobileContact ? `${mobileContact.testID}-call` : 'member-mobile-call',
            onPress: () => { void callMobile(); },
          },
          {
            label: 'Copy number',
            icon: 'copy',
            testID: mobileContact ? `${mobileContact.testID}-copy` : 'member-mobile-copy',
            onPress: () => { void copyMobile(); },
          },
        ]}
      />

      {tripConfirmModal}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  privilegedRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md },
  privilegedIcon: {
    width: 40,
    height: 40,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  privilegedCopy: { flex: 1, minWidth: 0, gap: SPACING.xs },
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
  familyPerson: { paddingVertical: SPACING.sm, gap: SPACING.xs },
  personHeading: {
    flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: SPACING.sm,
  },
  personName: { flexShrink: 1, minWidth: 0 },
  contactStack: { gap: SPACING.xs },
  emailLine: {
    minHeight: 24, flexDirection: 'row', alignItems: 'center', gap: SPACING.sm,
  },
  contactText: { flex: 1, minWidth: 0 },
  contactLine: {
    minHeight: COMPONENT_SIZE.minTouchTarget,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingRight: SPACING.sm,
    borderRadius: RADIUS.sm,
  },
  individualContacts: { marginTop: SPACING.xs, marginLeft: 40 + SPACING.md },
  catDot: { width: 10, height: 10, borderRadius: 5 },
  billThumb: { width: 44, height: 44, borderRadius: RADIUS.md, borderWidth: 1 },
  memberIcon: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  transferIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  youCard: {
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 2,
  },
  youSummary: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: SPACING.sm,
  },
  youIdentity: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
  youBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: RADIUS.pill },
  paymentDetailsToggle: {
    width: '100%',
    minHeight: COMPONENT_SIZE.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
    marginTop: SPACING.sm,
  },
  paymentDetailsToggleText: {
    flex: 1,
    minWidth: 0,
    fontFamily: FONTS.bodyBold,
  },
  paymentDetails: {
    width: '100%',
    borderTopWidth: 1,
    paddingTop: SPACING.sm,
    gap: SPACING.sm,
  },
  paymentTransferRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  paymentTransferSentence: { flex: 1, minWidth: 0 },
  paymentPartyName: { fontFamily: FONTS.bodyBold },
  paymentTransferAmount: { fontFamily: FONTS.number },
});
