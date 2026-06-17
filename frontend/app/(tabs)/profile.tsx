import React from 'react';
import { View, TouchableOpacity, StyleSheet, Switch } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { useLogout } from '../../src/useLogout';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';

export default function Profile() {
  const { user } = useAuth();
  const { colors, mode, toggle } = useTheme();
  const { confirmAndSignOut } = useLogout();

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={['top']}>
      <View style={{ padding: SPACING.lg, gap: SPACING.md }}>
        <T variant="h1">Profile</T>

        <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
            <T color={colors.primaryText} variant="h2">{(user?.name || '?').charAt(0).toUpperCase()}</T>
          </View>
          <View style={{ flex: 1 }}>
            <T variant="h3">{user?.name}</T>
            <T muted variant="caption">{user?.email}</T>
          </View>
        </View>

        <View style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name={mode === 'dark' ? 'moon' : 'sunny'} size={20} color={colors.primary} />
          <T style={{ flex: 1 }}>Dark mode</T>
          <Switch testID="toggle-dark-mode" value={mode === 'dark'} onValueChange={toggle}
            trackColor={{ false: colors.border, true: colors.primary }} />
        </View>

        <TouchableOpacity testID="profile-logout" onPress={confirmAndSignOut}
          style={[styles.row, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="log-out-outline" size={20} color={colors.owing} />
          <T color={colors.owing} style={{ flex: 1, fontWeight: '700' }}>Sign out</T>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
});
