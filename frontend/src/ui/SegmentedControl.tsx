import React from 'react';
import { View, Pressable, ScrollView, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../ThemeContext';
import { RADIUS, FONTS } from '../theme';
import T from '../T';
import Icon, { IconName } from './Icon';

export type Segment<V extends string> = { value: V; label: string; icon?: IconName };

type Props<V extends string> = {
  segments: Segment<V>[];
  value: V;
  onChange: (v: V) => void;
  /** scroll horizontally when there are many segments (e.g. trip-detail tabs). */
  scrollable?: boolean;
  testIDPrefix?: string;
};

/**
 * Pill segmented control — the single implementation behind the member kind toggle
 * (individual/family), the split-mode selector, and the trip-detail tab bar. Track is a muted
 * rounded container; the active segment is a solid primary pill.
 */
export default function SegmentedControl<V extends string>({
  segments, value, onChange, scrollable, testIDPrefix,
}: Props<V>) {
  const { colors } = useTheme();

  const items = segments.map((s) => {
    const active = s.value === value;
    return (
      <Pressable
        key={s.value}
        testID={testIDPrefix ? `${testIDPrefix}-${s.value}` : undefined}
        onPress={() => onChange(s.value)}
        accessibilityRole="tab"
        accessibilityState={{ selected: active }}
        style={({ focused }: any) => [
          styles.segment,
          !scrollable && { flex: 1 },
          { backgroundColor: active ? colors.primary : 'transparent' },
          focused && Platform.OS === 'web' && { outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid' } as any,
        ]}
      >
        {s.icon ? <Icon name={s.icon} size={15} color={active ? colors.primaryText : colors.textMuted} /> : null}
        <T
          variant="caption"
          style={{ fontFamily: FONTS.bodySemibold }}
          color={active ? colors.primaryText : colors.textMuted}
        >
          {s.label}
        </T>
      </Pressable>
    );
  });

  const track = (
    <View style={[styles.track, { backgroundColor: colors.surfaceMuted, borderColor: colors.border }, scrollable ? { flexDirection: 'row', gap: 4 } : null]}>
      {items}
    </View>
  );

  if (scrollable) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ flexGrow: 0 }}>
        {track}
      </ScrollView>
    );
  }
  return track;
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    padding: 4,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    gap: 4,
  },
  segment: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 9, paddingHorizontal: 14,
    borderRadius: RADIUS.pill,
  },
});
