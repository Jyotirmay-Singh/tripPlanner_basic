import React from 'react';
import { View, Pressable, StyleSheet, Platform, type ViewStyle, type StyleProp } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS } from '../theme';

type Variant = 'default' | 'primary' | 'muted' | 'outline';
type Pad = 'sm' | 'md' | 'lg' | 'none';

const PAD: Record<Pad, number> = { none: 0, sm: SPACING.sm, md: SPACING.md, lg: SPACING.lg };

type Props = {
  children: React.ReactNode;
  variant?: Variant;
  padding?: Pad;
  radius?: number;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

/**
 * Standard surface. Flat 1px-bordered card per design_guidelines.json (no drop shadow).
 * `primary` is the dark-teal hero surface; `muted` uses surfaceMuted; `outline` is borderless
 * transparent with a border only. Becomes a Pressable when `onPress` is supplied.
 */
export default function Card({
  children, variant = 'default', padding = 'md', radius = RADIUS.lg, onPress, style, testID, accessibilityLabel,
}: Props) {
  const { colors } = useTheme();

  const bg =
    variant === 'primary' ? colors.primary :
    variant === 'muted' ? colors.surfaceMuted :
    variant === 'outline' ? 'transparent' : colors.surface;
  const showBorder = variant === 'default' || variant === 'outline';

  const base: ViewStyle = {
    backgroundColor: bg,
    borderRadius: radius,
    padding: PAD[padding],
    borderWidth: showBorder ? 1 : 0,
    borderColor: colors.border,
  };

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed, focused }: any) => [
          base,
          pressed && { opacity: 0.85 },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }
  return <View testID={testID} style={[base, style]}>{children}</View>;
}

export const cardStyles = StyleSheet.create({ row: { flexDirection: 'row', alignItems: 'center', gap: SPACING.md } });
