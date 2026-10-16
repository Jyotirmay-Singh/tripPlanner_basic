import React, { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { SPACING, CONTENT_MAX_WIDTH, COMPONENT_SIZE, FONTS, TYPESCALE } from '../../../src/theme';
import { FormScreen, Input, DateField, Button, CurrencyPicker, Card, Icon, EmptyState, SkeletonCard, useToast } from '../../../src/ui';
import { fromISO, toISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../../../src/date';
import { currencyAmountPlaceholder, currencyPrecisionIssue } from '../../../src/currencies';
import { useAuth } from '../../../src/AuthContext';
import { useTheme } from '../../../src/ThemeContext';
import T from '../../../src/T';
import ConfirmModal from '../../../src/ConfirmModal';
import { canChangeDebtSimplification, canEditTripSettings, type RoleTrip } from '../../../src/permissions';
import { refreshTripSettingsReads } from '../../../src/offlineReads';

type EditableTrip = RoleTrip & {
  name: string; start_date?: string | null; end_date?: string | null;
  budget?: number | null; currency?: string; simplify_debts?: boolean;
};

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const { user, sessionMode } = useAuth();
  const { colors } = useTheme();
  const accountId = user?.id;
  const [trip, setTrip] = useState<EditableTrip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [simplifyDebts, setSimplifyDebts] = useState(true);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [showDebtInfo, setShowDebtInfo] = useState(false);
  const [hasSettlements, setHasSettlements] = useState(false);
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateError, setDateError] = useState<{
    field: 'start' | 'end'; message: string;
  } | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);
  const [budgetError, setBudgetError] = useState<string | null>(null);
  const budgetPrecisionIssue = currencyPrecisionIssue(budget, currency, 'Budget');
  const canChangeDebts = !!trip && canChangeDebtSimplification(trip, accountId, user?.is_super_admin === true);
  const canSave = !!trip && canEditTripSettings(trip, accountId, user?.is_super_admin === true)
    && sessionMode !== 'offline';

  useEffect(() => {
    let active = true;
    setTrip(null); setLoadError(null); setConfirmDisable(false); setShowDebtInfo(false);
    Promise.allSettled([
      api<EditableTrip>(`/trips/${id}`),
      api<unknown[]>(`/trips/${id}/payments`),
      api<{ status?: string }[]>(`/trips/${id}/settlements`),
    ]).then(([tripResult, paymentResult, settlementResult]) => {
      if (!active) return;
      if (tripResult.status === 'rejected') {
        setLoadError(tripResult.reason?.message || 'Could not load group settings.');
        return;
      }
      const t = tripResult.value;
      setName(t.name);
      setStartDate(fromISO(t.start_date)); setEndDate(fromISO(t.end_date));
      setBudget(t.budget ? String(t.budget) : ''); setCurrency(t.currency || 'INR');
      setSimplifyDebts(t.simplify_debts ?? true);
      setHasSettlements(paymentResult.status === 'rejected' || settlementResult.status === 'rejected'
        || paymentResult.value.length > 0
        || settlementResult.value.some((row) => row.status !== 'pending'));
      setTrip(t);
    });
    return () => { active = false; };
  }, [id, accountId, loadAttempt]);

  const requestDebtSetting = (enabled: boolean) => {
    if (!canChangeDebts || !canSave || saving) return;
    if (enabled) setSimplifyDebts(true);
    else setConfirmDisable(true);
  };

  const save = async () => {
    if (!canSave || saving) return;
    const startISO = startDate.trim() ? toISO(startDate) : null;
    const endISO = endDate.trim() ? toISO(endDate) : null;
    if (startDate.trim() && !startISO) {
      setDateError({ field: 'start', message: INVALID_DATE_MESSAGE });
      return;
    }
    if (endDate.trim() && !endISO) {
      setDateError({ field: 'end', message: INVALID_DATE_MESSAGE });
      return;
    }
    if (startISO && endISO && !isRangeValid(startISO, endISO)) {
      setDateError({ field: 'end', message: END_BEFORE_START_MESSAGE });
      return;
    }
    setDateError(null);
    if (budgetPrecisionIssue) {
      setBudgetError(budgetPrecisionIssue);
      return toast.show(budgetPrecisionIssue, 'error');
    }
    if (budget.trim() && !Number.isFinite(Number(budget))) {
      setBudgetError('Enter a valid budget');
      return toast.show('Enter a valid budget', 'error');
    }
    setBudgetError(null);
    setSaving(true);
    try {
      await api(`/trips/${id}`, {
        method: 'PATCH',
        body: {
          name, start_date: startISO, end_date: endISO, budget: budget ? Number(budget) : null,
          ...(canChangeDebts && simplifyDebts !== (trip?.simplify_debts ?? true)
            ? { simplify_debts: simplifyDebts } : {}),
        },
      });
      let refreshed = false;
      if (accountId) {
        try { refreshed = await refreshTripSettingsReads(accountId, id); } catch { /* Saved; refresh can retry on focus. */ }
      }
      toast.show(refreshed ? 'Group updated' : 'Group saved. Reconnect to refresh saved views.', 'success');
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
    finally { setSaving(false); }
  };

  if (!trip) {
    return <FormScreen>
      {loadError ? <EmptyState icon="alert" title="Group settings unavailable" body={loadError}
        ctaLabel="Try again" onCta={() => setLoadAttempt((attempt) => attempt + 1)} testID="et-load-error" />
        : <SkeletonCard count={3} />}
    </FormScreen>;
  }

  return (
    <FormScreen>
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <Input
              testID="et-name"
              label="Name"
              value={name}
              onChangeText={setName}
              icon="plane"
              autoCapitalize="words"
              returnKeyType="next"
            />
            <DateField
              testID="et-start"
              label="Start date (dd/mm/yyyy)"
              value={startDate}
              onChangeText={(v) => { setStartDate(v); setDateError(null); }}
              error={dateError?.field === 'start' ? dateError.message : null}
            />
            <DateField
              testID="et-end"
              label="End date (dd/mm/yyyy)"
              value={endDate}
              onChangeText={(v) => { setEndDate(v); setDateError(null); }}
              error={dateError?.field === 'end' ? dateError.message : null}
              minISO={toISO(startDate) ?? undefined}
            />
            <Input
              testID="et-budget"
              label="Budget"
              value={budget}
              onChangeText={(value) => { setBudget(value); setBudgetError(null); }}
              keyboardType="number-pad"
              placeholder={currencyAmountPlaceholder(currency)}
              error={budgetError || budgetPrecisionIssue}
              focusOnError={!!budgetError}
              icon="wallet"
              inputMode="numeric"
              autoComplete="off"
              returnKeyType="done"
            />

            <CurrencyPicker
              testID="et-currency"
              label="Official currency"
              value={currency}
              disabled
              helper="Locked when the group was created so balances and settlements stay consistent."
            />

            <Card testID="et-debt-settings" padding="none" style={styles.debtSettings}>
              <View style={styles.toggleRow}>
                <Pressable
                  testID="et-debt-info"
                  accessibilityRole="button"
                  accessibilityLabel="About debt simplification"
                  onPress={() => setShowDebtInfo(true)}
                  style={({ pressed, focused }: { pressed: boolean; focused?: boolean }) => [
                    styles.settingCopy,
                    pressed && { opacity: 0.8 },
                    focused && Platform.OS === 'web' && {
                      outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2,
                    },
                  ]}
                >
                  <View style={styles.settingHeading}>
                    <T style={styles.settingTitle}>Simplify group debts</T>
                    <Icon name="info" size={16} color={colors.textMuted} />
                  </View>
                  <T variant="caption" muted style={styles.recommendation}>
                    {simplifyDebts ? 'Recommended: Fewer payments and simpler settlement.'
                      : 'Members repay expense payers directly, with mutual debts offset between each pair.'}
                  </T>
                </Pressable>
                <View style={styles.switchTarget}>
                  <Pressable style={StyleSheet.absoluteFill}
                    accessible={false} accessibilityElementsHidden
                    importantForAccessibility="no-hide-descendants" focusable={false} tabIndex={-1}
                    disabled={!canChangeDebts || !canSave || saving}
                    onPress={() => requestDebtSetting(!simplifyDebts)} />
                  <Switch
                    testID="et-simplify-debts"
                    accessibilityLabel="Simplify group debts"
                    accessibilityHint={canChangeDebts
                      ? 'Combine balances to reduce repayments. Turning off requires confirmation.'
                      : 'Only the group owner or application administrator can change this setting.'}
                    value={simplifyDebts}
                    disabled={!canChangeDebts || !canSave || saving}
                    onValueChange={requestDebtSetting}
                    hitSlop={12}
                    style={Platform.OS === 'web' ? styles.webSwitch : styles.nativeSwitch}
                    {...(Platform.OS === 'web' ? { activeThumbColor: colors.primaryText } : {})}
                    trackColor={{ false: colors.border, true: colors.primary }}
                    thumbColor={simplifyDebts ? colors.primaryText : colors.textMuted}
                    ios_backgroundColor={colors.border}
                  />
                </View>
              </View>
              {hasSettlements ? <T variant="caption" muted testID="et-debt-carryover">
                Completed settlements remain cleared. Earlier unpaid settlement pairs may carry forward.
              </T> : null}
              {!canChangeDebts ? <T variant="caption" muted>Managed by the group owner.</T> : null}
              {sessionMode === 'offline' ? <T variant="caption" muted>Connect to update group settings.</T> : null}
            </Card>

            <Button label="Save" icon="check" onPress={save} loading={saving} disabled={!canSave || !!budgetPrecisionIssue} fullWidth size="lg" testID="et-save" />
          </View>
          {showDebtInfo ? <ConfirmModal
            visible
            title="About debt simplification"
            message={<>
              We combine group balances to{' '}
              <T muted style={styles.emphasis}>reduce the number of repayments</T>.
              {' '}You may pay someone other than the original expense payer, while everyone’s share of the expenses stays the same.
            </>}
            onRequestClose={() => setShowDebtInfo(false)}
            testID="et-debt-info-dialog"
            actions={[{ label: 'Got it', variant: 'primary', onPress: () => setShowDebtInfo(false) }]}
          /> : null}
          <ConfirmModal
            visible={confirmDisable}
            title="Turn off debt simplification?"
            message={'Members will repay the original expense payers, with mutual debts offset. Turning off debt simplification may increase the number of payments required to settle the group.'
              + (hasSettlements ? '\n\nCompleted settlements remain cleared. Earlier unpaid settlement pairs may carry forward.' : '')}
            onRequestClose={() => setConfirmDisable(false)}
            testID="et-debt-confirm"
            actions={[
              { label: 'Keep enabled', variant: 'cancel', onPress: () => setConfirmDisable(false), testID: 'et-debt-keep' },
              { label: 'Turn off', variant: 'primary', testID: 'et-debt-disable', onPress: () => {
                setSimplifyDebts(false); setConfirmDisable(false);
              } },
            ]}
          />
    </FormScreen>
  );
}

const styles = StyleSheet.create({
  emphasis: { fontFamily: FONTS.bodyBold },
  debtSettings: { padding: SPACING.sm, gap: SPACING.xs },
  settingCopy: { flex: 1, minWidth: 0, minHeight: COMPONENT_SIZE.minTouchTarget, justifyContent: 'center', gap: SPACING.xs },
  settingHeading: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  settingTitle: { flexShrink: 1, fontFamily: FONTS.bodyMedium, fontSize: TYPESCALE.md, lineHeight: 22 },
  recommendation: { fontFamily: FONTS.body, fontSize: TYPESCALE.xs, lineHeight: 18 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACING.xs },
  webSwitch: { width: 40, height: 20 },
  nativeSwitch: { transform: [{ scale: 0.78 }] },
  switchTarget: { minHeight: COMPONENT_SIZE.minTouchTarget, width: COMPONENT_SIZE.minTouchTarget, flexShrink: 0, justifyContent: 'center', alignItems: 'center' },
});
