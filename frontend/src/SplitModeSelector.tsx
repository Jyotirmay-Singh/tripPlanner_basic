import React from 'react';
import { View, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ThemeContext';
import { SPACING, RADIUS } from './theme';
import T from './T';

export type SplitMode = 'PER_CAPITA' | 'PER_FAMILY';

const OPTIONS: { mode: SplitMode; label: string; icon: keyof typeof Ionicons.glyphMap; testID: string }[] = [
  { mode: 'PER_CAPITA', label: 'Per Person', icon: 'person-outline', testID: 'split-mode-per_capita' },
  { mode: 'PER_FAMILY', label: 'Per Family', icon: 'people-outline', testID: 'split-mode-per_family' },
];

type Props = {
  value: SplitMode;
  onChange: (mode: SplitMode) => void;
  subLabel?: string;
};

/**
 * Segmented control for an expense's split mode (CLAUDE.md §5).
 * Visual style mirrors the existing "kind" toggle pills in the transaction screens.
 */
export default function SplitModeSelector({ value, onChange, subLabel }: Props) {
  const { colors } = useTheme();
  return (
    <View>
      <T variant="label" muted>Split mode</T>
      <View style={{ flexDirection: 'row', gap: SPACING.sm, marginTop: 4 }}>
        {OPTIONS.map((o) => {
          const active = value === o.mode;
          return (
            <TouchableOpacity
              key={o.mode}
              testID={o.testID}
              onPress={() => onChange(o.mode)}
              style={[
                styles.pill,
                {
                  backgroundColor: active ? colors.primary : colors.surfaceMuted,
                  borderColor: active ? colors.primary : colors.border,
                },
              ]}
            >
              <Ionicons name={o.icon} size={16} color={active ? colors.primaryText : colors.textMain} />
              <T style={{ fontWeight: '700' }} color={active ? colors.primaryText : colors.textMain}>
                {o.label}
              </T>
            </TouchableOpacity>
          );
        })}
      </View>
      {subLabel ? (
        <T testID="split-mode-preview" variant="caption" muted style={{ marginTop: 6 }}>{subLabel}</T>
      ) : null}
    </View>
  );
}

type PreviewMember = { id: string; kind: string; family_members: string[] };

/**
 * Pure preview of how an expense splits under the active mode. This is a
 * display-only estimate — the authoritative split is computed server-side in
 * services/calculator.py. Mirrors resolve_weights/split_per_capita/split_per_family.
 */
export function splitPreviewLabel(opts: {
  amount: number;
  mode: SplitMode;
  members: PreviewMember[];
  splitSel: string[];
  weightOverrides: Record<string, number>;
  currency: string;
}): string {
  const { amount, mode, members, splitSel, weightOverrides, currency } = opts;
  const HINT = "Enter an amount and pick who's splitting";
  if (!Number.isFinite(amount) || amount <= 0 || splitSel.length === 0) return HINT;

  if (mode === 'PER_FAMILY') {
    // §5B: divide equally across entities; family size is ignored.
    const E = splitSel.length;
    const per = amount / E;
    return `${currency} ${per.toFixed(2)} per group`;
  }

  // §5A: divide across total humans (individual = 1, family = override ?? size).
  let H = 0;
  for (const sid of splitSel) {
    const m = members.find((x) => x.id === sid);
    if (m && m.kind === 'family') {
      const fullSize = Math.max(1, (m.family_members || []).length);
      H += weightOverrides[sid] ?? fullSize;
    } else {
      H += 1; // individuals, and unknown/stale ids, weigh 1 (matches backend)
    }
  }
  if (H <= 0) return HINT;
  const per = amount / H;
  return `${currency} ${per.toFixed(2)} per person`;
}

const styles = StyleSheet.create({
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
  },
});
