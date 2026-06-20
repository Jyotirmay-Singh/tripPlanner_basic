import React, { useRef } from 'react';
import { Animated, Pressable, StyleSheet, Platform, type ViewStyle, type StyleProp } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeContext';
import { RADIUS, PRESS_SCALE } from '../theme';
import Icon, { IconName } from './Icon';

type Variant = 'plain' | 'surface' | 'primary' | 'danger';

type Props = {
  name: IconName;
  onPress: () => void;
  accessibilityLabel: string; // required — icon-only buttons must be labelled
  variant?: Variant;
  size?: number; // icon size
  color?: string;
  testID?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
};

const HIT = 44; // min touch target

export default function IconButton({
  name, onPress, accessibilityLabel, variant = 'plain', size = 22, color,
  testID, disabled, style,
}: Props) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;

  const bg =
    variant === 'surface' ? colors.surfaceMuted :
    variant === 'primary' ? colors.primary :
    variant === 'danger' ? colors.surfaceMuted : 'transparent';
  const fg =
    color ?? (variant === 'primary' ? colors.primaryText : variant === 'danger' ? colors.danger : colors.textMain);

  const animate = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== 'web', speed: 50, bounciness: 0 }).start();

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Pressable
        testID={testID}
        onPress={() => { if (!disabled) { if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {}); onPress(); } }}
        onPressIn={() => animate(PRESS_SCALE)}
        onPressOut={() => animate(1)}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        hitSlop={8}
        style={({ focused }: any) => [
          styles.base,
          { backgroundColor: bg, opacity: disabled ? 0.4 : 1 },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
          style,
        ]}
      >
        <Icon name={name} size={size} color={fg} />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    width: HIT, height: HIT, borderRadius: RADIUS.pill,
    alignItems: 'center', justifyContent: 'center',
  },
});
