import React, { useState } from 'react';
import { View, ScrollView, TouchableOpacity, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useAuth } from '../src/AuthContext';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS, CURRENCIES, CONTENT_MAX_WIDTH } from '../src/theme';
import T from '../src/T';
import { Input, DateField, Button, Pill, Icon, SegmentedControl, useToast } from '../src/ui';
import { fromISO, toISO, todayISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../src/date';
import { SelfKind, identityIssue, buildIdentityFields } from '../src/createIdentity';

export default function CreateTrip() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(fromISO(todayISO()));
  const [endDate, setEndDate] = useState(fromISO(todayISO()));
  const [dateError, setDateError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);

  // Phase 26 — the creator's own identity in this trip. "individual" (default) keeps the legacy
  // behavior; "family" makes them ONE member of a family they set up here (their login email +
  // account attach to the "This is me" row server-side; the family entity carries no email).
  const [selfKind, setSelfKind] = useState<SelfKind>('individual');
  const [familyName, setFamilyName] = useState('');
  const [memberNames, setMemberNames] = useState<string[]>([user?.name ?? '']);
  const [selfIndex, setSelfIndex] = useState(0);

  const setMemberName = (i: number, v: string) => setMemberNames((rows) => rows.map((r, j) => (j === i ? v : r)));
  const addMember = () => setMemberNames((rows) => [...rows, '']);
  const removeMember = (i: number) => setMemberNames((rows) => {
    const next = rows.filter((_, j) => j !== i);
    // Keep "This is me" pointing at the same row (shift left if a row before it was removed).
    setSelfIndex((cur) => (i < cur ? cur - 1 : i === cur ? 0 : cur));
    return next.length ? next : [''];
  });

  const submit = async () => {
    if (!name.trim()) return toast.show('Trip name is required', 'error');
    const startISO = toISO(startDate);
    const endISO = toISO(endDate);
    if (!startISO || !endISO) { setDateError(INVALID_DATE_MESSAGE); return; }
    if (!isRangeValid(startISO, endISO)) { setDateError(END_BEFORE_START_MESSAGE); return; }
    setDateError(null);
    const idIssue = identityIssue({ self_kind: selfKind, familyName, memberNames, selfIndex });
    if (idIssue) return toast.show(idIssue, 'error');
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">New Trip</T>

            <Input testID="ct-name" label="Trip name *" value={name} onChangeText={setName} placeholder="e.g. Goa December" icon="plane" />
            <DateField testID="ct-start" label="Start date (dd/mm/yyyy) *" value={startDate} onChangeText={(v) => { setStartDate(v); setDateError(null); }} error={dateError} />
            <DateField testID="ct-end" label="End date (dd/mm/yyyy) *" value={endDate} onChangeText={(v) => { setEndDate(v); setDateError(null); }} minISO={toISO(startDate) ?? undefined} />
            <Input testID="ct-budget" label="Budget (optional)" value={budget} onChangeText={setBudget} keyboardType="decimal-pad" placeholder="0" icon="wallet" />

            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Currency</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  {CURRENCIES.map((c) => (
                    <Pill key={c} testID={`ct-cur-${c}`} label={c} active={currency === c} onPress={() => setCurrency(c)} />
                  ))}
                </View>
              </ScrollView>
            </View>

            <View style={{ gap: SPACING.sm }}>
              <T variant="label" muted>Who are you on this trip?</T>
              <SegmentedControl
                segments={[
                  { value: 'individual', label: "I'm an individual", icon: 'user' },
                  { value: 'family', label: "I'm in a family", icon: 'users' },
                ]}
                value={selfKind}
                onChange={setSelfKind}
                testIDPrefix="ct-self"
              />
            </View>

            {selfKind === 'family' && (
              <View style={{ gap: SPACING.sm }}>
                <Input
                  testID="ct-family-name"
                  label="Family name *"
                  value={familyName}
                  onChangeText={setFamilyName}
                  placeholder="e.g. Sharma Family"
                  icon="users"
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
                          onChangeText={(t) => setMemberName(i, t)}
                          placeholder={`Member ${i + 1}`}
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

            <Button label="Create trip" icon="check" onPress={submit} loading={saving} fullWidth size="lg" testID="ct-submit" style={{ marginTop: SPACING.sm }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
