import React, { useRef, useState } from 'react';
import { View, ScrollView, Pressable, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, PRESS_SCALE, FONTS, TYPESCALE } from '../theme';
import T from '../T';
import Button from './Button';
import { parseHHMM } from '../time';

type Props = {
  value: string;                    // 'HH:MM' (24h) or '' — seeds the wheels; blank => now
  onApply: (hhmm: string) => void;  // called with the chosen 'HH:MM' on Done
};

const ROW_H = 44;
const LIST_H = ROW_H * 4.5;         // ~4.5 rows visible per column
const pad = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/**
 * Themed 24-hour time picker (design-system, cross-platform). Two scrollable columns — hours 00–23
 * and minutes 00–59 — with the selected row FILLED (+ bold + accessibilityState, never color-alone).
 * Seeds from `value` (else the current wall-clock) so it never opens blank. "Now" snaps to the
 * current time; "Done" applies. All values are built from integers (no Date), so no UTC drift.
 */
export default function TimePicker({ value, onApply }: Props) {
  const { colors } = useTheme();
  const seed = parseHHMM(value) || (() => { const d = new Date(); return { h: d.getHours(), m: d.getMinutes() }; })();
  const [h, setH] = useState(seed.h);
  const [m, setM] = useState(seed.m);
  const hourRef = useRef<ScrollView>(null);
  const minRef = useRef<ScrollView>(null);

  // Center the seeded rows on open.
  const centerOffset = (index: number) => Math.max(0, index * ROW_H - LIST_H / 2 + ROW_H / 2);
  const onHourLayout = () => hourRef.current?.scrollTo({ y: centerOffset(seed.h), animated: false });
  const onMinLayout = () => minRef.current?.scrollTo({ y: centerOffset(seed.m), animated: false });

  const setNow = () => { const d = new Date(); setH(d.getHours()); setM(d.getMinutes()); };

  const column = (
    values: number[],
    selected: number,
    onPick: (n: number) => void,
    ref: React.RefObject<ScrollView | null>,
    onLayout: () => void,
    unit: string,
  ) => (
    <ScrollView
      ref={ref as any}
      onLayout={onLayout}
      style={[styles.list, { borderColor: colors.border }]}
      contentContainerStyle={{ paddingVertical: LIST_H / 2 - ROW_H / 2 }}
      showsVerticalScrollIndicator={false}
    >
      {values.map((n) => {
        const isSel = n === selected;
        return (
          <Pressable
            key={n}
            onPress={() => onPick(n)}
            accessibilityRole="button"
            accessibilityLabel={`${n} ${unit}`}
            accessibilityState={{ selected: isSel }}
            style={({ pressed, focused }: any) => [
              styles.row,
              isSel && { backgroundColor: colors.primary },
              pressed && { transform: [{ scale: PRESS_SCALE }] },
              focused && Platform.OS === 'web' && {
                outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: -2,
              } as any,
            ]}
          >
            <T
              style={[styles.rowText, isSel && { fontFamily: FONTS.bodyBold }]}
              color={isSel ? colors.primaryText : colors.textMain}
            >
              {pad(n)}
            </T>
          </Pressable>
        );
      })}
    </ScrollView>
  );

  return (
    <View>
      {/* Live 24-hour preview */}
      <T variant="h2" style={styles.preview}>{`${pad(h)}:${pad(m)}`}</T>

      <View style={styles.columns}>
        <View style={styles.col}>
          <T variant="caption" muted style={styles.colLabel}>Hour</T>
          {column(HOURS, h, setH, hourRef, onHourLayout, 'hours')}
        </View>
        <View style={styles.col}>
          <T variant="caption" muted style={styles.colLabel}>Minute</T>
          {column(MINUTES, m, setM, minRef, onMinLayout, 'minutes')}
        </View>
      </View>

      <View style={styles.actions}>
        <Button label="Now" variant="secondary" icon="clock" onPress={setNow} style={{ flex: 1 }} />
        <Button label="Done" icon="check" onPress={() => onApply(`${pad(h)}:${pad(m)}`)} style={{ flex: 1 }} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: { textAlign: 'center', marginBottom: SPACING.sm },
  columns: { flexDirection: 'row', gap: SPACING.md },
  col: { flex: 1 },
  colLabel: { textAlign: 'center', marginBottom: SPACING.xs },
  list: { height: LIST_H, borderWidth: 1, borderRadius: RADIUS.md },
  row: {
    height: ROW_H, marginHorizontal: SPACING.xs, borderRadius: RADIUS.sm,
    alignItems: 'center', justifyContent: 'center',
  },
  rowText: { fontFamily: FONTS.number, fontSize: TYPESCALE.lg },
  actions: { flexDirection: 'row', gap: SPACING.sm, marginTop: SPACING.md },
});
