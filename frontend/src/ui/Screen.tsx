import React from 'react';
import { ScrollView, View, RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, LAYOUT, CONTENT_MAX_WIDTH } from '../theme';

type Props = {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  gap?: number;
  testID?: string;
};

/**
 * Standard screen shell: themed safe area + (optional) scroll, the standard 24px gutter,
 * tab-bar bottom clearance, and a centered max-width column on wide (web/tablet) viewports so
 * content never stretches edge-to-edge on desktop.
 */
export default function Screen({
  children, scroll = true, refreshing, onRefresh, edges = ['top'], contentStyle, gap = SPACING.md, testID,
}: Props) {
  const { colors } = useTheme();

  const inner = (
    <View style={[styles.column, { gap }, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={edges} testID={testID}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{ padding: SPACING.lg, paddingBottom: LAYOUT.scrollBottomInset, alignItems: 'center' }}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
        >
          {inner}
        </ScrollView>
      ) : (
        <View style={{ flex: 1, padding: SPACING.lg, alignItems: 'center' }}>{inner}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH },
});
