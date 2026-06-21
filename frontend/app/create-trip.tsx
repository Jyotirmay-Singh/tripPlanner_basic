import React, { useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, CURRENCIES, CONTENT_MAX_WIDTH } from '../src/theme';
import T from '../src/T';
import { Input, DateField, Button, Pill, useToast } from '../src/ui';
import { fromISO, toISO, todayISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../src/date';

export default function CreateTrip() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState(fromISO(todayISO()));
  const [endDate, setEndDate] = useState(fromISO(todayISO()));
  const [dateError, setDateError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim()) return toast.show('Trip name is required', 'error');
    const startISO = toISO(startDate);
    const endISO = toISO(endDate);
    if (!startISO || !endISO) { setDateError(INVALID_DATE_MESSAGE); return; }
    if (!isRangeValid(startISO, endISO)) { setDateError(END_BEFORE_START_MESSAGE); return; }
    setDateError(null);
    setSaving(true);
    try {
      const trip = await api<{ id: string }>('/trips', {
        method: 'POST',
        body: { name: name.trim(), start_date: startISO, end_date: endISO, budget: budget ? Number(budget) : null, currency },
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

            <Button label="Create trip" icon="check" onPress={submit} loading={saving} fullWidth size="lg" testID="ct-submit" style={{ marginTop: SPACING.sm }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
