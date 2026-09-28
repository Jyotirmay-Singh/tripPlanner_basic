import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet, Platform, type DimensionValue } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS } from '../theme';

type BoxProps = { width?: DimensionValue; height?: number; radius?: number; style?: any };

/** A single shimmering placeholder block. */
export function SkeletonBox({ width = '100%', height = 16, radius = RADIUS.sm, style }: BoxProps) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(opacity, { toValue: 0.5, duration: 700, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);
  return <Animated.View style={[{ width, height, borderRadius: radius, backgroundColor: colors.surfaceMuted, opacity }, style]} />;
}

/** A skeleton placeholder shaped like a ListRow / Card, repeated `count` times. */
export function SkeletonCard({ count = 3 }: { count?: number }) {
  const { colors } = useTheme();
  return (
    <View style={{ gap: SPACING.md }}>
      {Array.from({ length: count }).map((_, i) => (
        <View key={i} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <SkeletonBox width={40} height={40} radius={20} />
          <View style={{ flex: 1, gap: SPACING.sm }}>
            <SkeletonBox width="60%" height={14} />
            <SkeletonBox width="40%" height={12} />
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row', alignItems: 'center', gap: SPACING.md,
    padding: SPACING.md, borderRadius: RADIUS.lg, borderWidth: 1,
  },
});
