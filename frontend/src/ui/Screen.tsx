import React from 'react';
import { ScrollView, View, RefreshControl, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { SafeAreaView, type Edge } from 'react-native-safe-area-context';
import { useTheme } from '../ThemeContext';
import { SPACING, CONTENT_MAX_WIDTH } from '../theme';

export type ScreenProps = {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  gap?: number;
  testID?: string;
  fab?: React.ReactNode;
  bottomContentInset?: number;
};

/**
 * Standard screen shell: a full themed background, explicit safe edges, standard gutter, and a
 * centered max-width column. Navigator clearance is supplied by the navigator-specific wrapper.
 */
export default function Screen({
  children, scroll = true, refreshing, onRefresh, edges = ['top', 'left', 'right'], contentStyle,
  gap = SPACING.md, testID, fab, bottomContentInset = 0,
}: ScreenProps) {
  const { colors } = useTheme();

  const inner = (
    <View style={[styles.column, { gap }, contentStyle]}>{children}</View>
  );

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.background }} edges={edges} testID={testID}>
      {scroll ? (
        <ScrollView
          contentContainerStyle={{
            padding: SPACING.lg,
            paddingBottom: SPACING.lg + bottomContentInset,
            alignItems: 'center',
          }}
          keyboardShouldPersistTaps="handled"
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
        >
          {inner}
        </ScrollView>
      ) : (
        <View style={{
          flex: 1,
          padding: SPACING.lg,
          paddingBottom: SPACING.lg + bottomContentInset,
          alignItems: 'center',
        }}>{inner}</View>
      )}
      {/* Floating overlay (e.g. a FAB): sibling of the scroll content so it stays fixed while scrolling. */}
      {fab}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  column: { width: '100%', maxWidth: CONTENT_MAX_WIDTH },
});
