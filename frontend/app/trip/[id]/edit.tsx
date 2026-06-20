import React, { useEffect, useState } from 'react';
import { View, ScrollView, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, CURRENCIES, CONTENT_MAX_WIDTH } from '../../../src/theme';
import T from '../../../src/T';
import { Input, Button, Pill, useToast } from '../../../src/ui';

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api<any>(`/trips/${id}`).then((t) => {
      setName(t.name); setDate(t.travel_date);
      setBudget(t.budget ? String(t.budget) : ''); setCurrency(t.currency || 'INR');
    });
  }, [id]);

  const save = async () => {
    setSaving(true);
    try {
      await api(`/trips/${id}`, {
        method: 'PATCH',
        body: { name, travel_date: date, budget: budget ? Number(budget) : null, currency },
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
            <Input testID="et-date" label="Travel date (DD-MM-YY)" value={date} onChangeText={setDate} icon="calendar" />
            <Input testID="et-budget" label="Budget" value={budget} onChangeText={setBudget} keyboardType="decimal-pad" icon="wallet" />

            <View>
              <T variant="label" muted style={{ marginBottom: SPACING.xs }}>Currency</T>
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                  {CURRENCIES.map((c) => (
                    <Pill key={c} label={c} active={currency === c} onPress={() => setCurrency(c)} />
                  ))}
                </View>
              </ScrollView>
            </View>

            <Button label="Save" icon="check" onPress={save} loading={saving} fullWidth size="lg" testID="et-save" style={{ marginTop: SPACING.sm }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
