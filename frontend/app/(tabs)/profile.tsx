import React, { useCallback } from 'react';
import { Platform, Pressable, View, StyleSheet, Switch } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useFocusEffect, useRouter } from 'expo-router';
import { useAuth } from '../../src/AuthContext';
import { useTheme } from '../../src/ThemeContext';
import { useLogout } from '../../src/useLogout';
import { initials } from '../../src/initials';
import { SPACING, RADIUS } from '../../src/theme';
import T from '../../src/T';
import TabPageHeader from '../../src/TabPageHeader';
import { TabScreen, Card, Icon, IconButton, useToast } from '../../src/ui';
import NotificationSettingsRow from '../../src/NotificationSettingsRow';
import { upiProfileHref } from '../../src/inviteNavigation';

export default function Profile() {
  const { user, refreshUserProfile } = useAuth();
  const { colors, mode, toggle } = useTheme();
  const { confirmAndSignOut } = useLogout();
  const { show: showToast } = useToast();
  const router = useRouter();

  useFocusEffect(useCallback(() => {
    void refreshUserProfile().catch(() => {});
  }, [refreshUserProfile]));

  const copyUpiId = useCallback(async () => {
    if (!user?.upi_id) return;
    try {
      const copied = await Clipboard.setStringAsync(user.upi_id);
      if (!copied) {
        showToast('Could not copy UPI ID. Try again.', 'error');
        return;
      }
      showToast('UPI ID copied', 'success');
    } catch {
      showToast('Could not copy UPI ID. Try again.', 'error');
    }
  }, [showToast, user?.upi_id]);

  return (
    <TabScreen>
      <TabPageHeader title="Profile" />

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

      <Card padding="none" style={styles.paymentRow}>
        <Pressable
          onPress={() => router.push(upiProfileHref())}
          testID="profile-payment-details"
          accessibilityRole="button"
          accessibilityLabel={`Payment details, ${user?.upi_id || 'UPI ID not set'}`}
          style={({ pressed, focused }: any) => [
            styles.paymentLink,
            pressed && styles.pressed,
            focused && Platform.OS === 'web' && {
              outlineWidth: 2,
              outlineColor: colors.primary,
              outlineStyle: 'solid',
              outlineOffset: 2,
            } as any,
          ]}
        >
          <Icon name="wallet" size={20} color={colors.primary} />
          <View style={styles.paymentCopy}>
            <T variant="h4">Payment details</T>
            <T muted variant="caption" numberOfLines={1} testID="profile-upi-value">
              {user?.upi_id || 'UPI ID not set'}
            </T>
          </View>
          <Icon name="chevron-right" size={18} color={colors.textMuted} />
        </Pressable>
        {user?.upi_id ? (
          <IconButton
            name="copy"
            onPress={copyUpiId}
            accessibilityLabel="Copy UPI ID"
            testID="profile-copy-upi"
            touchSize={44}
            color={colors.primary}
            style={styles.copyButton}
          />
        ) : null}
      </Card>

      <NotificationSettingsRow />

      <Card onPress={confirmAndSignOut} testID="profile-logout" accessibilityLabel="Sign out" style={styles.row}>
        <Icon name="logout" size={20} color={colors.danger} />
        <T color={colors.danger} style={{ flex: 1, fontWeight: '700' }}>Sign out</T>
        <Icon name="chevron-right" size={18} color={colors.textMuted} />
      </Card>
    </TabScreen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md, borderRadius: RADIUS.lg },
  avatar: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  paymentCopy: { flex: 1, minWidth: 0 },
  paymentRow: { flexDirection: 'row', alignItems: 'center', borderRadius: RADIUS.lg },
  paymentLink: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    padding: SPACING.md,
  },
  pressed: { opacity: 0.85 },
  copyButton: { marginRight: SPACING.xs },
});
