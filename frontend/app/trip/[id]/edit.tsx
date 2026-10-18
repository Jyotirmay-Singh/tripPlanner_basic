import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import { FormScreen, Input, DateField, Button, CurrencyPicker, EmptyState, SkeletonCard, useToast } from '../../../src/ui';
import { fromISO, toISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../../../src/date';
import { currencyAmountPlaceholder, currencyPrecisionIssue } from '../../../src/currencies';
import { useAuth } from '../../../src/AuthContext';
import DebtSimplificationSetting from '../../../src/DebtSimplificationSetting';
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
  const accountId = user?.id;
  const [trip, setTrip] = useState<EditableTrip | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [simplifyDebts, setSimplifyDebts] = useState(true);
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
    setTrip(null); setLoadError(null);
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

            <DebtSimplificationSetting
              value={simplifyDebts}
              onChange={setSimplifyDebts}
              canChange={canChangeDebts}
              disabled={!canSave || saving}
              hasSettlements={hasSettlements}
              offline={sessionMode === 'offline'}
              testIDPrefix="et"
            />

            <Button label="Save" icon="check" onPress={save} loading={saving} disabled={!canSave || !!budgetPrecisionIssue} fullWidth size="lg" testID="et-save" />
          </View>
    </FormScreen>
  );
}
