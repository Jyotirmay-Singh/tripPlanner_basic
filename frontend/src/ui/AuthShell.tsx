import React from 'react';
import { View, KeyboardAvoidingView, Platform, ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, CONTENT_MAX_WIDTH } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

type Props = {
  title: string;
  subtitle?: string;
  brandIcon?: IconName;
  children: React.ReactNode;
};

/**
 * Shared scaffold for the auth screens: a calm, centered "premium unlock" layout with the
 * brand medallion, title/subtitle, and a keyboard-aware scroll. Caps width on web/tablet.
 */
export default function AuthShell({ title, subtitle, brandIcon = 'plane', children }: Props) {
  const { colors } = useTheme();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.column}>
            <View style={[styles.brand, { backgroundColor: colors.primary }]}>
              <Icon name={brandIcon} size={28} color={colors.primaryText} strokeWidth={2} />
            </View>
            <T variant="h1" style={{ marginTop: SPACING.lg }}>{title}</T>
            {subtitle ? <T muted style={{ marginTop: SPACING.xs }}>{subtitle}</T> : null}
            <View style={{ marginTop: SPACING.xl, gap: SPACING.md }}>{children}</View>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: SPACING.lg, flexGrow: 1, justifyContent: 'center', alignItems: 'center' },
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH },
  brand: { width: 56, height: 56, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
});
