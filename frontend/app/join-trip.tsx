import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { api } from '../src/api';
import { useTheme } from '../src/ThemeContext';
import { SPACING, RADIUS } from '../src/theme';
import T from '../src/T';

export default function JoinTrip() {
  const { colors } = useTheme();
  const router = useRouter();
  const [code, setCode] = useState('');

  const submit = async () => {
    if (code.length !== 6) return Alert.alert('Invalid', 'Trip code is 6 characters');
    try {
      const trip = await api<{ id: string; name: string }>('/trips/join', {
        method: 'POST', body: { code: code.toUpperCase().trim() },
      });
      Alert.alert('Joined!', `Welcome to ${trip.name}`, [
        { text: 'OK', onPress: () => router.replace(`/trip/${trip.id}`) },
      ]);
    } catch (e: any) { Alert.alert('Error', e.message); }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background, padding: SPACING.lg }} edges={['bottom']}>
      <T variant="h1">Join a trip</T>
      <T muted style={{ marginTop: 4 }}>Enter the 6-character trip code your friend shared.</T>

      <View style={{ marginTop: SPACING.xl, gap: SPACING.md }}>
        <TextInput testID="jt-code" value={code}
          onChangeText={(v) => setCode(v.toUpperCase().replace(/\s/g, '').slice(0, 6))}
          placeholder="ABCD12" placeholderTextColor={colors.textMuted}
          autoCapitalize="characters"
          style={[styles.input, { color: colors.textMain, backgroundColor: colors.surfaceMuted, borderColor: colors.border }]} />

        <TouchableOpacity testID="jt-submit" onPress={submit}
          style={[styles.btn, { backgroundColor: colors.primary }]}>
          <T color={colors.primaryText} variant="h3">Join trip</T>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  input: { paddingHorizontal: SPACING.md, paddingVertical: 16, borderRadius: RADIUS.md, borderWidth: 1, fontSize: 24, letterSpacing: 6, textAlign: 'center', fontWeight: '700' },
  btn: { paddingVertical: 16, borderRadius: RADIUS.pill, alignItems: 'center' },
});
