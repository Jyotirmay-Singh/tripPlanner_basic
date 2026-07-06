import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Platform, type ViewStyle, type StyleProp } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeContext';
import { RADIUS, PRESS_SCALE, SPACING, SHADOW } from '../theme';
import Icon, { IconName } from './Icon';

const SIZE = 56; // circular touch target, comfortably above the 44px minimum

type Props = {
  icon: IconName;
  onPress: () => void;
  accessibilityLabel: string; // required — icon-only control must be labelled
  testID?: string;
  style?: StyleProp<ViewStyle>;
};

/**
 * Floating action button: a circular primary-filled button pinned bottom-right, offset to clear the
 * translucent floating tab bar. Rendered as a sibling of the scroll content (see Screen's `fab` prop),
 * so it stays put while the screen scrolls. Mirrors the IconButton press-scale + haptics + web focus.
 */
export default function Fab({ icon, onPress, accessibilityLabel, testID, style }: Props) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const animate = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== 'web', speed: 50, bounciness: 0 }).start();

  return (
    <Animated.View style={[styles.wrap, { transform: [{ scale }] }]} pointerEvents="box-none">
      <Pressable
        testID={testID}
        onPress={() => { if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {}); onPress(); }}
        onPressIn={() => animate(PRESS_SCALE)}
        onPressOut={() => animate(1)}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ focused }: any) => [
          styles.base,
          { backgroundColor: colors.primary },
          SHADOW.sheet,
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
          style,
        ]}
      >
        <Icon name={icon} size={26} color={colors.primaryText} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: SPACING.lg,
    bottom: Platform.OS === 'ios' ? 104 : 84, // clears the floating tab bar (height + gutter)
  },
  base: {
    width: SIZE, height: SIZE, borderRadius: RADIUS.pill,
    alignItems: 'center', justifyContent: 'center',
  },
});
