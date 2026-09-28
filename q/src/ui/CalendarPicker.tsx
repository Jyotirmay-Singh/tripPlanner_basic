import React, { useMemo, useRef, useState } from 'react';
import { View, Pressable, StyleSheet, Platform } from 'react-native';
import { useTheme } from '../ThemeContext';
import { SPACING, RADIUS, PRESS_SCALE, FONTS, TYPESCALE } from '../theme';
import T from '../T';
import IconButton from './IconButton';
import Button from './Button';
import { parseISO, partsToISO, todayISO } from '../date';
import {
  WEEKDAYS_SHORT, MONTHS, monthMatrix, addMonths, isBeforeISO,
} from '../calendar';

type Props = {
  valueISO?: string | null;      // currently-selected calendar date ('YYYY-MM-DD') or none
  minISO?: string | null;        // lower bound; days before this are disabled (used by the End field)
  onSelect: (iso: string) => void;
};

/**
 * Themed month-grid date picker (design-system, cross-platform). Renders inside a Sheet. Today is
 * OUTLINED, the selected day is FILLED, out-of-range days are dimmed + non-pressable — no state is
 * conveyed by color alone (outline vs fill vs opacity + accessibilityState). Tapping a day applies
 * and closes; the ‹ › chevrons page months without closing. Seeds the visible month + highlight from
 * `valueISO` (else today) so it never opens blank.
 */
export default function CalendarPicker({ valueISO, minISO, onSelect }: Props) {
  const { colors } = useTheme();
  const today = todayISO();
  const seed = useMemo(() => parseISO(valueISO || '') || parseISO(today)!, [valueISO, today]);
  const [view, setView] = useState({ year: seed.y, month: seed.m });
  const cellRefs = useRef<Record<string, any>>({});

  const weeks = useMemo(() => monthMatrix(view.year, view.month), [view]);

  // Disable paging to a month that lies entirely before minISO.
  const prev = addMonths(view.year, view.month, -1);
  const prevLastDay = partsToISO({ y: prev.year, m: prev.month, d: new Date(prev.year, prev.month, 0).getDate() });
  const prevDisabled = !!minISO && isBeforeISO(prevLastDay, minISO);
  const todayDisabled = !!minISO && isBeforeISO(today, minISO);

  const go = (delta: number) => setView((v) => addMonths(v.year, v.month, delta));

  // Web-only: arrow keys move focus between days within the visible month (chevrons change month).
  const onCellKey = (e: any, iso: string) => {
    const deltas: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 7, ArrowUp: -7 };
    const delta = deltas[e?.key];
    if (delta === undefined) return;
    e.preventDefault?.();
    const p = parseISO(iso);
    if (!p) return;
    const targetIso = partsToISO({ y: p.y, m: p.m, d: p.d + delta });
    cellRefs.current[targetIso]?.focus?.();
  };

  return (
    <View>
      {/* Month navigation */}
      <View style={styles.header}>
        <IconButton
          name="chevron-left" variant="surface" onPress={() => go(-1)}
          disabled={prevDisabled} accessibilityLabel="Previous month"
        />
        <T variant="h4">{`${MONTHS[view.month - 1]} ${view.year}`}</T>
        <IconButton
          name="chevron-right" variant="surface" onPress={() => go(1)}
          accessibilityLabel="Next month"
        />
      </View>

      {/* Weekday header */}
      <View style={styles.week}>
        {WEEKDAYS_SHORT.map((w) => (
          <View key={w} style={styles.cell}>
            <T variant="caption" muted style={styles.weekdayText}>{w}</T>
          </View>
        ))}
      </View>

      {/* Day grid */}
      {weeks.map((row, wi) => (
        <View key={wi} style={styles.week}>
          {row.map((cell, ci) => {
            if (!cell) return <View key={ci} style={styles.cell} />;
            const isSelected = !!valueISO && cell.iso === valueISO;
            const isToday = cell.iso === today;
            const isDisabled = !!minISO && isBeforeISO(cell.iso, minISO);
            const label =
              `${cell.day} ${MONTHS[view.month - 1]} ${view.year}` +
              (isToday ? ', today' : '') + (isSelected ? ', selected' : '');
            const webKey = Platform.OS === 'web' ? { onKeyDown: (e: any) => onCellKey(e, cell.iso) } : {};
            return (
              <View key={ci} style={styles.cell}>
                <Pressable
                  ref={(r) => { cellRefs.current[cell.iso] = r; }}
                  onPress={() => onSelect(cell.iso)}
                  disabled={isDisabled}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityState={{ selected: isSelected, disabled: isDisabled }}
                  {...(webKey as any)}
                  style={({ pressed, focused }: any) => [
                    styles.day,
                    isSelected && { backgroundColor: colors.primary },
                    !isSelected && isToday && { borderWidth: 1.5, borderColor: colors.primary },
                    isDisabled && { opacity: 0.32 },
                    pressed && !isDisabled && { transform: [{ scale: PRESS_SCALE }] },
                    focused && Platform.OS === 'web' && {
                      outlineWidth: 2, outlineColor: colors.primary, outlineStyle: 'solid', outlineOffset: 2,
                    } as any,
                  ]}
                >
                  <T
                    style={[styles.dayText, isSelected && { fontFamily: FONTS.bodyBold }]}
                    color={isSelected ? colors.primaryText : colors.textMain}
                  >
                    {cell.day}
                  </T>
                </Pressable>
              </View>
            );
          })}
        </View>
      ))}

      {/* Jump to today */}
      <Button
        label="Today" variant="ghost" icon="calendar" size="sm"
        onPress={() => onSelect(today)} disabled={todayDisabled}
        style={{ alignSelf: 'center', marginTop: SPACING.sm }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  week: { flexDirection: 'row' },
  cell: { flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center', padding: 2 },
  weekdayText: { textAlign: 'center' },
  day: {
    width: '100%', height: '100%', maxWidth: 48, maxHeight: 48,
    alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.md,
  },
  dayText: { fontFamily: FONTS.body, fontSize: TYPESCALE.md },
});
