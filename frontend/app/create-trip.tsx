import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform, ScrollView, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS, CONTROL, CURRENCIES } from '../src/theme';
import T from '../src/T';

function toDDMMYY(d: Date) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}-${mm}-${yy}`;
}

export default function CreateTrip() {
  const { colors } = useTheme();
  const router = useRouter();
  const [name, setName] = useState('');
  const [date, setDate] = useState(toDDMMYY(new Date()));
  const [budget, setBudget] = useState('');
  const [currency, setCurrency] = useState('INR');

  const submit = async () => {
    if (!name.trim() || !date.trim()) return Alert.alert('Missing', 'Name and travel date are required');
    try {
      const trip = await api<{ id: string }>('/trips', {
        method: 'POST',
        body: {
          name: name.trim(),
          travel_date: date.trim(),
          budget: budget ? Number(budget) : null,
          currency,
        },
      });
      router.replace(`/trip/${trip.id}`);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['bottom']}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ padding: SPACING.lg, gap: SPACING.md }} keyboardShouldPersistTaps="handled">
          <T variant="h1">New Trip</T>

          <View>
            <T variant="label" muted>Trip name *</T>
            <TextInput testID="ct-name" value={name} onChangeText={setName}
              placeholder="e.g. Goa December" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Travel date (DD-MM-YY) *</T>
            <TextInput testID="ct-date" value={date} onChangeText={setDate}
              placeholder="15-12-26" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Budget (optional)</T>
            <TextInput testID="ct-budget" value={budget} onChangeText={setBudget}
              keyboardType="decimal-pad" placeholder="0" placeholderTextColor={colors.textMuted}
              style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />
          </View>

          <View>
            <T variant="label" muted>Currency</T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: SPACING.xs }}>
              <View style={{ flexDirection: 'row', gap: SPACING.sm }}>
                {CURRENCIES.map((c) => (
                  <TouchableOpacity key={c} onPress={() => setCurrency(c)}
                    testID={`ct-cur-${c}`}
                    style={[styles.pill, { backgroundColor: currency === c ? colors.primary : colors.surfaceMuted, borderColor: colors.border }]}>
                    <T color={currency === c ? colors.primaryText : colors.textMain} style={{ fontWeight: '700' }}>{c}</T>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </View>

          <TouchableOpacity testID="ct-submit" onPress={submit}
            style={[styles.btn, { backgroundColor: colors.primary }]}>
            <Ionicons name="checkmark" size={18} color={colors.primaryText} />
            <T color={colors.primaryText} style={{ fontWeight: '700' }}>Create trip</T>
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { marginTop: 4, paddingHorizontal: SPACING.md, paddingVertical: CONTROL.paddingY, borderRadius: CONTROL.radius, borderWidth: 1, fontSize: CONTROL.fontSize },
  pill: { paddingHorizontal: 14, paddingVertical: 10, borderRadius: RADIUS.pill, borderWidth: 1 },
  btn: { marginTop: SPACING.md, flexDirection: 'row', gap: SPACING.xs, paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center' },
});
