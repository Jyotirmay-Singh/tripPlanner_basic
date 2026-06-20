import React, { useRef } from 'react';
import {
  Animated, Pressable, StyleSheet, ActivityIndicator, Platform,
  type ViewStyle, type StyleProp,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useTheme } from '../ThemeContext';
import { RADIUS, PRESS_SCALE, FONTS } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

const SIZES: Record<ButtonSize, { pv: number; ph: number; font: number; icon: number; gap: number }> = {
  sm: { pv: 8, ph: 14, font: 14, icon: 16, gap: 6 },
  md: { pv: 14, ph: 18, font: 16, icon: 18, gap: 8 },
  lg: { pv: 16, ph: 22, font: 16, icon: 20, gap: 8 },
};

type Props = {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: IconName;
  iconRight?: IconName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  haptic?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  accessibilityLabel?: string;
};

export default function Button({
  label, onPress, variant = 'primary', size = 'md', icon, iconRight,
  loading = false, disabled = false, fullWidth = false, haptic = true,
  style, testID, accessibilityLabel,
}: Props) {
  const { colors } = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const dim = SIZES[size];
  const isDisabled = disabled || loading;

  const palette = (): { bg: string; fg: string; border?: string } => {
    switch (variant) {
      case 'secondary': return { bg: colors.surface, fg: colors.textMain, border: colors.border };
      case 'ghost': return { bg: 'transparent', fg: colors.primary };
      case 'destructive': return { bg: colors.danger, fg: colors.primaryText };
      default: return { bg: colors.primary, fg: colors.primaryText };
    }
  };
  const { bg, fg, border } = palette();

  const animate = (to: number) =>
    Animated.spring(scale, { toValue: to, useNativeDriver: Platform.OS !== 'web', speed: 50, bounciness: 0 }).start();

  const press = () => {
    if (isDisabled) return;
    if (haptic && Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    onPress();
  };

  return (
    <Animated.View style={[fullWidth && { alignSelf: 'stretch' }, { transform: [{ scale }] }]}>
      <Pressable
        testID={testID}
        onPress={press}
        onPressIn={() => animate(PRESS_SCALE)}
        onPressOut={() => animate(1)}
        disabled={isDisabled}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel || label}
        accessibilityState={{ disabled: isDisabled, busy: loading }}
        style={({ pressed, hovered, focused }: any) => [
          styles.base,
          {
            backgroundColor: bg,
            borderColor: border ?? 'transparent',
            borderWidth: border ? 1 : 0,
            paddingVertical: dim.pv,
            paddingHorizontal: dim.ph,
            gap: dim.gap,
            opacity: isDisabled ? 0.5 : hovered && !pressed ? 0.92 : 1,
          },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2 } as any,
          style,
        ]}
      >
        {loading ? (
          <ActivityIndicator size="small" color={fg} />
        ) : (
          <>
            {icon ? <Icon name={icon} size={dim.icon} color={fg} /> : null}
            <T style={{ fontFamily: FONTS.bodyBold, fontSize: dim.font }} color={fg}>{label}</T>
            {iconRight ? <Icon name={iconRight} size={dim.icon} color={fg} /> : null}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: RADIUS.pill,
  },
});
