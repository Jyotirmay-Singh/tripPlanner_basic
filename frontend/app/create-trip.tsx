import React, { useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, CURRENCIES, CONTENT_MAX_WIDTH } from '../src/theme';
import T from '../src/T';
import { Input, Button, Pill, useToast } from '../src/ui';

function toDDMMYY(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

export default function CreateTrip() {
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [date, setDate] = useState(toDDMMYY(new Date()));
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!name.trim() || !date.trim()) return toast.show('Name and travel date are required', 'error');
    setSaving(true);
    try {
      const trip = await api<{ id: string }>('/trips', {
        method: 'POST',
        body: { name: name.trim(), travel_date: date.trim(), budget: budget ? Number(budget) : null, currency },
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
            <Input testID="ct-date" label="Travel date (DD-MM-YY) *" value={date} onChangeText={setDate} placeholder="15-12-26" icon="calendar" />
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
