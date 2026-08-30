import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { Input, DateField, Button, CurrencyPicker, useToast } from '../../../src/ui';
import { fromISO, toISO, isRangeValid, INVALID_DATE_MESSAGE, END_BEFORE_START_MESSAGE } from '../../../src/date';

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [dateError, setDateError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<any>(`/trips/${id}`).then((t) => {
      setName(t.name);
      setStartDate(fromISO(t.start_date)); setEndDate(fromISO(t.end_date));
      setBudget(t.budget ? String(t.budget) : ''); setCurrency(t.currency || 'INR');
    });
  }, [id]);

  const save = async () => {
    const startISO = startDate.trim() ? toISO(startDate) : null;
    const endISO = endDate.trim() ? toISO(endDate) : null;
    if ((startDate.trim() && !startISO) || (endDate.trim() && !endISO)) {
      setDateError(INVALID_DATE_MESSAGE);
      return;
    }
    if (startISO && endISO && !isRangeValid(startISO, endISO)) {
      setDateError(END_BEFORE_START_MESSAGE);
      return;
    }
    setDateError(null);
    setSaving(true);
    try {
      await api(`/trips/${id}`, {
        method: 'PATCH',
        body: { name, start_date: startISO, end_date: endISO, budget: budget ? Number(budget) : null },
      });
      router.back();
    } catch (e: any) { toast.show(e.message || 'Could not save', 'error'); }
    finally { setSaving(false); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, alignItems: 'center' }} keyboardShouldPersistTaps="handled">
          <View style={{ width: '100%', maxWidth: CONTENT_MAX_WIDTH, gap: SPACING.md }}>
            <T variant="h1">Edit trip</T>

            <Input testID="et-name" label="Name" value={name} onChangeText={setName} icon="plane" />
            <DateField testID="et-start" label="Start date (dd/mm/yyyy)" value={startDate} onChangeText={(v) => { setStartDate(v); setDateError(null); }} error={dateError} />
            <DateField testID="et-end" label="End date (dd/mm/yyyy)" value={endDate} onChangeText={(v) => { setEndDate(v); setDateError(null); }} minISO={toISO(startDate) ?? undefined} />
            <Input testID="et-budget" label="Budget" value={budget} onChangeText={setBudget} keyboardType="decimal-pad" icon="wallet" />

            <CurrencyPicker
              testID="et-currency"
              label="Official currency"
              value={currency}
              disabled
              helper="Locked when the trip was created so balances and settlements stay consistent."
            />

            <Button label="Save" icon="check" onPress={save} loading={saving} fullWidth size="lg" testID="et-save" style={{ marginTop: SPACING.sm }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
