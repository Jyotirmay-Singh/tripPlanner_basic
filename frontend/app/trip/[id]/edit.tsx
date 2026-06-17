import React, { useEffect, useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, ScrollView, Alert, KeyboardAvoidingView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api } from '../../../src/api';
import { useTheme } from '../../../src/ThemeContext';
import { SPACING, RADIUS, CONTROL, CURRENCIES } from '../../../src/theme';
import T from '../../../src/T';

export default function EditTrip() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const router = useRouter();
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');

  useEffect(() => {
    api<any>(`/trips/${id}`).then((t) => {
      setName(t.name); setDate(t.travel_date);
      setBudget(t.budget ? String(t.budget) : ''); setCurrency(t.currency || 'INR');
    });
  }, [id]);

  const save = async () => {
    try {
      await api(`/trips/${id}`, {
        method: 'PATCH',
        body: { name, travel_date: date, budget: budget ? Number(budget) : null, currency },
      });
      router.back();
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <T variant="h1">Edit trip</T>

          <View>
            <T variant="label" muted>Name</T>
            <TextInput testID="et-name" value={name} onChangeText={setName}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Travel date (DD-MM-YY)</T>
            <TextInput testID="et-date" value={date} onChangeText={setDate}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Budget</T>
            <TextInput testID="et-budget" value={budget} onChangeText={setBudget} keyboardType="decimal-pad"
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Currency</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 4 }}>
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                {CURRENCIES.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setCurrency(c)}
                    style={[styles.pill, { backgroundColor: currency === c ? colors.primary : colors.surfaceMuted, borderColor: colors.border }]}>
                    <T color={currency === c ? colors.primaryText : colors.textMain} style={{ fontWeight: '700' }}>{c}</T>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <TouchableOpacity testID="et-save" onPress={save}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            <T color={colors.primaryText} variant="h3">Save</T>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: CONTROL.paddingY, borderRadius: CONTROL.radius, borderWidth: 1, fontSize: CONTROL.fontSize },
  pill: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  btn: { marginTop: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
