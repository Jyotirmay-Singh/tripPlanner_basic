import React from 'react';
import { View, StyleSheet } from 'react-native';
import { useTheme } from '../ThemeContext';
import { RADIUS } from '../theme';

type Props = {
  /** 0..1 (clamped). */
  progress: number;
  color?: string;
  trackColor?: string;
  height?: number;
};

/** Slim rounded progress track — budget usage etc. Bar turns to `danger` when over budget. */
export default function ProgressBar({ progress, color, trackColor, height = 8 }: Props) {
  const { colors } = useTheme();
  const clamped = Math.max(0, Math.min(1, Number.isFinite(progress) ? progress : 0));
  const over = progress > 1;
  return (
    <View style={[styles.track, { backgroundColor: trackColor ?? colors.surfaceMuted, height, borderRadius: height / 2 }]}>
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
