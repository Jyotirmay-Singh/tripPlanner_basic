import React, { useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS, CONTENT_MAX_WIDTH } from '../src/theme';
import T from '../src/T';
import { FormScreen, Input, DateField, Button, CurrencyPicker, Pill, Icon, SegmentedControl, useToast } from '../src/ui';
import { toISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../src/date';
import { SelfKind, identityIssue, buildIdentityFields } from '../src/createIdentity';
import { currencyAmountPlaceholder, currencyPrecisionIssue } from '../src/currencies';

export default function CreateTrip() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateError, setDateError] = useState<{
    field: 'start' | 'end'; message: string;
  } | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);
  const [fieldError, setFieldError] = useState<{
    field: 'name' | 'budget' | 'familyName' | 'member'; message: string; index?: number;
  } | null>(null);
  const budgetPrecisionIssue = currencyPrecisionIssue(budget, currency, 'Budget');

  // Phase 26 — the creator's own identity in this trip. "individual" (default) keeps the legacy
  // behavior; "family" makes them ONE member of a family they set up here (their login email +
  // account attach to the "This is me" row server-side; the family entity carries no email).
  const [selfKind, setSelfKind] = useState<SelfKind>('individual');
  const [familyName, setFamilyName] = useState('');
  const [memberNames, setMemberNames] = useState<string[]>([user?.name ?? '']);
  const [selfIndex, setSelfIndex] = useState(0);

  const setMemberName = (i: number, v: string) => setMemberNames((rows) => rows.map((r, j) => (j === i ? v : r)));
  const addMember = () => setMemberNames((rows) => [...rows, '']);
  const removeMember = (i: number) => {
    setMemberNames((rows) => {
      const next = rows.filter((_, j) => j !== i);
      return next.length ? next : [''];
    });
    // Keep "This is me" pointing at the same row (shift left when a row before it is removed; the
    // removed row itself defaults back to row 0).
    setSelfIndex((cur) => (i < cur ? cur - 1 : i === cur ? 0 : cur));
  };

  const submit = async () => {
    if (!name.trim()) {
      setFieldError({ field: 'name', message: 'Trip name is required' });
      return toast.show('Trip name is required', 'error');
    }
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
      setFieldError({ field: 'budget', message: budgetPrecisionIssue });
      return toast.show(budgetPrecisionIssue, 'error');
    }
    if (budget.trim() && !Number.isFinite(Number(budget))) {
      setFieldError({ field: 'budget', message: 'Enter a valid budget' });
      return toast.show('Enter a valid budget', 'error');
    }
    const idIssue = identityIssue({ self_kind: selfKind, familyName, memberNames, selfIndex });
    if (idIssue) {
      setFieldError(idIssue === 'Family name is required'
        ? { field: 'familyName', message: idIssue }
        : { field: 'member', index: selfIndex, message: idIssue });
      return toast.show(idIssue, 'error');
    }
    setFieldError(null);
    setSaving(true);
    try {
      const trip = await api<{ id: string }>('/trips', {
        method: 'POST',
        body: {
          name: name.trim(), start_date: startISO, end_date: endISO,
          budget: budget ? Number(budget) : null, currency,
          ...buildIdentityFields({ self_kind: selfKind, familyName, memberNames, selfIndex }),
        },
      });
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) { toast.show(e.message || 'Could not create trip', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <FormScreen>
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">New Trip</T>

            <Input
              testID="ct-name"
              label="Trip name *"
              value={name}
              onChangeText={(value) => { setName(value); if (fieldError?.field === 'name') setFieldError(null); }}
              placeholder="e.g. Goa December"
              icon="plane"
              autoCapitalize="words"
              returnKeyType="next"
              error={fieldError?.field === 'name' ? fieldError.message : null}
              focusOnError={fieldError?.field === 'name'}
            />
            <DateField
              testID="ct-start"
              label="Start date (optional)"
              value={startDate}
              onChangeText={(v) => { setStartDate(v); setDateError(null); }}
              error={dateError?.field === 'start' ? dateError.message : null}
            />
            <DateField
              testID="ct-end"
              label="End date (optional)"
              value={endDate}
              onChangeText={(v) => { setEndDate(v); setDateError(null); }}
              error={dateError?.field === 'end' ? dateError.message : null}
              minISO={toISO(startDate) ?? undefined}
            />
            <Input
              testID="ct-budget"
              label="Budget (optional)"
              value={budget}
              onChangeText={(value) => { setBudget(value); if (fieldError?.field === 'budget') setFieldError(null); }}
              keyboardType="decimal-pad"
              placeholder={currencyAmountPlaceholder(currency)}
              error={fieldError?.field === 'budget' ? fieldError.message : budgetPrecisionIssue}
              focusOnError={fieldError?.field === 'budget'}
              icon="wallet"
              inputMode="decimal"
              autoComplete="off"
              returnKeyType={selfKind === 'family' ? 'next' : 'done'}
            />

            <CurrencyPicker
              testID="ct-currency"
              label="Official currency"
              value={currency}
              onChange={setCurrency}
              helper="Choose carefully — the official currency is locked after the trip is created."
            />

            <View style={{ gap: SPACING.sm }}>
              <T variant="label" muted>Who are you on this trip?</T>
              <SegmentedControl
                segments={[
                  { value: 'individual', label: "I'm an individual", icon: 'user' },
                  { value: 'family', label: "I'm in a family", icon: 'users' },
                ]}
                value={selfKind}
                onChange={(value) => { setSelfKind(value); setFieldError(null); }}
                testIDPrefix="ct-self"
              />
            </View>

            {selfKind === 'family' && (
              <View style={{ gap: SPACING.sm }}>
                <Input
                  testID="ct-family-name"
                  label="Family name *"
                  value={familyName}
                  onChangeText={(value) => { setFamilyName(value); if (fieldError?.field === 'familyName') setFieldError(null); }}
                  placeholder="e.g. Sharma Family"
                  icon="users"
                  autoCapitalize="words"
                  returnKeyType="next"
                  error={fieldError?.field === 'familyName' ? fieldError.message : null}
                  focusOnError={fieldError?.field === 'familyName'}
                />
                <T variant="label" muted>Family members *</T>
                {memberNames.map((nm, i) => (
                  <View
                    key={i}
                    style={{
                      gap: SPACING.sm, padding: SPACING.sm, borderWidth: 1,
                      borderColor: selfIndex === i ? colors.primary : colors.border,
                      borderRadius: RADIUS.md, backgroundColor: colors.surface,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACING.sm }}>
                      <View style={{ flex: 1 }}>
                        <Input
                          testID={`ct-fam-name-${i}`}
                          value={nm}
                          onChangeText={(t) => {
                            setMemberName(i, t);
                            if (fieldError?.field === 'member' && fieldError.index === i) setFieldError(null);
                          }}
                          placeholder={`Member ${i + 1}`}
                          autoCapitalize="words"
                          autoCorrect={false}
                          returnKeyType={i === memberNames.length - 1 ? 'done' : 'next'}
                          error={fieldError?.field === 'member' && fieldError.index === i
                            ? fieldError.message : null}
                          focusOnError={fieldError?.field === 'member' && fieldError.index === i}
                        />
                      </View>
                      {memberNames.length > 1 && (
                        <TouchableOpacity
                          testID={`ct-fam-remove-${i}`}
                          onPress={() => removeMember(i)}
                          accessibilityLabel={`Remove member ${i + 1}`}
                          hitSlop={8}
                        >
                          <Icon name="trash" size={18} color={colors.danger} />
                        </TouchableOpacity>
                      )}
                    </View>
                    <Pill
                      testID={`ct-fam-me-${i}`}
                      label={selfIndex === i ? '✓ This is me' : 'This is me'}
                      active={selfIndex === i}
                      onPress={() => setSelfIndex(i)}
                    />
                  </View>
                ))}
                <TouchableOpacity
                  testID="ct-fam-add"
                  onPress={addMember}
                  accessibilityRole="button"
                  accessibilityLabel="Add family member"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
                >
                  <Icon name="plus" size={16} color={colors.primary} />
                  <T color={colors.primary} style={{ fontWeight: '700' }}>Add member</T>
                </TouchableOpacity>
                <T variant="caption" muted>
                  Your login email links to the member you mark as “This is me”. A family has no email
                  of its own — each member can get their own later.
                </T>
              </View>
            )}

            <Button label="Create trip" icon="check" onPress={submit} loading={saving} disabled={!!budgetPrecisionIssue} fullWidth size="lg" testID="ct-submit" style={{ marginTop: SPACING.sm }} />
          </View>
    </FormScreen>
  );
}
