import React from 'react';
import { View, StyleSheet, Switch } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { useLogout } from '../../src/useLogout';
import { initials } from '../../src/initials';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import { Screen, Card, Icon } from '../../src/ui';

export default function Profile() {
  const { user } = useAuth();
  const { colors, mode, toggle } = useTheme();
  const { confirmAndSignOut } = useLogout();
  const router = useRouter();

  return (
    <Screen scroll={false}>
      <T variant="h1">Profile</T>

      <Card style={styles.row}>
        <View style={[styles.avatar, { backgroundColor: colors.primary }]}>
          <T color={colors.primaryText} variant="h2">{initials(user?.name) || '?'}</T>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <T variant="h3" numberOfLines={1}>{user?.name}</T>
          <T muted variant="caption" numberOfLines={1}>{user?.email}</T>
        </View>
      </Card>

      <Card style={styles.row}>
        <Icon name={mode === 'dark' ? 'moon' : 'sun'} size={20} color={colors.primary} />
        <T style={{ flex: 1 }}>Dark mode</T>
        <Switch
          testID="toggle-dark-mode"
          value={mode === 'dark'}
          onValueChange={toggle}
          trackColor={{ false: colors.border, true: colors.primary }}
          thumbColor={colors.surface}
        />
      </Card>

      <Card
        onPress={() => router.push('/change-password')}
        testID="profile-change-password"
        accessibilityLabel="Change password"
        style={styles.row}
      >
        <Icon name="lock" size={20} color={colors.primary} />
        <T style={{ flex: 1 }}>Change password</T>
        <Icon name="chevron-right" size={18} color={colors.textMuted} />
      </Card>

      <Card onPress={confirmAndSignOut} testID="profile-logout" accessibilityLabel="Sign out" style={styles.row}>
        <Icon name="logout" size={20} color={colors.danger} />
        <T color={colors.danger} style={{ flex: 1, fontWeight: '700' }}>Sign out</T>
        <Icon name="chevron-right" size={18} color={colors.textMuted} />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, borderRadius: RADIUS.lg },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
});
