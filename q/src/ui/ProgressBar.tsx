import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { RADIUS } from '../theme';

type Props = {
  /** 0..1 (clamped visually). Values above 1 retain the danger state. */
  progress: number;
  color?: string;
  trackColor?: string;
  height?: number;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityValueText?: string;
};

/** Slim rounded progress track — budget usage etc. Bar turns to `danger` when over budget. */
export default function ProgressBar({
  progress,
  color,
  trackColor,
  height = 8,
  testID,
  accessibilityLabel,
  accessibilityValueText,
}: Props) {
  const { colors } = useTheme();
  // NaN is invalid and becomes zero. Infinities still clamp in the meaningful direction, so an
  // extremely large positive ratio is a full danger bar rather than an empty one.
  const normalized = Number.isNaN(progress) ? 0 : progress;
  const clamped = Math.max(0, Math.min(1, normalized));
  const over = normalized > 1;
  return (
    <View
      testID={testID}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{
        min: 0,
        max: 100,
        now: Math.round(clamped * 100),
        ...(accessibilityValueText ? { text: accessibilityValueText } : {}),
      }}
      style={[styles.track, { backgroundColor: trackColor ?? colors.surfaceMuted, height, borderRadius: height / 2 }]}
    >
      <View
        style={{
          width: `${clamped * 100}%`,
          height,
          borderRadius: height / 2,
          backgroundColor: color ?? (over ? colors.danger : colors.primary),
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: { width: '100%', overflow: 'hidden', borderRadius: RADIUS.pill },
});
